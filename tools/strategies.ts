/**
 * Pre-built simulation strategies for balance testing.
 * Each strategy implements decision-making logic for worker assignment,
 * building priorities, and battle timing.
 */

import { CivilizationState } from "../src/game/civilizationState.js";
import { ExpNumber } from "../src/game/expNumber.js";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingKey,
} from "../src/game/buildings.js";
import { encounterDefinitions } from "../src/game/encounters.js";
import { researchDefinitions } from "../src/game/research.js";
import { type ArmyStack } from "../src/game/battle.js";
import {
  simulatorCandidates,
  solveMinimumArmy,
  type BattleSimulatorContext,
  type SimulatorOwnedArmy,
  type SimulatorResult,
} from "../src/game/battleSimulator.js";
import {
  type SimulationStrategy,
  type SimulationAction,
  type SimulationContext,
  type MilestoneEvent,
  isResourceGatherable,
} from "./simulation.js";
import { upgradeDefinitions } from "../src/game/upgrades.js";
import {
  producerResourceKeys,
  type ProductionResourceKey,
} from "../src/game/attributes.js";
import {
  isBuyableUnit,
  unitDefinitions,
  type UnitDefinition,
} from "../src/game/units.js";
import { getBestRoiAction, type BattleRoiPlan } from "./roi.js";
import {
  getTradeRouteAction,
  tradeProfile,
  type TradeProfile,
} from "./tradeAdvisor.js";
import { TRADE_INTENSITY_STOPS } from "../src/game/trade.js";

/**
 * Worker assignment ratios for different strategies.
 */
type WorkerRatios = {
  food: number;
  wood: number;
  stone: number;
  gold: number;
  military: number;
  science: number;
  metalwork: number;
  trade: number;
};

/**
 * Building priority lists for different strategies.
 */
type BuildingPriority = {
  building: BuildingKey;
  weight: number;
  targetCount?: number;
}[];

/** Simulation-only research routes; the live engine has no recommendation field. */
const simulationResearchHints: Readonly<Record<string, readonly string[]>> = {
  age0_3_bronze_raid: ["sling_throwing", "writing"],
};

/**
 * The first unwon encounter in the current age. Encounter order is the
 * progression data; this helper only exposes it to simulation strategies.
 */
export const getRequiredBattle = (state: CivilizationState) =>
  state.getNextBattle();

/**
 * Buyable player units named directly by the next encounter. Encounter data is
 * the source of truth; the strategy does not maintain a parallel battle table.
 */
export const getRequiredBattleUnitTargets = (
  state: CivilizationState,
): UnitDefinition[] => {
  const battle = getRequiredBattle(state);
  if (!battle) return [];
  const enemyUnitIds = new Set(battle.enemyArmy.map(({ unitId }) => unitId));
  const directDefinitions = unitDefinitions.filter(
    (unit) =>
      isBuyableUnit(unit) &&
      unit.age === battle.age &&
      enemyUnitIds.has(unit.key),
  );
  if (directDefinitions.length > 0) {
    return directDefinitions.filter((unit) => !state.isUnitAvailable(unit.key));
  }

  // Beast-only encounters have no buyable player counterpart in the data.
  // Pick the lowest locked unit in the encounter's domain instead of adding
  // a second encounter-specific unit table to the simulation.
  const enemyDomains = new Set(
    battle.enemyArmy
      .map(
        ({ unitId }) =>
          unitDefinitions.find(({ key }) => key === unitId)?.domain,
      )
      .filter(
        (domain): domain is UnitDefinition["domain"] => domain !== undefined,
      ),
  );
  return unitDefinitions
    .filter(
      (unit) =>
        isBuyableUnit(unit) &&
        unit.age === battle.age &&
        !state.isUnitAvailable(unit.key) &&
        enemyDomains.has(unit.domain),
    )
    .sort((left, right) => left.tier - right.tier)
    .slice(0, 1);
};

const researchLeadsToUnit = (
  researchId: string,
  unitId: string,
  visited = new Set<string>(),
): boolean => {
  if (visited.has(researchId)) return false;
  visited.add(researchId);
  const research = researchDefinitions.find(({ key }) => key === researchId);
  if (!research) return false;
  if (research.unlocks.includes(unitId)) return true;
  return researchDefinitions.some(
    (candidate) =>
      candidate.prerequisites.includes(researchId) &&
      researchLeadsToUnit(candidate.key, unitId, new Set(visited)),
  );
};

const prerequisiteOrder = (
  researchId: string,
  seen = new Set<string>(),
): string[] => {
  if (seen.has(researchId)) return [];
  const research = researchDefinitions.find(({ key }) => key === researchId);
  if (!research) return [];
  seen.add(researchId);
  return [
    ...research.prerequisites.flatMap((prerequisite) =>
      prerequisiteOrder(prerequisite, seen),
    ),
    researchId,
  ];
};

const getRecommendedResearchOrder = (
  state: CivilizationState,
): readonly string[] => {
  const currentBattle = getRequiredBattle(state);
  if (!currentBattle) return [];
  const hintedBattle = encounterDefinitions.find(
    (battle) =>
      battle.age === currentBattle.age &&
      !state.defeatedEncounters.includes(battle.key) &&
      (simulationResearchHints[battle.key]?.length ?? 0) > 0,
  );
  const recommended = hintedBattle
    ? simulationResearchHints[hintedBattle.key]
    : [];
  return [
    ...new Set(
      recommended.flatMap((researchId) => prerequisiteOrder(researchId)),
    ),
  ];
};

/** The next purchase on the current battle's authored research hint. */
export const getRequiredResearchAction = (
  state: CivilizationState,
): SimulationAction | null => {
  const recommended = getRecommendedResearchOrder(state);
  if (recommended.length > 0) {
    const next = recommended.find(
      (researchId) => !state.isResearchBought(researchId),
    );
    if (!next) return null;
    return state.canBuyResearch(next)
      ? { type: "buyResearch", researchId: next }
      : null;
  }

  const targetUnits = getRequiredBattleUnitTargets(state);
  if (targetUnits.length === 0) return null;
  const research = researchDefinitions.find(
    ({ key }) =>
      !state.isResearchBought(key) &&
      state.canBuyResearch(key) &&
      targetUnits.some((unit) => researchLeadsToUnit(key, unit.key)),
  );
  return research ? { type: "buyResearch", researchId: research.key } : null;
};

/** How well a buyable unit matches the next encounter's enemy force. */
const battleUnitMatchScore = (
  unit: UnitDefinition,
  battle: ReturnType<typeof getRequiredBattle>,
): number => {
  if (!battle) return 0;
  const enemyUnits = battle.enemyArmy
    .map(({ unitId }) => unitDefinitions.find(({ key }) => key === unitId))
    .filter((enemy): enemy is UnitDefinition => enemy !== undefined);
  return enemyUnits.reduce((score, enemy) => {
    let next = score;
    if (unit.key === enemy.key) next = Math.max(next, 3);
    if (unit.domain === enemy.domain) next = Math.max(next, 2);
    if (unit.tags.some((tag) => enemy.tags.includes(tag))) {
      next = Math.max(next, 1);
    }
    if (unit.bonusVs.some((tag) => enemy.tags.includes(tag))) {
      next = Math.max(next, 1);
    }
    return next;
  }, 0);
};

const getBattleUnitCandidates = (
  state: CivilizationState,
): UnitDefinition[] => {
  const battle = getRequiredBattle(state);
  if (!battle) return [];
  return state
    .getRosterUnits()
    .map((unit) => ({ unit, score: battleUnitMatchScore(unit, battle) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.unit.tier - left.unit.tier,
    )
    .map(({ unit }) => unit);
};

const getRequiredBattleResourceToGather = (
  state: CivilizationState,
): ProductionResourceKey | null => {
  const unit = getBattleUnitCandidates(state)[0];
  if (!unit) return null;
  const missing = state
    .getUnitCost(unit.key, 1)
    .filter(({ resource }) => isResourceGatherable(state, resource))
    .filter(({ resource, base }) => state.resources[resource].lt(base))
    .sort((left, right) => {
      const leftDeficit = left.base.sub(state.resources[left.resource]);
      const rightDeficit = right.base.sub(state.resources[right.resource]);
      return rightDeficit.gt(leftDeficit)
        ? -1
        : leftDeficit.gt(rightDeficit)
          ? 1
          : 0;
    });
  const resource = missing[0]?.resource;
  if (
    !resource ||
    !producerResourceKeys.includes(resource as ProductionResourceKey)
  ) {
    return null;
  }
  return resource as ProductionResourceKey;
};

const battleOutcomeCache = new Map<string, boolean>();
const battleOutcomeCacheLimit = 256;
const unitCountSignatureCache = new WeakMap<
  Record<string, ExpNumber>,
  string
>();

const unitCountSignature = (state: CivilizationState): string => {
  const cached = unitCountSignatureCache.get(state.unitCounts);
  if (cached !== undefined) return cached;
  const signature = Object.entries(state.unitCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unitId, count]) => `${unitId}:${count.toString()}`)
    .join(",");
  unitCountSignatureCache.set(state.unitCounts, signature);
  return signature;
};

const battleOutcomeKey = (state: CivilizationState, battleId: string): string =>
  [
    battleId,
    unitCountSignature(state),
    state.boughtResearch.join(","),
    state.boughtUpgrades.join(","),
    state.earnedAchievements.join(","),
    state.defeatedEncounters.join(","),
    state.enteredAges.join(","),
  ].join("|");

const canWinRequiredBattle = (
  state: CivilizationState,
  battleId: string,
): boolean => {
  const key = battleOutcomeKey(state, battleId);
  const cached = battleOutcomeCache.get(key);
  if (cached !== undefined) return cached;

  const canWin = state.simulateEncounterOutcome(battleId) === "player";
  if (battleOutcomeCache.size >= battleOutcomeCacheLimit) {
    const oldest = battleOutcomeCache.keys().next().value;
    if (oldest !== undefined) battleOutcomeCache.delete(oldest);
  }
  battleOutcomeCache.set(key, canWin);
  return canWin;
};

/** Launch the required battle when the current army can win it. */
export const getRequiredBattleAction = (
  state: CivilizationState,
): SimulationAction | null => {
  const nextBattle = getRequiredBattle(state);
  if (!nextBattle) return null;
  if (!canWinRequiredBattle(state, nextBattle.key)) return null;
  return { type: "launchBattle", encounterId: nextBattle.key };
};

/** Advanced production buildings that support the current battle chain. */
const requiredBattleBuildings: readonly BuildingKey[] = [
  "barracks",
  "university",
  "smithy",
];

/**
 * The mandatory route through the first age, in the order the campaign requires.
 *
 * Each battle's victory bonus raises the population cap, so the order is not a
 * preference — it is the only path that works:
 *
 *   1. ramp to 90 people, which unlocks the barracks
 *   2. win the first battle, which raises the cap
 *   3. ramp to ~200 people
 *   4. win the second battle, which raises the cap again
 *   5. raise a university and put the science to work
 *   6. win the remaining battles and ramp to ~1000 people, in either order
 *   7. enter the next age
 *
 * Strategies used to interleave these freely and stall: they spent on a
 * hand-ordered priority list while the step that actually unblocked progress was
 * unaffordable. This returns the next *growth* step whenever the route says
 * population is the thing being waited on, so the ladder cannot wander.
 */
const ageZeroRouteTargets: readonly {
  readonly afterBattle: number;
  readonly pop: number;
}[] = [
  { afterBattle: 0, pop: 90 },
  { afterBattle: 1, pop: 200 },
  { afterBattle: 4, pop: 1000 },
];

/** The population the route is currently working toward, or 0 when none. */
export const getAgeRouteTargetPopulation = (
  state: CivilizationState,
): number => {
  if (state.enteredAges.includes("age0")) {
    return state.population.lt(ExpNumber.fromNumber(1000)) ? 1000 : 0;
  }
  if (state.enteredAges.length > 0) return 0;
  const battlesWon = state.defeatedEncounters.filter((id) =>
    encounterDefinitions.some(
      (battle) => battle.key === id && battle.age === 0,
    ),
  ).length;
  for (const step of ageZeroRouteTargets) {
    if (battlesWon <= step.afterBattle) return step.pop;
  }
  return 0;
};

/**
 * The next mandatory growth step: a citizen when one is affordable, otherwise
 * the food needed to afford it. Returns null when the route is not waiting on
 * population, so the caller falls through to its own priorities.
 *
 * Housing is deliberately exempt from the target check below. The route's
 * population target is about *citizens*, but a settlement can hit that target
 * and still be unable to grow because `peopleCapacity` is full — and the house
 * that lifts it is exactly the purchase the route exists to make. Returning
 * null the moment `population >= target` therefore locked the settlement at
 * whichever capacity it happened to reach: it had `canBuild("house") === true`
 * and thousands of spare resources, but stood at `population === capacity`
 * forever, because the only step that could raise the cap was gated behind the
 * cap it was meant to lift.
 */
export const getAgeRouteGrowthAction = (
  state: CivilizationState,
): SimulationAction | null => {
  // Housing first, and unconditionally: a full settlement cannot grow at all,
  // whatever the population target says.
  //
  // Houses are themselves capacity-limited (`houseCapacity`, 10 by default) and a
  // town hall adds 10 more, so the settlement's population ceiling is finite and
  // small. Past that ceiling the route must stop asking for citizens, because
  // `canBuild("people")` will report "capacity" forever and the route would
  // otherwise gather for a purchase the engine refuses. Detect that case and let
  // the caller fall through to its own priorities.
  if (state.isBuildingAvailable("people")) {
    const cappedByHousing = state.population.gte(
      state.maximumPopulation.floor(),
    );
    if (cappedByHousing) {
      if (state.canBuild("house")) {
        return { type: "build", building: "house", count: 1 };
      }
      if (state.canBuild("townHall")) {
        return { type: "build", building: "townHall", count: 1 };
      }
    }
  }

  const target = getAgeRouteTargetPopulation(state);
  if (target <= 0) return null;
  if (state.population.gte(ExpNumber.fromNumber(target))) return null;

  if (state.isBuildingAvailable("people")) {
    if (state.canBuild("people")) {
      return { type: "build", building: "people", count: 1 };
    }
    // Still capped and neither house nor town hall is affordable: gather for
    // whichever one is the next real step up.
    if (state.population.gte(state.maximumPopulation.floor())) {
      const nextHousing =
        state.canBuild("house") || !state.canBuild("townHall")
          ? "house"
          : "townHall";
      const cost = state.getBuildingCost(
        nextHousing,
        state.getBuildingCount(nextHousing),
        1,
      );
      const missing = cost.find(({ resource, base }) =>
        state.resources[resource as ProductionResourceKey]?.lt(base),
      );
      if (missing && isResourceGatherable(state, missing.resource)) {
        return { type: "gather", resource: missing.resource };
      }
    }
  }

  const citizenCost = state
    .getBuildingCost("people", state.getBuildingCount("people"), 1)
    .find(({ resource }) => resource === "food");
  if (citizenCost && state.resources.food.lt(citizenCost.base)) {
    // Gathered food alone cannot break this deadlock. Every citizen drains
    // 1 food/second, so past roughly the first few dozen citizens the drain
    // outruns what a handful of clicks per action adds, and the route gathers
    // forever without ever affording the next citizen. A farm raises the
    // *passive* rate, which is the only thing that scales — so when food is the
    // binding constraint, buy the farm that multiplies food production instead
    // of clicking for more of it.
    if (
      state.isBuildingAvailable("farm") &&
      !state.isBuildingAtCapacity("farm") &&
      state.canBuild("farm")
    ) {
      return { type: "build", building: "farm", count: 1 };
    }
    return { type: "gather", resource: "food" };
  }
  return null;
};

/**
 * Prepares the next required battle when its progression building is now
 * available. Builds it if affordable; gathers the bottleneck resource if not.
 * This is strategy policy only; `canBuild()` remains the game rule.
 */
export const getRequiredBattlePreparationAction = (
  state: CivilizationState,
): SimulationAction | null => {
  const requiredBattle = getRequiredBattle(state);
  if (!requiredBattle) return null;
  for (const building of requiredBattleBuildings) {
    if (
      state.getBuildingCount(building) === 0 &&
      state.isBuildingAvailable(building)
    ) {
      if (state.canBuild(building)) {
        return { type: "build", building, count: 1 };
      }
      // Not affordable yet — gather toward the most-missing gatherable resource.
      const costs = state.getBuildingCost(building, 0, 1);
      const missing = costs
        .filter(({ resource, base }) => state.resources[resource]?.lt(base))
        .filter(({ resource }) => isResourceGatherable(state, resource))
        .sort((left, right) => {
          const leftDeficit = left.base.sub(
            state.resources[left.resource] ?? ExpNumber.ZERO,
          );
          const rightDeficit = right.base.sub(
            state.resources[right.resource] ?? ExpNumber.ZERO,
          );
          if (leftDeficit.gt(rightDeficit)) return -1;
          if (rightDeficit.gt(leftDeficit)) return 1;
          return left.resource.localeCompare(right.resource);
        });
      if (missing[0]) return { type: "gather", resource: missing[0].resource };
      // All costs are either met or not gatherable — do not block on this building.
    }
  }
  return null;
};

/**
 * Returns the age transition action once the current age's data-defined
 * requirements are satisfied.
 *
 * `canEnterAge` is the whole game rule — the live era card gates on exactly that
 * and nothing else (every battle in the age won, plus the age's building
 * target). This helper deliberately adds no population requirement of its own:
 * population is capped by housing capacity, so a settlement can legitimately
 * finish an age one citizen short of the *next* age's threshold and still be
 * allowed to advance. Re-deriving a stricter rule here is what previously left
 * the simulation stuck at the end of an age the engine said it could leave.
 */
export const getRequiredAgeAction = (
  state: CivilizationState,
): SimulationAction | null => {
  const currentAge = state.getCurrentAge();
  if (!currentAge) return null;
  return state.canEnterAge(currentAge.key)
    ? { type: "enterAge", ageId: currentAge.key }
    : null;
};

/** Current owned army, keyed by unit id, for the shared battle simulator. */
const simulatorOwnedArmy = (state: CivilizationState): SimulatorOwnedArmy =>
  new Map(state.getArmyStacks().map(({ unitId, count }) => [unitId, count]));

const simulatorWinCache = new Map<string, boolean>();
const simulatorWinCacheLimit = 16_384;

/** The context shared by every headless battle-plan query. */
const simulatorContext = (state: CivilizationState): BattleSimulatorContext => {
  const combatStateKey = [
    state.boughtResearch.join(","),
    state.boughtUpgrades.join(","),
    state.earnedAchievements.join(","),
    state.defeatedEncounters.join(","),
    state.enteredAges.join(","),
  ].join("|");
  const unitStats = new Map<string, ArmyStack["stats"] | undefined>();
  const enemyStacks = new Map<string, ArmyStack[]>();

  return {
    getCost: (unitId, count) => state.getUnitCost(unitId, count),
    getResearch: (unitIds) => state.getResearchForUnitTypes(unitIds),
    wins: (composition, battleId) => {
      const armyKey = [...composition]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([unitId, count]) => `${unitId}:${count.toString()}`)
        .join(",");
      const key = `${combatStateKey}|${battleId}|${armyKey}`;
      const cached = simulatorWinCache.get(key);
      if (cached !== undefined) return cached;

      const player: ArmyStack[] = [];
      for (const [unitId, count] of composition) {
        if (!unitStats.has(unitId)) {
          unitStats.set(
            unitId,
            state.getUnitStatsWithResearch(unitId, state.boughtResearch),
          );
        }
        const stats = unitStats.get(unitId);
        if (stats) player.push({ unitId, count, stats });
      }

      if (!enemyStacks.has(battleId)) {
        enemyStacks.set(battleId, state.getEnemyStacks(battleId));
      }
      const enemy = enemyStacks.get(battleId) ?? [];
      const wins =
        player.length > 0 &&
        enemy.length > 0 &&
        state.simulateWithStacksOutcome(battleId, player, enemy) === "player";
      if (simulatorWinCache.size >= simulatorWinCacheLimit) {
        const oldest = simulatorWinCache.keys().next().value;
        if (oldest !== undefined) simulatorWinCache.delete(oldest);
      }
      simulatorWinCache.set(key, wins);
      return wins;
    },
  };
};

/** Candidate units the simulator may consider for the current campaign battle.
 *  Only includes units the player has actually unlocked — no speculative research
 *  unlocks — so the solver works with the actual army that can be fielded today. */
const simulatorBattleCandidates = (
  state: CivilizationState,
): UnitDefinition[] => {
  const battle = getRequiredBattle(state);
  return battle
    ? simulatorCandidates(battle.age).filter((unit) =>
        state.isUnitAvailable(unit.key),
      )
    : [];
};

const simulatorPlanKey = (state: CivilizationState): string =>
  [
    getRequiredBattle(state)?.key ?? "",
    unitCountSignature(state),
    state.boughtResearch.join(","),
    state.boughtUpgrades.join(","),
    state.earnedAchievements.join(","),
    state.enteredAges.join(","),
    state.defeatedEncounters.join(","),
  ].join("|");

/** The simulator's advisory plan for the current battle, or null if unavailable. */
const simulatorPlanCache = new Map<string, SimulatorResult | null>();

export const getSimulatorBattlePlan = (
  state: CivilizationState,
): SimulatorResult | null => {
  const key = simulatorPlanKey(state);
  const cached = simulatorPlanCache.get(key);
  if (cached !== undefined) return cached;

  const battle = getRequiredBattle(state);
  const candidates = simulatorBattleCandidates(state);
  const result =
    !battle || candidates.length === 0
      ? null
      : solveMinimumArmy(
          battle.key,
          candidates,
          simulatorContext(state),
          candidates.length > 1,
          simulatorOwnedArmy(state),
        );
  if (simulatorPlanCache.size >= 64) {
    const oldest = simulatorPlanCache.keys().next().value;
    if (oldest !== undefined) simulatorPlanCache.delete(oldest);
  }
  simulatorPlanCache.set(key, result);
  return result;
};

/** First recommended recruit type that the player can legally buy right now. */
const getFirstSimulatorUnit = (
  state: CivilizationState,
  plan: SimulatorResult,
): { readonly unitId: string; readonly count: number } | null => {
  for (const [unitId, count] of plan.composition) {
    if (count > 0 && state.isUnitAvailable(unitId)) {
      return { unitId, count };
    }
  }
  return null;
};

/**
 * Recruit purchases for the current plan, one action per unit type the plan
 * recommends.
 *
 * This used to return only the *first* recommended type. That is wrong for any
 * plan with more than one unit type in it, and it is precisely the case that
 * matters: the solver's plan is the minimum army that wins, so leaving out one
 * of its types leaves the army short and the battle unwinnable. Because the
 * runner spends one action per tick, returning a single type also capped
 * recruitment throughput at one recruit per tick, which the geometric unit cost
 * curve outruns — the settlement bought one warrior at a time while the price of
 * the next climbed faster than the army grew, and it could never win the second
 * battle. One action per recommended type keeps the plan intact and buys the
 * whole shortfall in a single tick.
 */
const getSimulatorUnitActions = (
  state: CivilizationState,
  plan: SimulatorResult | null,
): SimulationAction[] => {
  if (!plan) return [];
  const actions: SimulationAction[] = [];
  for (const [unitId, count] of plan.composition) {
    if (count <= 0 || !state.isUnitAvailable(unitId)) continue;
    const maxAffordable = state.getMaxAffordableUnits(unitId);
    if (maxAffordable <= 0) continue;
    actions.push({
      type: "buyUnit",
      unitId,
      count: Math.min(count, maxAffordable),
    });
  }
  return actions;
};

const getRemainingSimulatorPlan = (
  state: CivilizationState,
  plan: SimulatorResult,
): SimulatorResult => {
  const composition = new Map<string, number>();
  for (const [unitId, targetCount] of plan.totalComposition) {
    const missing = targetCount
      .sub(state.getUnitCount(unitId))
      .ceil()
      .toNumber();
    if (Number.isFinite(missing) && missing > 0) {
      composition.set(unitId, missing);
    }
  }
  return { ...plan, composition };
};

/** Unlock research required for the new unit types in the simulator plan. */
const getSimulatorResearchIds = (
  state: CivilizationState,
  plan: SimulatorResult,
): string[] => {
  const battle = getRequiredBattle(state);
  if (!battle) return [];
  // The solver's explicit research list is deliberately narrower than the
  // historical research it applies while scoring stats: it contains the unlock
  // prerequisites for genuinely new unit types, which are the research purchases
  // the strategy should make.
  return plan.research.ids.filter(
    (researchId) => !state.isResearchBought(researchId),
  );
};

/** Research that unlocks a unit the simulator plan actually recommends. */
const getSimulatorResearchAction = (
  state: CivilizationState,
  plan: SimulatorResult | null,
): SimulationAction | null => {
  if (!plan) return null;
  const researchIds = getSimulatorResearchIds(state, plan);
  for (const researchId of researchIds) {
    if (state.canBuyResearch(researchId)) {
      return { type: "buyResearch", researchId };
    }
  }
  return null;
};

/**
 * Whether a cost resource can be obtained at all right now: either it is
 * directly gatherable, or something already produces it. A purchase blocked on
 * a resource with neither property is blocked on infrastructure, not on
 * gathering, so chasing it would starve the economy that unblocks it.
 */
const isCostResourceReachable = (
  state: CivilizationState,
  resource: string,
): boolean =>
  isResourceGatherable(state, resource) ||
  (producerResourceKeys.includes(resource as ProductionResourceKey) &&
    state
      .computeResourceRate(resource as ProductionResourceKey)
      .gt(ExpNumber.ZERO));

/** An affordable advisor purchase (research unlock or recruit) for the current plan. */
export const getRecommendedBattlePurchase = (
  state: CivilizationState,
  plan: SimulatorResult | null,
): SimulationAction | null => {
  if (!plan) return null;
  return (
    getSimulatorResearchAction(state, plan) ??
    getSimulatorUnitActions(state, plan)[0] ??
    null
  );
};

/**
 * The ROI evaluator's view of the battle simulator: the recruits a battle still
 * needs, what they cost, and the research that unlocks them. Injected rather than
 * imported so `roi.ts` stays independent of the strategy layer.
 */
const planBattleForRoi = (
  state: CivilizationState,
  battleId: string,
): BattleRoiPlan | null => {
  if (state.getNextBattle()?.key !== battleId) return null;
  const plan = getSimulatorBattlePlan(state);
  if (!plan) return null;
  return {
    composition: plan.composition,
    costs: plan.totalCost.map(({ resource, base }) => ({ resource, base })),
    research: plan.research.ids,
  };
};

/**
 * A resource needed by the next recommended purchase, when gatherable. Returns
 * null when the purchase is blocked on a resource the settlement cannot produce
 * yet, so the caller falls through to the economy priorities that unblock it.
 */
const getSimulatorGatherAction = (
  state: CivilizationState,
  plan: SimulatorResult | null,
): SimulationAction | null => {
  if (!plan) return null;
  const unit = getFirstSimulatorUnit(state, plan);
  if (unit) {
    // Always price the *next single unit* — pricing the whole remaining
    // batch inflates food's raw deficit above military's, crowding out the
    // real bottleneck. One-at-a-time pricing keeps the sort honest.
    const costs = state.getUnitCost(unit.unitId, 1);
    if (
      costs.every(({ resource }) => isCostResourceReachable(state, resource))
    ) {
      const missing = costs
        .filter(({ resource }) => isResourceGatherable(state, resource))
        .filter(({ resource, base }) => state.resources[resource].lt(base))
        .sort((left, right) => {
          const leftDeficit = left.base.sub(state.resources[left.resource]);
          const rightDeficit = right.base.sub(state.resources[right.resource]);
          if (leftDeficit.gt(rightDeficit)) return -1;
          if (rightDeficit.gt(leftDeficit)) return 1;
          return left.resource.localeCompare(right.resource);
        });
      const resource = missing[0]?.resource;
      if (
        resource &&
        producerResourceKeys.includes(resource as ProductionResourceKey)
      ) {
        return { type: "gather", resource };
      }
    }
  }
  const researchIds = getSimulatorResearchIds(state, plan);
  const researchId = researchIds.find((id) => state.isResearchUnlocked(id));
  if (researchId) {
    const cost = state.getResearchNextCost()[0];
    if (
      cost &&
      isResourceGatherable(state, cost.resource) &&
      state.resources[cost.resource].lt(cost.base)
    ) {
      return { type: "gather", resource: cost.resource };
    }
  }
  return null;
};

/**
 * One legal next purchase considered by the cheapest strategy.
 *
 * `costs` is always the price of a *single* copy, because the candidate ranking
 * compares one-of-each: choosing the cheapest purchase and then buying the max
 * affordable of it is two separate decisions, and collapsing them would rank a
 * cheap building that scales well against an expensive one that does not.
 */
type PurchaseCandidate = {
  readonly action: SimulationAction;
  readonly costs: readonly BuildingCost[];
  readonly order: number;
};

/** The repeatable purchases: the two buyables the engine can bulk-buy. */
type RepeatableAction = Extract<
  SimulationAction,
  { type: "build" } | { type: "buyUnit" }
>;

const isRepeatableAction = (
  action: SimulationAction,
): action is RepeatableAction =>
  action.type === "build" || action.type === "buyUnit";

const purchaseCost = (costs: readonly BuildingCost[]): ExpNumber =>
  costs.reduce((total, { base }) => total.add(base), ExpNumber.ZERO);

const missingPurchaseCosts = (
  state: CivilizationState,
  costs: readonly BuildingCost[],
): BuildingCost[] =>
  costs.filter(({ resource, base }) => state.resources[resource].lt(base));

const canGatherResource = (
  state: CivilizationState,
  resource: string,
): boolean =>
  producerResourceKeys.includes(resource as ProductionResourceKey) &&
  isResourceGatherable(state, resource);

const canProgressPurchase = (
  state: CivilizationState,
  candidate: PurchaseCandidate,
): boolean => {
  const missing = missingPurchaseCosts(state, candidate.costs);
  return (
    missing.length === 0 ||
    missing.every(({ resource }) => canGatherResource(state, resource))
  );
};

const isPurchaseAffordable = (
  state: CivilizationState,
  candidate: PurchaseCandidate,
): boolean => missingPurchaseCosts(state, candidate.costs).length === 0;

const comparePurchaseCost = (
  left: PurchaseCandidate,
  right: PurchaseCandidate,
): number => {
  const leftCost = purchaseCost(left.costs);
  const rightCost = purchaseCost(right.costs);
  if (leftCost.lt(rightCost)) return -1;
  if (rightCost.lt(leftCost)) return 1;
  return left.order - right.order;
};

const getPurchaseCandidates = (
  state: CivilizationState,
): PurchaseCandidate[] => {
  const candidates: PurchaseCandidate[] = [];
  let order = 0;
  const add = (action: SimulationAction, costs: readonly BuildingCost[]) => {
    candidates.push({ action, costs, order });
    order += 1;
  };

  for (const building of buildingDefinitions) {
    if (
      !state.isBuildingAvailable(building.key) ||
      state.isBuildingAtCapacity(building.key)
    ) {
      continue;
    }
    const currentCount = state.getBuildingCount(building.key);
    const costs = state.freeBuildings
      ? []
      : state.getBuildingCost(building.key, currentCount, 1);
    add({ type: "build", building: building.key, count: 1 }, costs);
  }

  for (const unit of state.getRosterUnits()) {
    const costs = state.freeUnits ? [] : state.getUnitCost(unit.key, 1);
    add({ type: "buyUnit", unitId: unit.key, count: 1 }, costs);
  }

  for (const research of researchDefinitions) {
    if (
      state.isResearchBought(research.key) ||
      !state.isResearchUnlocked(research.key)
    ) {
      continue;
    }
    add(
      { type: "buyResearch", researchId: research.key },
      state.getResearchNextCost(),
    );
  }

  for (const upgrade of upgradeDefinitions) {
    if (
      state.isUpgradeBought(upgrade.key) ||
      !state.isUpgradeUnlocked(upgrade.key)
    ) {
      continue;
    }
    add(
      { type: "buyUpgrade", upgradeId: upgrade.key },
      state.freeUpgrades ? [] : state.getUpgradeCost(upgrade.key),
    );
  }

  return candidates;
};

const getCheapestPurchaseCandidate = (
  state: CivilizationState,
): PurchaseCandidate | null => {
  const candidates = getPurchaseCandidates(state).filter((candidate) =>
    canProgressPurchase(state, candidate),
  );
  const affordable = candidates
    .filter((candidate) => isPurchaseAffordable(state, candidate))
    .sort(comparePurchaseCost);
  if (affordable.length > 0) return affordable[0];
  return candidates.sort(comparePurchaseCost)[0] ?? null;
};

/**
 * The candidate's action with its count raised to the most the settlement can
 * afford right now, for the two repeatable buyables. Research and upgrades are
 * one-shot, so their actions pass through untouched.
 *
 * The MAX probes are capacity-aware, so this cannot overbuild: a building stops
 * at its cap (and `people` additionally at the housing limit) and units stop at
 * what is payable. The result is still re-clamped to at least 1 because the
 * caller has already proven one copy is affordable — this only ever widens a
 * purchase that was going to happen anyway, never introduces a new one.
 */
const withMaxAffordableCount = (
  state: CivilizationState,
  candidate: PurchaseCandidate,
): SimulationAction => {
  const { action } = candidate;
  if (!isRepeatableAction(action)) return action;
  const maxAffordable =
    action.type === "build"
      ? state.getMaxAffordableBuildings(action.building)
      : state.getMaxAffordableUnits(action.unitId);
  return { ...action, count: Math.max(1, maxAffordable) };
};

/**
 * Gather target for a settlement that is not producing anything yet: the
 * resource owed by its cheapest reachable purchase. With no worker assigned every
 * production rate ties at zero, so a lowest-rate heuristic would keep choosing
 * the same arbitrary resource and the economy would never bootstrap. Returns
 * null once any worker is assigned, because rates are meaningful after that.
 */
export const getBootstrapGatherResource = (
  state: CivilizationState,
): string | null => {
  if (state.assignedWorkers !== 0) return null;
  const candidate = getCheapestPurchaseCandidate(state);
  return candidate ? gatherForPurchase(state, candidate) : null;
};

const gatherForPurchase = (
  state: CivilizationState,
  candidate: PurchaseCandidate,
): string | null => {
  const missing = missingPurchaseCosts(state, candidate.costs).filter(
    ({ resource }) => canGatherResource(state, resource),
  );
  if (missing.length === 0) return null;
  return missing.sort((left, right) => {
    const leftDeficit = left.base.sub(state.resources[left.resource]);
    const rightDeficit = right.base.sub(state.resources[right.resource]);
    if (leftDeficit.gt(rightDeficit)) return -1;
    if (rightDeficit.gt(leftDeficit)) return 1;
    return left.resource.localeCompare(right.resource);
  })[0].resource;
};

const getCheapestHousingAction = (
  state: CivilizationState,
): SimulationAction | null => {
  if (
    !state.isBuildingAvailable("people") ||
    !state.population.gt(ExpNumber.ZERO) ||
    !state.population.gte(state.maximumPopulation.floor())
  ) {
    return null;
  }
  if (state.canBuild("house")) {
    return { type: "build", building: "house", count: 1 };
  }
  if (state.canBuild("townHall")) {
    return { type: "build", building: "townHall", count: 1 };
  }

  const nextHousing =
    state.canBuild("house") || !state.canBuild("townHall")
      ? "house"
      : "townHall";
  const costs = state.getBuildingCost(
    nextHousing,
    state.getBuildingCount(nextHousing),
    1,
  );
  const missing = costs
    .filter(
      ({ resource, base }) =>
        state.resources[resource].lt(base) &&
        isResourceGatherable(state, resource),
    )
    .sort((left, right) => {
      const leftDeficit = left.base.sub(state.resources[left.resource]);
      const rightDeficit = right.base.sub(state.resources[right.resource]);
      if (leftDeficit.gt(rightDeficit)) return -1;
      if (rightDeficit.gt(leftDeficit)) return 1;
      return left.resource.localeCompare(right.resource);
    });
  return missing[0] ? { type: "gather", resource: missing[0].resource } : null;
};

/**
 * Base strategy class with common utilities.
 */
abstract class BaseStrategy implements SimulationStrategy {
  abstract name: string;
  abstract description: string;

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.4,
      wood: 0.3,
      stone: 0.2,
      gold: 0.1,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  /**
   * How much this strategy leans on the market's trade routes, or `null` for none.
   *
   * Trade is opt-in per strategy rather than a step in the shared ladder, because
   * it is the one economy lever with no default: an unused trade power reserve is
   * inert, and a strategy that never opens a route must behave exactly as it did
   * before routes existed.
   */
  protected getTradeProfile(): TradeProfile | null {
    return null;
  }

  /**
   * The market route the settlement should be running, when this strategy trades.
   * Null for every strategy that does not, which is what keeps the ladder below
   * free of a trade branch.
   */
  protected getTradeAction(state: CivilizationState): SimulationAction | null {
    const profile = this.getTradeProfile();
    return profile ? getTradeRouteAction(state, profile) : null;
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 8 },
      { building: "farm", weight: 7 },
      { building: "lumberYard", weight: 6 },
      { building: "quarry", weight: 5 },
      { building: "goldMine", weight: 4 },
      { building: "market", weight: 3 },
      { building: "townHall", weight: 2 },
    ];
  }

  /**
   * Whether this strategy is willing to take the next campaign battle at all.
   *
   * The default is the normal case: yes, take it. A strategy that wants to stay
   * out of the campaign (or hold its army back for a later push) overrides this
   * to return `false`.
   *
   * There is deliberately **no winnability check here**. "Aggressive, but never
   * blind" is already enforced one line below, by `getRequiredBattleAction`,
   * which refuses to emit a `launchBattle` unless the battle simulator says the
   * army actually wins. Re-implementing that test as a boolean here made this
   * method an exact restatement of `getRequiredBattleAction(state) !== null`,
   * so the wrapper was an identity function that ran the same un-memoized
   * battle simulation twice per decision — and the runner runs it a third time
   * in `launchBattle`. One authority for "can we win", here.
   */
  protected shouldLaunchBattle(state: CivilizationState): boolean {
    const target = getAgeRouteTargetPopulation(state);
    return target <= 0 || state.population.gte(ExpNumber.fromNumber(target));
  }

  /**
   * The battle to launch this turn, or null. The single entry point every
   * `decideAction` uses for combat, so `shouldLaunchBattle` is genuinely wired
   * in rather than a dead override — and because the win check lives in
   * `getRequiredBattleAction`, overriding this can only ever make a strategy
   * fight *less*, never launch a battle it would lose.
   */
  protected getBattleLaunchAction(
    state: CivilizationState,
  ): SimulationAction | null {
    if (!this.shouldLaunchBattle(state)) return null;
    return getRequiredBattleAction(state);
  }

  protected getResearchAction(
    state: CivilizationState,
  ): SimulationAction | null {
    return getRequiredResearchAction(state);
  }

  /**
   * Advisory battle plan from the shared simulator, as the purchases it calls
   * for. A null plan means the simulator has no reachable candidate; an empty
   * plan is deliberately treated as advisory only, so the real battle check
   * above still decides launches.
   *
   * Every unit type the plan recommends is returned, not just the first. The
   * runner applies one action per tick, so a mixed plan needs one action per
   * type to actually be bought; see `getSimulatorUnitActions`.
   *
   * Only purchases are returned here. Gathering toward the plan is handled by
   * `getSimulatorGatherAction` after the economy priorities, because a plan
   * blocked on a resource the settlement cannot produce yet must not starve the
   * buildings and workers that unblock it.
   */
  protected getSimulatorActions(state: CivilizationState): SimulationAction[] {
    const plan = getSimulatorBattlePlan(state);
    const research = getSimulatorResearchAction(state, plan);
    if (research) return [research];
    return getSimulatorUnitActions(state, plan);
  }

  /**
   * Gathering that targets the advisor's next purchase. Deliberately demoted
   * below worker assignment and building purchases: it is a hint about *what* to
   * save for, never a reason to stop growing the economy.
   */
  protected getSimulatorGather(
    state: CivilizationState,
  ): SimulationAction | null {
    return getSimulatorGatherAction(state, getSimulatorBattlePlan(state));
  }

  protected focusWorkersForGather(
    state: CivilizationState,
    action: SimulationAction,
  ): SimulationAction {
    if (
      action.type !== "gather" ||
      !producerResourceKeys.includes(action.resource as ProductionResourceKey)
    ) {
      return action;
    }
    return (
      this.assignWorkersByRatio(
        state,
        this.getWorkerRatios(),
        action.resource as ProductionResourceKey,
      ) ?? action
    );
  }

  protected getUnitAction(state: CivilizationState): SimulationAction | null {
    const nextBattle = getRequiredBattle(state);
    const candidates = nextBattle
      ? getBattleUnitCandidates(state)
      : [...state.getRosterUnits()].sort(
          (left, right) => right.tier - left.tier,
        );
    const unit = candidates.find(
      (candidate) => state.getMaxAffordableUnits(candidate.key) > 0,
    );
    if (!unit) return null;
    return {
      type: "buyUnit",
      unitId: unit.key,
      count: Math.min(state.getMaxAffordableUnits(unit.key), 100),
    };
  }

  /**
   * Rebalance workers toward the strategy ratio. Surplus workers are removed
   * first; the next action can then assign those workers to a deficit resource.
   */
  protected assignWorkersByRatio(
    state: CivilizationState,
    ratios: WorkerRatios,
    priorityResource?: ProductionResourceKey,
  ): SimulationAction | null {
    const focusedRatios = { ...ratios };
    let total = Object.values(focusedRatios).reduce((sum, r) => sum + r, 0);

    if (priorityResource && total > 0) {
      const focusShare = 0.5;
      const foodShare = priorityResource === "food" ? 0 : 0.25;
      const otherWeight =
        total -
        ratios[priorityResource] -
        (priorityResource === "food" ? 0 : ratios.food);
      if (ratios[priorityResource] / total < focusShare && otherWeight > 0) {
        for (const resource of producerResourceKeys as ProductionResourceKey[]) {
          if (resource === priorityResource) {
            focusedRatios[resource] = focusShare;
          } else if (resource === "food" && priorityResource !== "food") {
            focusedRatios[resource] = foodShare;
          } else {
            focusedRatios[resource] =
              (ratios[resource] / otherWeight) * (1 - focusShare - foodShare);
          }
        }
        total = 1;
      }
    }

    const available = state.availableWorkers; // always integer from engine
    const assigned = state.assignedWorkers; // always integer from engine

    if (total === 0) return null;

    const totalWorkers = assigned + available;

    // Calculate target assignments for all production resources (integer floors)
    const targets: Record<ProductionResourceKey, number> = {
      food: Math.floor((focusedRatios.food / total) * totalWorkers),
      wood: Math.floor((focusedRatios.wood / total) * totalWorkers),
      stone: Math.floor((focusedRatios.stone / total) * totalWorkers),
      gold: Math.floor((focusedRatios.gold / total) * totalWorkers),
      military: Math.floor((focusedRatios.military / total) * totalWorkers),
      science: Math.floor((focusedRatios.science / total) * totalWorkers),
      metalwork: Math.floor((focusedRatios.metalwork / total) * totalWorkers),
      trade: Math.floor((focusedRatios.trade / total) * totalWorkers),
    };

    // Distribute remainder to food
    const targetAssigned = Object.values(targets).reduce(
      (sum, t) => sum + t,
      0,
    );
    targets.food += totalWorkers - targetAssigned;

    let surplusResource: ProductionResourceKey | null = null;
    let surplus = 0;
    for (const resource of producerResourceKeys as ProductionResourceKey[]) {
      const current = Math.round(state.workers[resource]?.toNumber() || 0);
      const excess = current - (targets[resource] || 0);
      if (excess > surplus) {
        surplus = excess;
        surplusResource = resource;
      }
    }
    if (surplusResource) {
      return {
        type: "unassignWorker",
        resource: surplusResource,
        count: surplus,
      };
    }

    // Find the resource with the largest remaining deficit.
    let bestResource: ProductionResourceKey = "food";
    let bestDiff = 0;

    for (const resource of producerResourceKeys as ProductionResourceKey[]) {
      const current = Math.round(state.workers[resource]?.toNumber() || 0);
      const target = targets[resource] || 0;
      const diff = target - current;

      if (diff > 0 && diff > bestDiff) {
        bestDiff = diff;
        bestResource = resource;
      }
    }

    if (available <= 0 || bestDiff <= 0) {
      return null;
    }

    // bestDiff is already an integer (integer target minus integer current)
    return { type: "assignWorker", resource: bestResource, count: bestDiff };
  }

  /**
   * Find the best building to build based on priority and affordability.
   */
  protected findBestBuilding(
    state: CivilizationState,
    priority: BuildingPriority,
  ): BuildingKey | null {
    for (const { building, targetCount } of priority) {
      // Check if at target count
      if (targetCount && (state.builtBuildings[building] || 0) >= targetCount) {
        continue;
      }

      // Check if can build
      if (state.canBuild(building)) {
        return building;
      }
    }
    return null;
  }

  /**
   * Find the first priority building that is blocked only by resources,
   * and return the resource to gather for it.
   */
  protected findPriorityBuildingToGatherFor(
    state: CivilizationState,
    priority: BuildingPriority,
  ): string | null {
    for (const { building, targetCount } of priority) {
      if (targetCount && (state.builtBuildings[building] || 0) >= targetCount) {
        continue;
      }
      if (state.getBuildFailureReason(building) === "resources") {
        const costs = state.getBuildingCost(
          building,
          state.getBuildingCount(building),
          1,
        );
        const missing = missingPurchaseCosts(state, costs).filter(
          ({ resource }) => canGatherResource(state, resource),
        );
        if (missing.length > 0) {
          // Sort missing by deficit descending
          return missing.sort((left, right) => {
            const leftDeficit = left.base.sub(state.resources[left.resource]);
            const rightDeficit = right.base.sub(
              state.resources[right.resource],
            );
            if (leftDeficit.gt(rightDeficit)) return -1;
            if (rightDeficit.gt(leftDeficit)) return 1;
            return left.resource.localeCompare(right.resource);
          })[0].resource;
        }
      }
    }
    return null;
  }

  /**
   * Default decision logic that can be overridden.
   */
  decideAction(
    state: CivilizationState,
    _context: SimulationContext,
  ): SimulationAction | null {
    const requiredAgeAction = getRequiredAgeAction(state);
    if (requiredAgeAction) return requiredAgeAction;

    const requiredBattleAction = this.getBattleLaunchAction(state);
    if (requiredBattleAction) return requiredBattleAction;

    const requiredPreparationAction = getRequiredBattlePreparationAction(state);
    if (requiredPreparationAction) {
      return this.focusWorkersForGather(state, requiredPreparationAction);
    }

    // The battle simulator is advisory: it guides the next purchase, but the
    // real `simulateEncounter` check above is the only launch gate. Only its
    // purchases run this early; its gather hint is demoted to priority 7.
    const simulatorActions = this.getSimulatorActions(state);
    if (simulatorActions.length > 0) return simulatorActions[0];

    // Priority 1.5: point the market's trade route at the settlement's largest
    // imbalance. Configuring a route spends no resources and builds nothing, so it
    // never competes with growth. It sits here rather than lower because the
    // ladder's last resort is `gather`, and a gather consumes the whole simulated
    // second — a route waiting below it would almost never get a turn at all.
    const tradeAction = this.getTradeAction(state);
    if (tradeAction) return tradeAction;

    const routeAction = getAgeRouteGrowthAction(state);
    if (routeAction) return this.focusWorkersForGather(state, routeAction);

    // Priority 2: Buy the next combat-path research before spending on units.
    const researchAction = this.getResearchAction(state);
    if (researchAction) return researchAction;

    // Priority 2: Grow the army before attempting the next battle.
    const unitAction = this.getUnitAction(state);
    if (unitAction) return unitAction;

    // Priority 3: Buy affordable unlocked upgrades
    const upgradeAction = this.getBestUpgrade(state);
    if (upgradeAction) return upgradeAction;

    // Priority 5: Assign workers
    const workerAction = this.assignWorkersByRatio(
      state,
      this.getWorkerRatios(),
    );
    if (workerAction) return workerAction;

    // Priority 6: Build buildings (try to build multiple if affordable)
    const building = this.findBestBuilding(state, this.getBuildingPriority());
    if (building) {
      // Check how many we can afford
      const maxAffordable = state.getMaxAffordableBuildings(building);
      const count = Math.min(maxAffordable, 5); // Build up to 5 at a time
      if (count > 0) {
        return { type: "build", building, count };
      }
    }

    // Priority 7: Buy the cheapest legal purchase when nothing above is
    // affordable. Without this the ladder can stall on a hand-ordered priority
    // list: the priority building stays unaffordable while cheap buildings and
    // units — which is what actually grows the settlement — go unpurchased.
    // This is the same fallback the `cheapest` strategy always takes, so every
    // strategy inherits at least its progress, then adds its own priorities.
    const cheapest = getCheapestPurchaseCandidate(state);
    if (cheapest && isPurchaseAffordable(state, cheapest)) {
      return cheapest.action;
    }

    // Priority 8: Food safety. A citizen eats 1 food/second and the next citizen
    // costs more than the first (the cost curve is per-copy), so a settlement
    // with one citizen can sit at a small non-zero food balance it can never
    // spend — one worker cannot out-produce the citizen's own drain. Waiting for
    // food to hit exactly zero is too late: the buffer never gets there. This is
    // the general form of the age route's own food step, kept as a backstop for
    // once the route stops watching population.
    const citizenCost = state
      .getBuildingCost("people", state.getBuildingCount("people"), 1)
      .find(({ resource }) => resource === "food");
    if (
      state.isBuildingAvailable("people") &&
      citizenCost &&
      state.resources.food.lt(citizenCost.base)
    ) {
      return this.focusWorkersForGather(state, {
        type: "gather",
        resource: "food",
      });
    }
    // Priority 8.5: Gather for the highest-priority unaffordable building.
    // If we want a building but can't afford it, actively gather its missing resources.
    const priorityGather = this.findPriorityBuildingToGatherFor(
      state,
      this.getBuildingPriority(),
    );
    if (priorityGather) {
      return this.focusWorkersForGather(state, {
        type: "gather",
        resource: priorityGather,
      });
    }

    // Priority 9: Gather toward the advisor's next purchase, if it is reachable.
    // This sits below workers and buildings on purpose: gathering for a plan
    // blocked on infrastructure must never prevent building that infrastructure.
    const simulatorGather = this.getSimulatorGather(state);
    if (simulatorGather)
      return this.focusWorkersForGather(state, simulatorGather);

    // Priority 10: Gather resources
    const resourceToGather = this.getResourceToGather(state);
    if (resourceToGather) {
      return this.focusWorkersForGather(state, {
        type: "gather",
        resource: resourceToGather,
      });
    }

    // Nothing to do - wait
    return null;
  }

  /**
   * Find the cheapest affordable unlocked upgrade.
   */
  protected getBestUpgrade(state: CivilizationState): SimulationAction | null {
    // upgradeDefinitions is not directly accessible here — we use state methods
    // Try to buy the cheapest affordable upgrade by scanning known upgrade ids
    // We rely on state.getUpgradeFailureReason being null for buyable ones
    const candidates = state.getAffordableUpgrades?.() ?? [];
    if (candidates.length > 0) {
      return { type: "buyUpgrade", upgradeId: candidates[0] };
    }
    return null;
  }

  protected getResourceToGather(state: CivilizationState): string | null {
    const requiredBattleResource = getRequiredBattleResourceToGather(state);
    if (requiredBattleResource) return requiredBattleResource;

    const bootstrapResource = getBootstrapGatherResource(state);
    if (bootstrapResource) return bootstrapResource;

    // Only consider resources that are currently unlocked
    const available = (producerResourceKeys as ProductionResourceKey[]).filter(
      (key) => isResourceGatherable(state, key),
    );

    if (available.length === 0) return "food";

    // Gather the unlocked resource with lowest production rate
    let lowestResource = available[0];
    let lowestRate = state.computeResourceRate(lowestResource);

    for (const resource of available) {
      const rate = state.computeResourceRate(resource);
      if (rate.lt(lowestRate)) {
        lowestRate = rate;
        lowestResource = resource;
      }
    }

    return lowestResource;
  }

  onMilestone?(_event: MilestoneEvent, _state: CivilizationState): void {
    // Override in subclasses for milestone-specific behavior
  }
}

/**
 * Cheapest-purchase strategy: buy the lowest-cost legal purchase every time.
 *
 * Costs are compared as the sum of the purchase's current resource amounts. The
 * game has no exchange rate between resources, so this is deliberately a
 * magnitude comparison, with definition order as a deterministic tie-breaker.
 * Research keeps the engine's global next-purchase price; units and buildings use
 * the same state-aware cost evaluators the live game uses. If nothing is
 * affordable, the strategy gathers the resource that is blocking the cheapest
 * progress-able purchase instead of buying a more expensive item.
 */
export class CheapestStrategy extends BaseStrategy {
  name = "cheapest";
  description = "Always buy the cheapest legal purchase";
  private cachedSimulatorPlan:
    | {
        snapshots: SimulationContext["snapshots"];
        battleId: string;
        plannedAt: number;
        plan: SimulatorResult | null;
      }
    | undefined;

  protected computeSimulatorPlan(
    state: CivilizationState,
  ): SimulatorResult | null {
    return getSimulatorBattlePlan(state);
  }

  private getCachedSimulatorPlan(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulatorResult | null {
    const battle = getRequiredBattle(state);
    if (!battle) {
      this.cachedSimulatorPlan = undefined;
      return null;
    }

    const cached = this.cachedSimulatorPlan;
    if (
      !cached ||
      cached.snapshots !== context.snapshots ||
      cached.battleId !== battle.key ||
      context.gameTime - cached.plannedAt >= 60
    ) {
      const plan = this.computeSimulatorPlan(state);
      this.cachedSimulatorPlan = {
        snapshots: context.snapshots,
        battleId: battle.key,
        plannedAt: context.gameTime,
        plan,
      };
    }
    return this.cachedSimulatorPlan.plan;
  }

  protected shouldLaunchBattle(_state: CivilizationState): boolean {
    return true;
  }

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 1,
      wood: 0,
      stone: 0,
      gold: 0,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    const requiredAgeAction = getRequiredAgeAction(state);
    if (requiredAgeAction) return requiredAgeAction;

    const requiredBattleAction = this.getBattleLaunchAction(state);
    if (requiredBattleAction) return requiredBattleAction;

    const requiredPreparationAction = getRequiredBattlePreparationAction(state);
    if (requiredPreparationAction) {
      return this.focusWorkersForGather(state, requiredPreparationAction);
    }

    const requiredResearchAction = this.getResearchAction(state);
    if (requiredResearchAction) return requiredResearchAction;

    const plan = this.getCachedSimulatorPlan(state, context);
    const remainingPlan = plan ? getRemainingSimulatorPlan(state, plan) : null;
    if (plan) {
      const researchAction = getSimulatorResearchAction(state, plan);
      if (researchAction) return researchAction;

      const unitActions = getSimulatorUnitActions(state, remainingPlan!);
      if (unitActions.length > 0) return unitActions[0];
    }

    const housingAction = getCheapestHousingAction(state);
    if (housingAction) return this.focusWorkersForGather(state, housingAction);

    const candidate = getCheapestPurchaseCandidate(state);
    if (candidate && isPurchaseAffordable(state, candidate)) {
      return withMaxAffordableCount(state, candidate);
    }

    const workerAction = this.assignWorkersByRatio(
      state,
      this.getWorkerRatios(),
    );
    if (workerAction) return workerAction;

    if (remainingPlan) {
      const simulatorGather = getSimulatorGatherAction(state, remainingPlan);
      if (simulatorGather) {
        return this.focusWorkersForGather(state, simulatorGather);
      }
    }

    if (candidate) {
      const resource = gatherForPurchase(state, candidate);
      if (resource) return { type: "gather", resource };
    }

    const resourceToGather = this.getResourceToGather(state);
    return resourceToGather
      ? { type: "gather", resource: resourceToGather }
      : null;
  }
}

/**
 * Balanced strategy: equal focus on production and military.
 */
export class BalancedStrategy extends BaseStrategy {
  name = "balanced";
  description = "Balanced approach to production and military development";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.4,
      wood: 0.25,
      stone: 0.2,
      gold: 0.15,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "farm", weight: 8 },
      { building: "lumberYard", weight: 7 },
      { building: "quarry", weight: 6 },
      { building: "goldMine", weight: 5 },
      { building: "barracks", weight: 4, targetCount: 3 },
      { building: "university", weight: 3, targetCount: 3 },
      { building: "smithy", weight: 3, targetCount: 2 },
      { building: "market", weight: 2 },
      { building: "townHall", weight: 1 },
    ];
  }
}

/**
 * Production-focused strategy: maximize resource generation.
 */
export class ProductionStrategy extends BaseStrategy {
  name = "production";
  description = "Focus on maximizing resource production, minimal military";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.5,
      wood: 0.25,
      stone: 0.15,
      gold: 0.1,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "farm", weight: 8 },
      { building: "lumberYard", weight: 8 },
      { building: "quarry", weight: 7 },
      { building: "goldMine", weight: 7 },
      { building: "market", weight: 5 },
      { building: "townHall", weight: 4 },
    ];
  }
}

/**
 * Military-focused strategy: early military investment.
 */
export class MilitaryStrategy extends BaseStrategy {
  name = "military";
  description = "Early military investment, aggressive battle engagement";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.35,
      wood: 0.25,
      stone: 0.25,
      gold: 0.15,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "farm", weight: 7 },
      { building: "lumberYard", weight: 6 },
      { building: "quarry", weight: 6 },
      { building: "barracks", weight: 8, targetCount: 5 },
      { building: "university", weight: 7, targetCount: 3 },
      { building: "smithy", weight: 7, targetCount: 3 },
      { building: "goldMine", weight: 5 },
      { building: "market", weight: 3 },
      { building: "townHall", weight: 2 },
    ];
  }

  protected getResourceToGather(_state: CivilizationState): string | null {
    // Prioritize gathering resources for military buildings
    return "gold";
  }
}

/**
 * Fast-age strategy: push population growth to age up quickly.
 */
export class FastAgeStrategy extends BaseStrategy {
  name = "fast-age";
  description = "Prioritize population growth to reach new ages quickly";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.6,
      wood: 0.2,
      stone: 0.1,
      gold: 0.1,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 10 },
      { building: "farm", weight: 9 },
      { building: "townHall", weight: 8 },
      { building: "lumberYard", weight: 5 },
      { building: "quarry", weight: 4 },
      { building: "goldMine", weight: 3 },
      { building: "market", weight: 2 },
    ];
  }
}

/**
 * Economy strategy: maximize gold and trade.
 */
export class EconomyStrategy extends BaseStrategy {
  name = "economy";
  description = "Focus on gold production and trade buildings";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.3,
      wood: 0.2,
      stone: 0.15,
      gold: 0.35,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "goldMine", weight: 9 },
      { building: "market", weight: 8, targetCount: 5 },
      { building: "farm", weight: 6 },
      { building: "lumberYard", weight: 5 },
      { building: "quarry", weight: 4 },
      { building: "townHall", weight: 3 },
    ];
  }

  protected getResourceToGather(_state: CivilizationState): string | null {
    return "gold";
  }
}

/**
 * Trade-focused strategy: bank trade power at the market and route it at whatever
 * the settlement is most out of balance on.
 *
 * The market unlocks in the Iron Age, so this strategy's route — like every other
 * strategy's — is dormant until then and starts from an empty reserve. Until the
 * reserve can move something, the advisor refuses to open a route at all rather
 * than holding the single slot on a dead one.
 */
export class TradeStrategy extends BaseStrategy {
  name = "trader";
  description =
    "Bank trade power at the market and route it to the settlement's largest imbalance";

  protected getTradeProfile(): TradeProfile | null {
    // The whole reserve, scaled by the flow the advisor wants to move.
    return tradeProfile(TRADE_INTENSITY_STOPS, "auto");
  }

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.35,
      wood: 0.25,
      stone: 0.15,
      gold: 0.25,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "market", weight: 8 },
      { building: "farm", weight: 7 },
      { building: "goldMine", weight: 7 },
      { building: "lumberYard", weight: 6 },
      { building: "quarry", weight: 5 },
      { building: "barracks", weight: 4 },
      { building: "university", weight: 3 },
      { building: "smithy", weight: 3 },
      { building: "townHall", weight: 2 },
    ];
  }

  protected getResourceToGather(_state: CivilizationState): string | null {
    // Gold is the numeraire every route is priced in, so it is also the fuel.
    return "gold";
  }
}

/**
 * ROI-first speedrun strategy. Required campaign actions remain authoritative;
 * otherwise it asks the shared ROI evaluator for the best time-adjusted buy.
 */
export class SpeedrunStrategy extends BaseStrategy {
  name = "speedrun";
  description = "Buy the best time-adjusted ROI purchase for fast progression";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.5,
      wood: 0.2,
      stone: 0.15,
      gold: 0.05,
      military: 0.05,
      science: 0.05,
      metalwork: 0,
      trade: 0,
    };
  }

  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    const requiredAgeAction = getRequiredAgeAction(state);
    if (requiredAgeAction) return requiredAgeAction;

    const requiredBattleAction = this.getBattleLaunchAction(state);
    if (requiredBattleAction) return requiredBattleAction;

    const requiredPreparationAction = getRequiredBattlePreparationAction(state);
    if (requiredPreparationAction) {
      return this.focusWorkersForGather(state, requiredPreparationAction);
    }

    const simulatorActions = this.getSimulatorActions(state);
    if (simulatorActions.length > 0) return simulatorActions[0];

    // Follow the mandatory age route before spending anything discretionary.
    // Speedrun overrides decideAction, so without this it never reached the
    // route at all and parked at the 90-population barracks threshold, the
    // slowest settlement of the seven. The route self-limits: once the age0
    // population targets are met it returns null and recruitment resumes, so
    // this cannot starve the army the remaining battles need.
    //
    // The route also owns the food problem: it builds a citizen when one is
    // affordable and gathers food when one is not.
    const routeAction = getAgeRouteGrowthAction(state);
    if (routeAction) return this.focusWorkersForGather(state, routeAction);

    // Workers next. This used to sit above the route, where a settlement pinned
    // at zero food never reached it; below the route it runs every tick the
    // route is satisfied.
    const workerAction = this.assignWorkersByRatio(
      state,
      this.getWorkerRatios(),
    );
    if (workerAction) return workerAction;

    // Food safety, deliberately *below* the age route rather than above it.
    // This guard used to run first, and that was the single biggest reason
    // speedrun was the slowest settlement: a citizen costs food to build and
    // every citizen drains 1 food/second, so a settlement large enough to be
    // worth speeding up sits at or below zero food almost continuously. Ten
    // gathered clicks per action cannot outrun that drain, so the guard never
    // cleared and it returned `gather food` forever — starving worker
    // assignment, buildings and recruitment all at once. Below the route it
    // only speaks when the route has nothing to offer, which is exactly when
    // there is spare budget to spend on something other than food.
    if (state.resources.food.lte(ExpNumber.ZERO)) {
      return this.focusWorkersForGather(state, {
        type: "gather",
        resource: "food",
      });
    }

    // The ROI sweep runs *before* the advisor's gather hint. Gathering is a
    // per-tick trickle, and a recruit's military cost grows geometrically
    // (150 -> 606 -> 1787 -> 3472 across the first four warriors), so a
    // settlement that answers "I cannot afford the next recruit" by gathering
    // can never outrun that curve: it spent 1127 actions gathering military and
    // bought 24 units. Raising military *income* — more barracks, upgrades,
    // research — is the only thing that scales, and the ROI sweep is what finds
    // it. Gathering stays below as the last resort, not the first answer.
    const roiAction = getBestRoiAction(state, {
      includeUnits: false,
      planBattle: planBattleForRoi,
    });
    if (roiAction) return this.focusWorkersForGather(state, roiAction);

    // We must gather for the simulator's plan if we can't afford it, otherwise
    // we stall waiting for workers to passively gather military/science.
    const simulatorGather = this.getSimulatorGather(state);
    if (simulatorGather)
      return this.focusWorkersForGather(state, simulatorGather);

    return super.decideAction(state, context);
  }
}

/**
 * Strategy registry for easy access.
 */
export const strategyRegistry: Record<string, SimulationStrategy> = {
  cheapest: new CheapestStrategy(),
  balanced: new BalancedStrategy(),
  production: new ProductionStrategy(),
  military: new MilitaryStrategy(),
  "fast-age": new FastAgeStrategy(),
  economy: new EconomyStrategy(),
  speedrun: new SpeedrunStrategy(),
  trader: new TradeStrategy(),
};

/**
 * Get a strategy by name.
 */
export function getStrategy(name: string): SimulationStrategy | undefined {
  return strategyRegistry[name];
}

/**
 * Get all available strategy names.
 */
export function getStrategyNames(): string[] {
  return Object.keys(strategyRegistry);
}
