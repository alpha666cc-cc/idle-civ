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
import {
  researchDefinitions,
  researchIdsForBattle,
} from "../src/game/research.js";
import { type ArmyStack } from "../src/game/battle.js";
import {
  simulatorCandidates,
  solveMinimumArmy,
  type BattleSimulatorContext,
  type SimulatorOwnedArmy,
  type SimulatorResult,
  type SimulatorTotalArmy,
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
const simulationResearchHints: Readonly<
  Record<string, readonly string[]>
> = {
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
  const enemyUnitIds = new Set(
    battle.enemyArmy.map(({ unitId }) => unitId),
  );
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
      .map(({ unitId }) => unitDefinitions.find(({ key }) => key === unitId)?.domain)
      .filter((domain): domain is UnitDefinition["domain"] => domain !== undefined),
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
    ...new Set(recommended.flatMap((researchId) => prerequisiteOrder(researchId))),
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

const getBattleUnitCandidates = (state: CivilizationState): UnitDefinition[] => {
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
      return rightDeficit.gt(leftDeficit) ? -1 : leftDeficit.gt(rightDeficit) ? 1 : 0;
    });
  const resource = missing[0]?.resource;
  if (!resource || !producerResourceKeys.includes(resource as ProductionResourceKey)) {
    return null;
  }
  return resource as ProductionResourceKey;
};

/** Launch the required battle when the current army can win it. */
export const getRequiredBattleAction = (
  state: CivilizationState,
): SimulationAction | null => {
  const nextBattle = getRequiredBattle(state);
  if (!nextBattle) return null;
  if (state.simulateEncounter(nextBattle.key)?.outcome !== "player") return null;
  return { type: "launchBattle", encounterId: nextBattle.key };
};

/** Advanced production buildings that support the current battle chain. */
const requiredBattleBuildings: readonly BuildingKey[] = [
  "barracks",
  "university",
  "smithy",
];

/**
 * Prepares the next required battle when its progression building is now
 * available. This is strategy policy only; `canBuild()` remains the game rule.
 */
export const getRequiredBattlePreparationAction = (
  state: CivilizationState,
): SimulationAction | null => {
  const requiredBattle = getRequiredBattle(state);
  if (!requiredBattle) return null;
  for (const building of requiredBattleBuildings) {
    if (state.getBuildingCount(building) === 0 && state.canBuild(building)) {
      return { type: "build", building, count: 1 };
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

/** Build simulator stacks with every research bonus available to the battle. */
const simulatorStacksWithResearch = (
  state: CivilizationState,
  battleId: string,
  composition: SimulatorTotalArmy,
): ArmyStack[] => {
  const battleAge =
    encounterDefinitions.find(({ key }) => key === battleId)?.age ?? 0;
  const researchIds = researchIdsForBattle(battleAge, [...composition.keys()]);
  const stacks: ArmyStack[] = [];
  for (const [unitId, count] of composition) {
    const stats = state.getUnitStatsWithResearch(unitId, researchIds);
    if (stats) stacks.push({ unitId, count, stats });
  }
  return stacks;
};

/** The context shared by every headless battle-plan query. */
const simulatorContext = (state: CivilizationState): BattleSimulatorContext => ({
  getCost: (unitId, count) => state.getUnitCost(unitId, count),
  getResearch: (unitIds) => state.getResearchForUnitTypes(unitIds),
  wins: (composition, battleId) => {
    const player = simulatorStacksWithResearch(state, battleId, composition);
    const enemy = state.getEnemyStacks(battleId);
    return (
      player.length > 0 &&
      enemy.length > 0 &&
      state.simulateWithStacks(battleId, player, enemy).outcome === "player"
    );
  },
});

/** Candidate units the simulator may consider for the current campaign battle. */
const simulatorBattleCandidates = (state: CivilizationState): UnitDefinition[] => {
  const battle = getRequiredBattle(state);
  return battle ? simulatorCandidates(battle.age) : [];
};

const simulatorPlanKey = (state: CivilizationState): string =>
  [
    getRequiredBattle(state)?.key ?? "",
    Object.entries(state.unitCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([unitId, count]) => `${unitId}:${count.toString()}`)
      .join(","),
    state.boughtResearch.join(","),
    state.boughtUpgrades.join(","),
    state.earnedAchievements.join(","),
    state.enteredAges.join(","),
    state.defeatedEncounters.join(","),
    Object.entries(state.builtBuildings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([building, count]) => `${building}:${count ?? 0}`)
      .join(","),
    `${state.freeBuildings ? 1 : 0}${state.freeUnits ? 1 : 0}${state.freeUpgrades ? 1 : 0}`,
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

/** First recommended recruit that the player can actually buy right now. */
const getSimulatorUnitAction = (
  state: CivilizationState,
  plan: SimulatorResult | null,
): SimulationAction | null => {
  if (!plan) return null;
  const unit = getFirstSimulatorUnit(state, plan);
  if (!unit) return null;
  const maxAffordable = state.getMaxAffordableUnits(unit.unitId);
  if (maxAffordable <= 0) return null;
  return {
    type: "buyUnit",
    unitId: unit.unitId,
    count: Math.min(unit.count, maxAffordable),
  };
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
  producerResourceKeys.includes(resource as ProductionResourceKey) &&
    state.computeResourceRate(resource as ProductionResourceKey).gt(ExpNumber.ZERO);

/** An affordable advisor purchase (research unlock or recruit) for the current plan. */
export const getRecommendedBattlePurchase = (
  state: CivilizationState,
  plan: SimulatorResult | null,
): SimulationAction | null => {
  if (!plan) return null;
  return getSimulatorResearchAction(state, plan) ?? getSimulatorUnitAction(state, plan);
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
    const maxAffordable = state.getMaxAffordableUnits(unit.unitId);
    const count = Math.max(1, Math.min(unit.count, maxAffordable || unit.count));
    const costs = state.getUnitCost(unit.unitId, count);
    if (costs.every(({ resource }) => isCostResourceReachable(state, resource))) {
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
      if (resource && producerResourceKeys.includes(resource as ProductionResourceKey)) {
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

/** One legal next purchase considered by the cheapest strategy. */
type PurchaseCandidate = {
  readonly action: SimulationAction;
  readonly costs: readonly BuildingCost[];
  readonly order: number;
};

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

const getPurchaseCandidates = (state: CivilizationState): PurchaseCandidate[] => {
  const candidates: PurchaseCandidate[] = [];
  let order = 0;
  const add = (action: SimulationAction, costs: readonly BuildingCost[]) => {
    candidates.push({ action, costs, order });
    order += 1;
  };

  for (const building of buildingDefinitions) {
    if (!state.isBuildingAvailable(building.key) || state.isBuildingAtCapacity(building.key)) {
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
    if (state.isResearchBought(research.key) || !state.isResearchUnlocked(research.key)) {
      continue;
    }
    add(
      { type: "buyResearch", researchId: research.key },
      state.getResearchNextCost(),
    );
  }

  for (const upgrade of upgradeDefinitions) {
    if (state.isUpgradeBought(upgrade.key) || !state.isUpgradeUnlocked(upgrade.key)) {
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
  const missing = missingPurchaseCosts(state, candidate.costs).filter(({ resource }) =>
    canGatherResource(state, resource),
  );
  if (missing.length === 0) return null;
  return missing
    .sort((left, right) => {
      const leftDeficit = left.base.sub(state.resources[left.resource]);
      const rightDeficit = right.base.sub(state.resources[right.resource]);
      if (leftDeficit.gt(rightDeficit)) return -1;
      if (rightDeficit.gt(leftDeficit)) return 1;
      return left.resource.localeCompare(right.resource);
    })[0].resource;
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

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 8 },
      { building: "farm", weight: 7 },
      { building: "lumber-yard", weight: 6 },
      { building: "quarry", weight: 5 },
      { building: "gold-mine", weight: 4 },
      { building: "market", weight: 3 },
      { building: "town-hall", weight: 2 },
    ];
  }

  protected shouldLaunchBattle(_state: CivilizationState): boolean {
    return false;
  }

  protected getResearchAction(
    state: CivilizationState,
  ): SimulationAction | null {
    return getRequiredResearchAction(state);
  }

  /**
   * Advisory battle plan from the shared simulator. A null plan means the
   * simulator has no reachable candidate; an empty plan is deliberately treated
   * as advisory only, so the real battle check above still decides launches.
   *
   * Only purchases are returned here. Gathering toward the plan is handled by
   * `getSimulatorGatherAction` after the economy priorities, because a plan
   * blocked on a resource the settlement cannot produce yet must not starve the
   * buildings and workers that unblock it.
   */
  protected getSimulatorAction(state: CivilizationState): SimulationAction | null {
    return getRecommendedBattlePurchase(state, getSimulatorBattlePlan(state));
  }

  /**
   * Gathering that targets the advisor's next purchase. Deliberately demoted
   * below worker assignment and building purchases: it is a hint about *what* to
   * save for, never a reason to stop growing the economy.
   */
  protected getSimulatorGather(state: CivilizationState): SimulationAction | null {
    return getSimulatorGatherAction(state, getSimulatorBattlePlan(state));
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
  ): SimulationAction | null {
    const total = Object.values(ratios).reduce((sum, r) => sum + r, 0);
    const available = state.availableWorkers; // always integer from engine
    const assigned = state.assignedWorkers; // always integer from engine

    if (total === 0) return null;

    const totalWorkers = assigned + available;

    // Calculate target assignments for all production resources (integer floors)
    const targets: Record<ProductionResourceKey, number> = {
      food: Math.floor((ratios.food / total) * totalWorkers),
      wood: Math.floor((ratios.wood / total) * totalWorkers),
      stone: Math.floor((ratios.stone / total) * totalWorkers),
      gold: Math.floor((ratios.gold / total) * totalWorkers),
      military: Math.floor((ratios.military / total) * totalWorkers),
      science: Math.floor((ratios.science / total) * totalWorkers),
      metalwork: Math.floor((ratios.metalwork / total) * totalWorkers),
      trade: Math.floor((ratios.trade / total) * totalWorkers),
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
   * Default decision logic that can be overridden.
   */
  decideAction(
    state: CivilizationState,
    _context: SimulationContext,
  ): SimulationAction | null {
    const requiredAgeAction = getRequiredAgeAction(state);
    if (requiredAgeAction) return requiredAgeAction;

    const requiredBattleAction = getRequiredBattleAction(state);
    if (requiredBattleAction) return requiredBattleAction;

    const requiredPreparationAction = getRequiredBattlePreparationAction(state);
    if (requiredPreparationAction) return requiredPreparationAction;

    // The battle simulator is advisory: it guides the next purchase, but the
    // real `simulateEncounter` check above is the only launch gate. Only its
    // purchases run this early; its gather hint is demoted to priority 7.
    const simulatorAction = this.getSimulatorAction(state);
    if (simulatorAction) return simulatorAction;

    // Priority 1: Buy the next combat-path research before spending on units.
    const researchAction = this.getResearchAction(state);
    if (researchAction) return researchAction;

    // Priority 2: Grow the army before attempting the next battle.
    const unitAction = this.getUnitAction(state);
    if (unitAction) return unitAction;

    // Priority 3: Launch battle if ready
    if (this.shouldLaunchBattle(state)) {
      const nextBattle = state.getNextBattle();
      if (
        nextBattle &&
        state.simulateEncounter(nextBattle.key)?.outcome === "player"
      ) {
        return { type: "launchBattle", encounterId: nextBattle.key };
      }
    }

    // Priority 4: Buy affordable unlocked upgrades
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

    // Priority 7: Gather toward the advisor's next purchase, if it is reachable.
    // This sits below workers and buildings on purpose: gathering for a plan
    // blocked on infrastructure must never prevent building that infrastructure.
    const simulatorGather = this.getSimulatorGather(state);
    if (simulatorGather) return simulatorGather;

    // Priority 8: Gather resources
    const resourceToGather = this.getResourceToGather(state);
    if (resourceToGather) {
      return { type: "gather", resource: resourceToGather };
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
    _context: SimulationContext,
  ): SimulationAction | null {
    const requiredAgeAction = getRequiredAgeAction(state);
    if (requiredAgeAction) return requiredAgeAction;

    const requiredBattleAction = getRequiredBattleAction(state);
    if (requiredBattleAction) return requiredBattleAction;

    const candidate = getCheapestPurchaseCandidate(state);
    if (candidate && isPurchaseAffordable(state, candidate)) {
      return candidate.action;
    }

    const workerAction = this.assignWorkersByRatio(
      state,
      this.getWorkerRatios(),
    );
    if (workerAction) return workerAction;

    if (candidate) {
      const resource = gatherForPurchase(state, candidate);
      if (resource) return { type: "gather", resource };
    }

    const resourceToGather = this.getResourceToGather(state);
    return resourceToGather ? { type: "gather", resource: resourceToGather } : null;
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
      { building: "lumber-yard", weight: 7 },
      { building: "quarry", weight: 6 },
      { building: "gold-mine", weight: 5 },
      { building: "barracks", weight: 4, targetCount: 3 },
      { building: "university", weight: 3, targetCount: 3 },
      { building: "smithy", weight: 3, targetCount: 2 },
      { building: "market", weight: 2 },
      { building: "town-hall", weight: 1 },
    ];
  }

  protected shouldLaunchBattle(state: CivilizationState): boolean {
    // Launch battle when military power is decent
    const power = state.getArmyPower();
    const nextBattle = state.getNextBattle();
    return nextBattle !== undefined && power.gte(ExpNumber.fromNumber(50));
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
      { building: "lumber-yard", weight: 8 },
      { building: "quarry", weight: 7 },
      { building: "gold-mine", weight: 7 },
      { building: "market", weight: 5 },
      { building: "town-hall", weight: 4 },
    ];
  }

  protected shouldLaunchBattle(_state: CivilizationState): boolean {
    // Only launch battles when necessary (high power to ensure wins)
    return false; // Production strategy avoids battles
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
      { building: "lumber-yard", weight: 6 },
      { building: "quarry", weight: 6 },
      { building: "barracks", weight: 8, targetCount: 5 },
      { building: "university", weight: 7, targetCount: 3 },
      { building: "smithy", weight: 7, targetCount: 3 },
      { building: "gold-mine", weight: 5 },
      { building: "market", weight: 3 },
      { building: "town-hall", weight: 2 },
    ];
  }

  protected shouldLaunchBattle(state: CivilizationState): boolean {
    // Launch battles aggressively
    const nextBattle = state.getNextBattle();
    return nextBattle !== undefined;
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
      { building: "town-hall", weight: 8 },
      { building: "lumber-yard", weight: 5 },
      { building: "quarry", weight: 4 },
      { building: "gold-mine", weight: 3 },
      { building: "market", weight: 2 },
    ];
  }

  protected shouldLaunchBattle(state: CivilizationState): boolean {
    // Only do battles required for age progression
    const currentAge = state.getCurrentAge();
    if (!currentAge) return false;

    // Check if all battles in current age are won
    const ageIndex = parseInt(currentAge.key.slice(-1), 10);
    const ageBattles = encounterDefinitions.filter(
      (e: { age: number }) => e.age === ageIndex,
    );
    const battlesWon = ageBattles.filter((b: { key: string }) =>
      state.defeatedEncounters.includes(b.key),
    ).length;

    // Launch next battle if not all won
    const nextBattle = state.getNextBattle();
    return nextBattle !== undefined && battlesWon < ageBattles.length;
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
      { building: "gold-mine", weight: 9 },
      { building: "market", weight: 8, targetCount: 5 },
      { building: "farm", weight: 6 },
      { building: "lumber-yard", weight: 5 },
      { building: "quarry", weight: 4 },
      { building: "town-hall", weight: 3 },
    ];
  }

  protected getResourceToGather(_state: CivilizationState): string | null {
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

    const requiredBattleAction = getRequiredBattleAction(state);
    if (requiredBattleAction) return requiredBattleAction;

    const requiredPreparationAction = getRequiredBattlePreparationAction(state);
    if (requiredPreparationAction) return requiredPreparationAction;

    // A speedrun must not spend its whole gather budget on non-food inputs while
    // the food buffer is empty; a farm/citizen purchase is the next enabler.
    if (state.resources.food.lte(ExpNumber.ZERO)) {
      return { type: "gather", resource: "food" };
    }

    const workerAction = this.assignWorkersByRatio(
      state,
      this.getWorkerRatios(),
    );
    if (workerAction) return workerAction;

    // The advisor's battle purchases run before the ROI sweep. ROI excludes units
    // by policy, so without this the settlement would endlessly buy farms and
    // never field the army the required battle gate is waiting on.
    const simulatorAction = this.getSimulatorAction(state);
    if (simulatorAction) return simulatorAction;

    // The ROI sweep includes the pending battle as a candidate, priced with the
    // simulator's army and scored on what winning it actually grants (capacity
    // multipliers included), so a battle worth taking outranks a marginal farm.
    const roiAction = getBestRoiAction(state, {
      includeUnits: false,
      planBattle: planBattleForRoi,
    });
    if (roiAction) return roiAction;

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
