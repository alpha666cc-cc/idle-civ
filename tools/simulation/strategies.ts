/**
 * Pre-built simulation strategies for balance testing.
 * Each strategy implements decision-making logic for worker assignment,
 * building priorities, and battle timing.
 */

import { CivilizationState } from "../../src/game/civilizationState.js";
import { ExpNumber } from "../../src/game/expNumber.js";
import { ageDefinitions } from "../../src/game/ages.js";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingKey,
} from "../../src/game/buildings.js";
import { encounterDefinitions } from "../../src/game/encounters.js";
import { researchDefinitions } from "../../src/game/research.js";
import { upgradeDefinitions } from "../../src/game/upgrades.js";
import { type ArmyStack } from "../../src/game/battle.js";
import { type FormationId } from "../../src/game/formations.js";
import { type OrderId } from "../../src/game/orders.js";
import {
  simulatorCandidates,
  solveMinimumArmy,
  type BattleSimulatorContext,
  type SimulatorResult,
} from "../../src/game/battleSimulator.js";
import {
  type SimulationStrategy,
  type SimulationAction,
  type SimulationContext,
  type MilestoneEvent,
  isResourceGatherable,
} from "./simulation.js";
import {
  producerResourceKeys,
  type ProductionResourceKey,
  type ResourceKey,
} from "../../src/game/attributes.js";
import {
  isBuyableUnit,
  unitDefinitions,
  type UnitDefinition,
} from "../../src/game/units.js";
import {
  getBestRoiAction,
  type BattleRoiPlan,
  type RoiMetricWeights,
  type RoiMilitaryMetric,
} from "./roi.js";
import {
  getTradeRouteAction,
  tradeProfile,
  type TradeProfile,
} from "./tradeAdvisor.js";
import { TRADE_INTENSITY_STOPS } from "../../src/game/trade.js";
import {
  getFastestFundingRoute,
  getFastestWorkerAllocation,
  getWorkerAssignmentAction,
  type FundingCost,
  type FundingRoute,
  type WorkerFocus,
} from "./workerFunding.js";
import { currentObjective, helperBuildingAction } from "./objectivePlan.js";

// Enable adaptive funding only for strategies with measured age-1 improvements.
export let ADAPTIVE_WORKER_FUNDING_ENABLED = true;
export const ADAPTIVE_WORKER_FUNDING_STRATEGIES = new Set<string>([
  "cheapest",
  "balanced",
  "economy",
  "production",
  "fast-age",
  "military",
  "research",
  "player",
  "trader",
]);

export const setAdaptiveWorkerFunding = (
  enabled: boolean,
  strategies: Iterable<string> = [],
): void => {
  ADAPTIVE_WORKER_FUNDING_ENABLED = enabled;
  ADAPTIVE_WORKER_FUNDING_STRATEGIES.clear();
  for (const strategy of strategies) {
    ADAPTIVE_WORKER_FUNDING_STRATEGIES.add(strategy);
  }
};

const largestDeficitResource = (
  state: CivilizationState,
  costs: readonly FundingCost[],
): ProductionResourceKey | null => {
  const missing = costs
    .filter(({ resource, base }) => state.resources[resource].lt(base))
    .filter(
      ({ resource }) =>
        isResourceGatherable(state, resource) &&
        producerResourceKeys.includes(resource as ProductionResourceKey),
    );
  if (missing.length === 0) return null;
  missing.sort((left, right) => {
    const leftDeficit = left.base.sub(state.resources[left.resource]);
    const rightDeficit = right.base.sub(state.resources[right.resource]);
    if (leftDeficit.gt(rightDeficit)) return -1;
    if (rightDeficit.gt(leftDeficit)) return 1;
    return left.resource.localeCompare(right.resource);
  });
  return missing[0].resource as ProductionResourceKey;
};

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

const ageTwoProductionTargets: readonly BuildingKey[] = [
  "farm",
  "lumberYard",
  "quarry",
  "goldMine",
];
const ageTwoProductionTargetCount = 1800;
const ageTwoTownHallTarget: { building: BuildingKey; targetCount: number } = {
  building: "townHall",
  targetCount: 100,
};
const ageTwoRequiredInfrastructureTargets: readonly {
  building: BuildingKey;
  targetCount: number;
}[] = [{ building: "university", targetCount: 600 }];
const ageTwoOptionalInfrastructureTargets: readonly {
  building: BuildingKey;
  targetCount: number;
}[] = [{ building: "market", targetCount: 350 }];
// ageTwoInfrastructureTargets removed — split into required/optional above.

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
  const fallbackTargets = unitDefinitions
    .filter(
      (unit) =>
        isBuyableUnit(unit) &&
        unit.age === battle.age &&
        enemyDomains.has(unit.domain),
    )
    .sort((left, right) => left.tier - right.tier)
    .filter((unit) => !unit.available);
  const firstResearchTarget = fallbackTargets[0];
  return firstResearchTarget && !state.isUnitAvailable(firstResearchTarget.key)
    ? [firstResearchTarget]
    : [];
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

const hasReachedResearchAge = (
  state: CivilizationState,
  researchAge: number,
): boolean => {
  const currentAge = state.getCurrentAge();
  if (!currentAge) return false;
  const currentAgeIndex = ageDefinitions.findIndex(
    ({ key }) => key === currentAge.key,
  );
  return researchAge <= currentAgeIndex;
};

/**
 * Recorded `player` research buy order, one array per age. The Age-0 order is
 * the buy order of the fastest run to clear it. Age 1 starts with the fastest
 * Age-2 run's recorded order, filtered by age and hand-tuned to buy cheap,
 * available technologies earlier. Age 2 is the verbatim buy order of the first
 * manual run to clear it (`saves/manuallogs/first runage3.json`, dev-logged
 * 2026-10-09). Ages 3 and later fall back to the dynamic heuristic.
 *
 */
const playerResearchOrderByAge: readonly (readonly string[])[] = [
  [
    "agriculture",
    "pottery",
    "writing",
    "sling_throwing",
    "tribal_organization",
    "woodcraft_hulls",
    "forestry",
    "mining",
    "stone_working",
    "city_planning",
    "domestication",
    "trapping",
    "animal_husbandry",
    "weaving",
    "calendar",
    "archery_mechanics",
    "flint_knapping",
    "bronze_smelting",
    "bronze_casting",
    "composite_bowcraft",
    "wheel_axle",
    "galley_design",
    "torsion_physics",
  ],
  [
    "alphabet",
    "philosophy_fundamentals",
    "shipbuilding_principles",
    "currency",
    "mathematics",
    "code_of_laws",
    "irrigation",
    "horsemanship",
    "trade_routes",
    "ram_hulls",
    "iron_mining",
    "iron_working",
    "iron_forging",
    "iron_chariotry",
    "heavy_oar_arrays",
    "iron_shielding",
    "cavalry_formations",
    "masonry",
    "road_networks",
    "metallurgy_prep",
    "engineered_siegecraft",
    "coastal_forts",
    "howdah_mounting",
    "berserker_warbands",
  ],
  [
    "logic",
    "scholasticism",
    "crop_rotation",
    "civil_service",
    "legion_discipline",
    "recurve_archery",
    "shock_cavalry",
    "phalanx_doctrine",
    "martial_drill",
    "subterfuge",
    "drama_poetry",
    "surveying",
    "currency_standard",
    "lumber_mills",
    "architecture",
    "aqueducts",
    "banking_concepts",
    "aesthetics",
    "armor_layering",
    "naval_ramming",
    "armed_merchant_navies",
    "siege_logistics",
    "heavy_counterweights",
    "incendiary_weapons",
  ],
];

const getRecordedPlayerResearchOrder = (
  ageIndex: number,
): readonly string[] | undefined =>
  ageIndex < 0 ? undefined : playerResearchOrderByAge[ageIndex];

const hasResearchBonus = (researchId: string, destination: string): boolean =>
  researchDefinitions
    .find(({ key }) => key === researchId)
    ?.bonuses.some(
      (bonus) =>
        bonus.type === "attributeMultiplier" &&
        bonus.destination === destination,
    ) ?? false;

const getBestResourceResearch = (
  state: CivilizationState,
  resource: ResourceKey,
): string | undefined => {
  let best: { key: string; value: ExpNumber } | undefined;
  for (const research of researchDefinitions) {
    if (!hasReachedResearchAge(state, research.age)) continue;
    const bonus = research.bonuses.find(
      ({ type, destination }) =>
        type === "attributeMultiplier" && destination === resource,
    );
    if (!bonus || (best && !bonus.value.gt(best.value))) continue;
    best = { key: research.key, value: bonus.value };
  }
  return best?.key;
};

/** Research priorities from science throughput, the next army's costs, and unlocks. */
const getResearchAdvisorOrder = (
  state: CivilizationState,
  deferPopulationResearch = false,
): readonly string[] => {
  const order: string[] = [];
  const addPath = (researchId: string) => {
    order.push(...prerequisiteOrder(researchId));
  };

  // NOTE: sorting these by the size of their science multiplier instead of by
  // age was tried and changed nothing at Age 1 — `writing` (x10 science, -50% on
  // every building) is the *only* age-0 research that boosts science, so the list
  // has one element and both orderings are identical. It would only matter from
  // Age 2 on, where several age-N techs compete. Left as-is until it can be
  // measured.
  const scienceBoosts = researchDefinitions
    .filter(
      ({ age, key }) =>
        hasReachedResearchAge(state, age) && hasResearchBonus(key, "science"),
    )
    .sort((left, right) => left.age - right.age);
  for (const research of scienceBoosts) addPath(research.key);

  const populationTarget = getAgeRouteTargetPopulation(state);
  const foodResearch =
    populationTarget > 0 &&
    state.population.lt(ExpNumber.fromNumber(populationTarget))
      ? getBestResourceResearch(state, "food")
      : undefined;
  if (!deferPopulationResearch && foodResearch) addPath(foodResearch);

  const battle = getRequiredBattle(state);
  const battlesWon = battle
    ? encounterDefinitions.filter(
        ({ age, key }) =>
          age === battle.age && state.defeatedEncounters.includes(key),
      ).length
    : 0;
  const shouldPrepareArmy = Boolean(
    battle && (battle.age > 0 || battlesWon > 0),
  );

  const targetUnits = shouldPrepareArmy
    ? getRequiredBattleUnitTargets(state)
    : [];
  for (const unit of targetUnits) {
    const costResources = [...unit.costs].sort((left, right) =>
      right.base.gt(left.base) ? 1 : left.base.gt(right.base) ? -1 : 0,
    );
    for (const { resource } of costResources) {
      const booster = getBestResourceResearch(state, resource);
      if (booster) addPath(booster);
    }

    const unlockResearch = researchDefinitions
      .filter(
        ({ age, unlocks }) =>
          hasReachedResearchAge(state, age) && unlocks.includes(unit.key),
      )
      .sort(
        (left, right) =>
          prerequisiteOrder(left.key).length -
          prerequisiteOrder(right.key).length,
      )[0];
    if (unlockResearch) addPath(unlockResearch.key);
  }

  if (deferPopulationResearch && foodResearch) addPath(foodResearch);

  return [...new Set(order)].filter(
    (researchId) => !state.isResearchBought(researchId),
  );
};

const getResearchPriority = (
  state: CivilizationState,
  research: (typeof researchDefinitions)[number],
): number => {
  const battle = getRequiredBattle(state);
  const targetUnits = battle ? getRequiredBattleUnitTargets(state) : [];
  const targetUnitKeys = new Set(targetUnits.map(({ key }) => key));
  const targetResourceKeys = new Set<ResourceKey>();

  for (const unit of targetUnits) {
    for (const { resource } of state.getUnitCost(unit.key, 1)) {
      targetResourceKeys.add(resource as ResourceKey);
    }
  }

  const nextBattleEligible =
    battle &&
    (research.unlocks.includes(battle.key) ||
      research.unlocks.some((unlock) => targetUnitKeys.has(unlock)));

  let score = 0;

  if (nextBattleEligible) score += 2000;
  if (research.unlocks.some((unlock) => targetUnitKeys.has(unlock))) {
    score += 1000;
  }

  for (const bonus of research.bonuses) {
    const value = bonus.value.toNumber();
    if (!Number.isFinite(value)) continue;

    if (bonus.type === "attributeMultiplier") {
      score += (value - 1) * 200;
      if (bonus.destination === "science") score += value * 250;
      if (targetResourceKeys.has(bonus.destination as ResourceKey)) {
        score += value * 350;
      }
    }

    if (bonus.type === "attributeFlat") {
      if (bonus.destination === "science") score += value * 120;
      if (targetResourceKeys.has(bonus.destination as ResourceKey)) {
        score += value * 150;
      }
    }

    if (
      bonus.type === "costReductionPercent" ||
      bonus.type === "costReductionFactor" ||
      bonus.type === "costReductionBase"
    ) {
      score += value * 150;
    }
  }

  const currentAge = state.getCurrentAge();
  if (currentAge) {
    const currentAgeIndex = ageDefinitions.findIndex(
      ({ key }) => key === currentAge.key,
    );
    if (research.age === currentAgeIndex) score += 180;
    if (research.age < currentAgeIndex) score += 25;
  }

  const isGateForCurrentGoal =
    research.prerequisites.some(
      (prerequisite) =>
        targetUnitKeys.has(prerequisite) ||
        (battle && research.unlocks.includes(prerequisite)),
    ) || research.unlocks.some((unlock) => targetUnitKeys.has(unlock));
  if (isGateForCurrentGoal) score += 400;

  return score;
};

/**
 * Rank research by what it is worth, and prefer what can be bought right now.
 *
 * Worth is `getResearchPriority`, unchanged.
 *
 * Note what price does *not* do here. `getResearchCostForCount` prices the
 * **n-th** tech bought in the current age at `base · factor^(√n − 1)` — by
 * ordinal, not by identity — so every research available in an age costs
 * exactly the same, and any path that buys all 23 Age-0 techs pays the same
 * total whatever order it buys them in. Price therefore cannot rank research
 * options: dividing a value score by it is a division by a constant and cancels.
 * Ranking by price was tried and removed.
 *
 * What price *does* tell you is what a delay costs, which is the reason for the
 * affordability multiplier. Because the price climbs with the number already
 * bought this age, a tech that is within reach now is strictly dearer by the
 * time it is reached behind other work. Within an age every tech shares one
 * price, so this term does not reorder siblings against each other — it
 * separates "buyable now" from "not yet", which is what stops the queue idling.
 */
const getResearchUrgency = (
  state: CivilizationState,
  research: (typeof researchDefinitions)[number],
): number => {
  const priority = getResearchPriority(state, research);
  return state.canBuyResearch(research.key) ? priority * 1.3 : priority;
};

const getDynamicResearchOrder = (
  state: CivilizationState,
  deferPopulationResearch = false,
): string[] => {
  const advisorOrder = new Map(
    getResearchAdvisorOrder(state, deferPopulationResearch).map(
      (researchId, index) => [researchId, index],
    ),
  );

  return researchDefinitions
    .filter(
      (research) =>
        state.isResearchUnlocked(research.key) &&
        !state.isResearchBought(research.key),
    )
    .sort((left, right) => {
      const advisorDelta =
        (advisorOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
        (advisorOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER);
      if (advisorDelta !== 0) return advisorDelta;

      const urgencyDelta =
        getResearchUrgency(state, right) - getResearchUrgency(state, left);
      if (urgencyDelta !== 0) return urgencyDelta;

      // Age first, then key: two techs of identical worth are taken in tree
      // order rather than alphabetically, so the order stays stable and readable
      // across ticks instead of reshuffling on an arbitrary comparison.
      return left.age - right.age || left.key.localeCompare(right.key);
    })
    .map(({ key }) => key);
};

const hasCompletedPlayerResearch = (state: CivilizationState): boolean => {
  const currentAge = state.getCurrentAge();
  const currentAgeIndex = currentAge
    ? ageDefinitions.findIndex(({ key }) => key === currentAge.key)
    : 0;

  if (currentAgeIndex === 0) {
    return (getRecordedPlayerResearchOrder(0) ?? []).every((researchId) =>
      state.isResearchBought(researchId),
    );
  }

  return researchDefinitions
    .filter((research) => research.age <= currentAgeIndex)
    .every(
      (research) =>
        !state.isResearchUnlocked(research.key) ||
        state.isResearchBought(research.key),
    );
};

const hasCompletedCurrentAgeResearch = (state: CivilizationState): boolean => {
  const age = state.getCurrentAge();
  if (!age) return true;
  const ageIndex = ageDefinitions.findIndex(({ key }) => key === age.key);
  return researchDefinitions
    .filter((research) => research.age === ageIndex)
    .every(
      (research) =>
        !state.isResearchUnlocked(research.key) ||
        state.isResearchBought(research.key),
    );
};

/**
 * The next purchase on the advisor's current science/battle research plan.
 *
 * Falls back to the first research the settlement can actually afford. Without
 * that fallback a single pricey tech at the head of the order stalls the entire
 * queue — and since price rises with the number already bought this age, that
 * stall does not merely delay the cheap work behind it, it makes it dearer.
 */
export const getRequiredResearchAction = (
  state: CivilizationState,
): SimulationAction | null => {
  const order = getDynamicResearchOrder(state);
  const next = order.find((researchId) => state.canBuyResearch(researchId));
  return next ? { type: "buyResearch", researchId: next } : null;
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
    .filter(({ resource }) =>
      isResourceGatherable(state, resource as ResourceKey),
    )
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
        const count = state.getMaxAffordableBuildings("house");
        return count > 0 ? { type: "build", building: "house", count } : null;
      }
      if (state.canBuild("townHall")) {
        const count = state.getMaxAffordableBuildings("townHall");
        return count > 0
          ? { type: "build", building: "townHall", count }
          : null;
      }
    }
  }

  const target = getAgeRouteTargetPopulation(state);
  if (target <= 0) return null;
  if (state.population.gte(ExpNumber.fromNumber(target))) return null;

  if (state.isBuildingAvailable("people")) {
    if (state.canBuild("people")) {
      const count = state.getMaxAffordableBuildings("people");
      return count > 0 ? { type: "build", building: "people", count } : null;
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
      if (
        missing &&
        isResourceGatherable(state, missing.resource as ResourceKey)
      ) {
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
      const count = state.getMaxAffordableBuildings("farm");
      return count > 0 ? { type: "build", building: "farm", count } : null;
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
        .filter(({ resource }) =>
          isResourceGatherable(state, resource as ResourceKey),
        )
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

export const getRequiredBattlePreparationCosts = (
  state: CivilizationState,
): BuildingCost[] => {
  if (!getRequiredBattle(state)) return [];
  for (const building of requiredBattleBuildings) {
    if (
      state.getBuildingCount(building) === 0 &&
      state.isBuildingAvailable(building)
    ) {
      return state.getBuildingCost(building, 0, 1);
    }
  }
  return [];
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

  const winsWithTactics = (
    composition: ReadonlyMap<string, ExpNumber>,
    battleId: string,
    formations: ReadonlyMap<string, FormationId> = new Map(),
    orders: ReadonlyMap<string, OrderId> = new Map(),
  ): boolean => {
    const armyKey = [...composition]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([unitId, count]) =>
          `${unitId}:${count.toString()}:${formations.get(unitId) ?? "standard"}:${orders.get(unitId) ?? "standard"}`,
      )
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
      if (stats) {
        player.push({
          unitId,
          count,
          stats,
          formation: formations.get(unitId),
          order: orders.get(unitId),
        });
      }
    }

    if (!enemyStacks.has(battleId)) {
      enemyStacks.set(battleId, state.getEnemyStacks(battleId));
    }
    const enemy = enemyStacks.get(battleId) ?? [];
    const wins =
      player.length > 0 &&
      enemy.length > 0 &&
      state.simulateWithStacksOutcome(player, enemy) === "player";
    if (simulatorWinCache.size >= simulatorWinCacheLimit) {
      const oldest = simulatorWinCache.keys().next().value;
      if (oldest !== undefined) simulatorWinCache.delete(oldest);
    }
    simulatorWinCache.set(key, wins);
    return wins;
  };

  return {
    getCost: (unitId, count) =>
      state.costSeriesFrom(state.getUnitCostParameters(unitId), count),
    getResearch: (unitIds) => state.getResearchForUnitTypes(unitIds),
    wins: (composition, battleId) => winsWithTactics(composition, battleId),
    winsWithFormations: (composition, formations, battleId) =>
      winsWithTactics(composition, battleId, formations),
    winsWithFormationsAndOrders: (composition, formations, orders, battleId) =>
      winsWithTactics(composition, battleId, formations, orders),
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

const simulatorPlanKey = (
  state: CivilizationState,
  candidates: readonly UnitDefinition[],
): string => {
  // Simplified cache key: only include what actually affects battle solver behavior
  // - Battle key (which encounter we're fighting)
  // - Available unit types (which units are unlocked)
  // - Research that affects units (bonuses matter for battle outcome)
  // Don't include full stats/costs which change constantly but don't affect
  // the minimum army calculation significantly
  const unitIds = candidates
    .map(({ key }) => key)
    .sort()
    .join(",");
  const relevantResearch = state.boughtResearch
    .filter((researchId) => {
      const research = researchDefinitions.find(
        ({ key }) => key === researchId,
      );
      if (!research) return false;
      // Only include research that actually affects unit stats or unlocks units
      return (
        research.bonuses.some(
          (bonus) =>
            bonus.type === "attributeMultiplier" &&
            (bonus.destination.startsWith("unit.") ||
              bonus.destination.startsWith("tag.")),
        ) || research.unlocks.some((unlock) => unitIds.includes(unlock))
      );
    })
    .sort()
    .join(",");
  return [getRequiredBattle(state)?.key ?? "", unitIds, relevantResearch].join(
    "|",
  );
};

/** Cache hit/miss tracking for battle simulator. */
let simulatorCacheHits = 0;
let simulatorCacheMisses = 0;

export const getSimulatorCacheStats = () => ({
  hits: simulatorCacheHits,
  misses: simulatorCacheMisses,
  hitRate:
    simulatorCacheHits + simulatorCacheMisses > 0
      ? simulatorCacheHits / (simulatorCacheHits + simulatorCacheMisses)
      : 0,
  size: simulatorPlanCache.size,
});

/** The simulator's advisory plan for the current battle, or null if unavailable. */
const simulatorPlanCache = new Map<string, SimulatorResult | null>();

export const getSimulatorBattlePlan = (
  state: CivilizationState,
): SimulatorResult | null => {
  const candidates = simulatorBattleCandidates(state);
  const key = simulatorPlanKey(state, candidates);
  const cached = simulatorPlanCache.get(key);
  if (cached !== undefined) {
    simulatorCacheHits += 1;
    return cached ? getRemainingSimulatorPlan(state, cached) : null;
  }

  simulatorCacheMisses += 1;
  const battle = getRequiredBattle(state);
  const result =
    !battle || candidates.length === 0
      ? null
      : solveMinimumArmy(
          battle.key,
          candidates,
          simulatorContext(state),
          candidates.length > 1,
        );
  if (simulatorPlanCache.size >= 512) {
    const oldest = simulatorPlanCache.keys().next().value;
    if (oldest !== undefined) simulatorPlanCache.delete(oldest);
  }
  simulatorPlanCache.set(key, result);
  return result ? getRemainingSimulatorPlan(state, result) : null;
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
  let unchanged = true;
  for (const [unitId, targetCount] of plan.totalComposition) {
    const missing = targetCount
      .sub(state.getUnitCount(unitId))
      .ceil()
      .toNumber();
    if (Number.isFinite(missing) && missing > 0) {
      composition.set(unitId, missing);
    }
    if (missing !== targetCount.toNumber()) unchanged = false;
  }
  return unchanged ? plan : { ...plan, composition };
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
  isResourceGatherable(state, resource as ResourceKey) ||
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
  planOverride?: SimulatorResult | null,
): BattleRoiPlan | null => {
  if (state.getNextBattle()?.key !== battleId) return null;
  const sourcePlan =
    planOverride === undefined ? getSimulatorBattlePlan(state) : planOverride;
  if (!sourcePlan) return null;
  const plan = getRemainingSimulatorPlan(state, sourcePlan);
  const costTotals = new Map<ResourceKey, ExpNumber>();
  for (const [unitId, count] of plan.composition) {
    for (const { resource, base } of state.getUnitCost(unitId, count)) {
      costTotals.set(
        resource,
        (costTotals.get(resource) ?? ExpNumber.ZERO).add(base),
      );
    }
  }
  return {
    composition: plan.composition,
    costs: [...costTotals].map(([resource, base]) => ({ resource, base })),
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
        .filter(({ resource }) =>
          isResourceGatherable(state, resource as ResourceKey),
        )
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
      isResourceGatherable(state, cost.resource as ResourceKey) &&
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
  isResourceGatherable(state, resource as ResourceKey);

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
        isResourceGatherable(state, resource as ResourceKey),
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
  private adaptiveFundingRoute:
    | { signature: string; updatedAt: number; route: FundingRoute }
    | undefined;
  private gatherWorkerFocus:
    | {
        readonly resource: ProductionResourceKey;
        readonly until: number;
        readonly snapshots: SimulationContext["snapshots"];
      }
    | undefined;
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

  protected getCachedSimulatorPlan(
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
    const current = this.cachedSimulatorPlan ?? cached;
    return current?.plan ?? null;
  }

  protected getWorkerRatios(_state?: CivilizationState): WorkerRatios {
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

  protected getWorkerRebalanceThreshold(): number {
    return 4;
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

  protected getAgeTransitionAction(
    state: CivilizationState,
  ): SimulationAction | null {
    return getRequiredAgeAction(state);
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

  protected getGatherWorkerFocus(
    context: SimulationContext,
  ): ProductionResourceKey | undefined {
    const focus = this.gatherWorkerFocus;
    if (
      !focus ||
      focus.snapshots !== context.snapshots ||
      context.gameTime >= focus.until
    ) {
      this.gatherWorkerFocus = undefined;
      return undefined;
    }
    return focus.resource;
  }

  protected focusWorkersForGather(
    state: CivilizationState,
    action: SimulationAction,
    context: SimulationContext,
  ): SimulationAction {
    if (
      action.type !== "gather" ||
      !producerResourceKeys.includes(action.resource as ProductionResourceKey)
    ) {
      return action;
    }

    const resource = action.resource as ProductionResourceKey;
    const currentFocus = this.getGatherWorkerFocus(context);
    const focusResource =
      resource === "food" ? "food" : (currentFocus ?? resource);
    if (!currentFocus || currentFocus === resource || resource === "food") {
      this.gatherWorkerFocus = {
        resource: focusResource,
        until: context.gameTime + 10,
        snapshots: context.snapshots,
      };
    }
    return (
      this.assignWorkersByRatio(
        state,
        this.getWorkerRatios(state),
        this.getGatherWorkerFocus(context),
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

  protected getAdaptiveResearchTarget(state: CivilizationState): string | null {
    if (!this.shouldFundResearch(state)) return null;
    return (
      getDynamicResearchOrder(state).find(
        (researchId) =>
          state.isResearchUnlocked(researchId) &&
          !state.isResearchBought(researchId),
      ) ?? null
    );
  }

  protected shouldFundResearch(state: CivilizationState): boolean {
    return state.defeatedEncounters.includes("age0_1_first_fire");
  }

  protected getAdaptiveWorkerFundingCosts(
    state: CivilizationState,
  ): FundingCost[] | null {
    const preparation = getRequiredBattlePreparationAction(state);
    if (preparation?.type === "gather") {
      return getRequiredBattlePreparationCosts(state).map(
        ({ resource, base }) => ({ resource, base }),
      );
    }

    const plan = getSimulatorBattlePlan(state);
    const canFundResearch = this.shouldFundResearch(state);
    const planResearch = canFundResearch
      ? plan?.research.ids.find(
          (researchId) =>
            state.isResearchUnlocked(researchId) &&
            !state.isResearchBought(researchId),
        )
      : undefined;
    const researchId = planResearch ?? this.getAdaptiveResearchTarget(state);
    if (researchId && !state.canBuyResearch(researchId)) {
      return state.getResearchNextCost().map(({ resource, base }) => ({
        resource,
        base,
      }));
    }

    const growth = getAgeRouteGrowthAction(state);
    if (growth?.type === "gather") {
      const atHousingCeiling = state.population.gte(
        state.maximumPopulation.floor(),
      );
      const building = atHousingCeiling
        ? state.canBuild("house") || !state.canBuild("townHall")
          ? "house"
          : "townHall"
        : growth.resource === "food"
          ? "people"
          : null;
      if (building) {
        return state
          .getBuildingCost(building, state.getBuildingCount(building), 1)
          .map(({ resource, base }) => ({ resource, base }));
      }
    }

    if (plan && plan.composition.size > 0) {
      return plan.totalCost.map(({ resource, base }) => ({
        resource,
        base,
      }));
    }

    for (const { building, targetCount } of this.getBuildingPriority()) {
      if (
        targetCount !== undefined &&
        state.getBuildingCount(building) >= targetCount
      ) {
        continue;
      }
      if (
        !state.isBuildingAvailable(building) ||
        state.isBuildingAtCapacity(building) ||
        state.getBuildFailureReason(building) !== "resources"
      ) {
        continue;
      }
      return state
        .getBuildingCost(building, state.getBuildingCount(building), 1)
        .map(({ resource, base }) => ({ resource, base }));
    }
    return null;
  }

  protected getAdaptiveWorkerFundingEnabled(): boolean {
    if (!ADAPTIVE_WORKER_FUNDING_ENABLED) return false;
    return ADAPTIVE_WORKER_FUNDING_STRATEGIES.has(this.name);
  }

  private adaptiveWorkerAction(
    state: CivilizationState,
  ): SimulationAction | null | undefined {
    if (!this.getAdaptiveWorkerFundingEnabled()) return undefined;
    const costs = this.getAdaptiveWorkerFundingCosts(state);
    if (!costs || costs.length === 0) return undefined;

    const fundingProgress = costs.map(({ resource, base }) => {
      const fraction = base.lte(ExpNumber.ZERO)
        ? 1
        : state.resources[resource].div(base).toNumber();
      return [resource, Math.floor(Math.max(0, Math.min(1, fraction)) * 20)];
    });
    const signature = JSON.stringify({
      costs: costs.map(({ resource, base }) => [resource, base.toString()]),
      buildings: state.builtBuildings,
      units: Object.fromEntries(
        Object.entries(state.unitCounts).map(([id, count]) => [
          id,
          count.toString(),
        ]),
      ),
      research: state.boughtResearch,
      battles: state.defeatedEncounters,
      ages: state.enteredAges,
      workforce: state.assignedWorkers + state.availableWorkers,
      workers: Object.fromEntries(
        (producerResourceKeys as ProductionResourceKey[]).map((resource) => [
          resource,
          state.workers[resource].toString(),
        ]),
      ),
      fundingProgress,
    });
    if (
      !this.adaptiveFundingRoute ||
      this.adaptiveFundingRoute.signature !== signature ||
      state.statistics.playTimeMs / 1000 -
        this.adaptiveFundingRoute.updatedAt >=
        30
    ) {
      const gameTime = state.statistics.playTimeMs / 1000;
      this.adaptiveFundingRoute = {
        signature,
        updatedAt: gameTime,
        route: getFastestFundingRoute(state, costs),
      };
    }

    const route = this.adaptiveFundingRoute.route;
    if (!route.building) return undefined;
    if (route.building && state.canBuild(route.building)) {
      return { type: "build", building: route.building, count: 1 };
    }
    if (route.focus) {
      const assignment = getWorkerAssignmentAction(state, route.focus);
      if (assignment) return assignment;
    }
    const resource = largestDeficitResource(state, route.costs);
    return resource ? { type: "gather", resource } : null;
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
    const adaptiveAction = this.adaptiveWorkerAction(state);
    if (adaptiveAction !== undefined) return adaptiveAction;

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
    const rebalanceThreshold = priorityResource
      ? 1
      : this.getWorkerRebalanceThreshold();
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

    if (priorityResource && available > 0) {
      if (!isResourceGatherable(state, priorityResource as ResourceKey)) {
        // Priority resource is not available, skip it
        priorityResource = undefined;
      } else {
        const current = Math.round(
          state.workers[priorityResource]?.toNumber() || 0,
        );
        const target = targets[priorityResource] || 0;
        const diff = target - current;
        if (diff >= rebalanceThreshold) {
          return {
            type: "assignWorker",
            resource: priorityResource,
            count: diff,
          };
        }
        if (diff <= -rebalanceThreshold) {
          return {
            type: "unassignWorker",
            resource: priorityResource,
            count: Math.abs(diff),
          };
        }
      }
    }

    let surplusResource: ProductionResourceKey | null = null;
    let surplus = 0;
    for (const resource of producerResourceKeys as ProductionResourceKey[]) {
      const current = Math.round(state.workers[resource]?.toNumber() || 0);
      const excess = current - (targets[resource] || 0);
      if (excess >= rebalanceThreshold && excess > surplus) {
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
      if (!isResourceGatherable(state, resource as ResourceKey)) continue;
      const current = Math.round(state.workers[resource]?.toNumber() || 0);
      const target = targets[resource] || 0;
      const diff = target - current;

      if (diff >= rebalanceThreshold && diff > bestDiff) {
        bestDiff = diff;
        bestResource = resource;
      }
    }

    if (available <= 0 || bestDiff < rebalanceThreshold) {
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
    context: SimulationContext,
  ): SimulationAction | null {
    const requiredAgeAction = this.getAgeTransitionAction(state);
    if (requiredAgeAction) return requiredAgeAction;

    const requiredBattleAction = this.getBattleLaunchAction(state);
    if (requiredBattleAction) return requiredBattleAction;

    const requiredPreparationAction = getRequiredBattlePreparationAction(state);
    if (requiredPreparationAction) {
      return this.focusWorkersForGather(
        state,
        requiredPreparationAction,
        context,
      );
    }

    const researchAction = this.getResearchAction(state);
    if (researchAction) return researchAction;

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
    if (routeAction) {
      return this.focusWorkersForGather(state, routeAction, context);
    }

    // Priority 2: Grow the army before attempting the next battle.
    const unitAction = this.getUnitAction(state);
    if (unitAction) return unitAction;

    // Priority 3: Buy affordable unlocked upgrades
    const upgradeAction = this.getBestUpgrade(state);
    if (upgradeAction) return upgradeAction;

    // Priority 5: Assign workers
    const workerAction = this.assignWorkersByRatio(
      state,
      this.getWorkerRatios(state),
      this.getGatherWorkerFocus(context),
    );
    if (workerAction) return workerAction;

    // Priority 6: Build buildings (try to build multiple if affordable)
    const building = this.findBestBuilding(state, this.getBuildingPriority());
    if (building) {
      // Check how many we can afford
      const maxAffordable = state.getMaxAffordableBuildings(building);
      if (maxAffordable > 0) {
        const count = maxAffordable;
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
      return this.focusWorkersForGather(
        state,
        { type: "gather", resource: "food" },
        context,
      );
    }
    // Priority 8.5: Gather for the highest-priority unaffordable building.
    // If we want a building but can't afford it, actively gather its missing resources.
    const priorityGather = this.findPriorityBuildingToGatherFor(
      state,
      this.getBuildingPriority(),
    );
    if (priorityGather) {
      return this.focusWorkersForGather(
        state,
        { type: "gather", resource: priorityGather },
        context,
      );
    }

    // Priority 9: Gather toward the advisor's next purchase, if it is reachable.
    // This sits below workers and buildings on purpose: gathering for a plan
    // blocked on infrastructure must never prevent building that infrastructure.
    const simulatorGather = this.getSimulatorGather(state);
    if (simulatorGather) {
      return this.focusWorkersForGather(state, simulatorGather, context);
    }

    // Priority 10: Gather resources
    const resourceToGather = this.getResourceToGather(state);
    if (resourceToGather) {
      return this.focusWorkersForGather(
        state,
        { type: "gather", resource: resourceToGather },
        context,
      );
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
      (key) => isResourceGatherable(state, key as ResourceKey),
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

  protected shouldLaunchBattle(_state: CivilizationState): boolean {
    return true;
  }

  protected getWorkerRatios(_state?: CivilizationState): WorkerRatios {
    return {
      food: 0.504,
      wood: 0.126,
      stone: 0.27,
      gold: 0.1,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  /**
   * `cheapest` deliberately ships NO age-1 override.
   *
   * The seed-save search loved a gold-heavy split for it (21995 s -> 15686 s on
   * the age-1 entry save), but that winner LOST end-to-end: 21944 s -> 24506 s
   * from a fresh start, i.e. 11.7 % SLOWER. Both runs reached age2 well inside
   * their horizons, so this is a real regression and not a truncated baseline.
   *
   * The lesson is about the method, not the strategy: a seed save freezes the
   * opening's leftover buildings, resources and research, so a split can be
   * optimal *given that frozen state* while being pessimal when the age-0 phase
   * is played for real and arrives with different leftovers. Cheapest is the
   * strategy most sensitive to this because it spends the opening on food for
   * citizens, so its age-1 entry state differs most from the seed's.
   *
   * The other seven strategies were all re-verified from a fresh start before
   * their overrides shipped; `cheapest` is the one that failed, so it keeps the
   * shipped split and waits for a re-search that measures the full run.
   */

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
      return this.focusWorkersForGather(
        state,
        requiredPreparationAction,
        context,
      );
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
    if (housingAction) {
      return this.focusWorkersForGather(state, housingAction, context);
    }

    const candidate = getCheapestPurchaseCandidate(state);
    if (candidate && isPurchaseAffordable(state, candidate)) {
      return withMaxAffordableCount(state, candidate);
    }

    const workerAction = this.assignWorkersByRatio(
      state,
      this.getWorkerRatios(state),
      this.getGatherWorkerFocus(context),
    );
    if (workerAction) return workerAction;

    if (remainingPlan) {
      const simulatorGather = getSimulatorGatherAction(state, remainingPlan);
      if (simulatorGather) {
        return this.focusWorkersForGather(state, simulatorGather, context);
      }
    }

    if (candidate) {
      const resource = gatherForPurchase(state, candidate);
      if (resource) {
        return this.focusWorkersForGather(
          state,
          { type: "gather", resource: resource as ProductionResourceKey },
          context,
        );
      }
    }

    const resourceToGather = this.getResourceToGather(state);
    return resourceToGather
      ? this.focusWorkersForGather(
          state,
          {
            type: "gather",
            resource: resourceToGather as ProductionResourceKey,
          },
          context,
        )
      : null;
  }
}

/**
 * Balanced strategy: equal focus on production and military.
 */
export class BalancedStrategy extends BaseStrategy {
  name = "balanced";
  description = "Balanced approach to production and military development";

  protected getWorkerRatios(state?: CivilizationState): WorkerRatios {
    // Searched on the `entered age1 -> entered age2` window from this
    // strategy's own shipped split (18290 s -> 13319 s, -27.2 %). The big move
    // is science: the opening's 0.2 share costs age 1 ~5000 s, because the
    // university already makes science passively and the age-1 gate is bought
    // with gold instead.
    if (state?.getCurrentAge()?.key === "age1") {
      return {
        food: 0.223,
        wood: 0.278,
        stone: 0.145,
        gold: 0.354,
        military: 0,
        science: 0,
        metalwork: 0,
        trade: 0,
      };
    }
    return {
      food: 0.248,
      wood: 0.31,
      stone: 0.162,
      gold: 0.08,
      military: 0,
      science: 0.2,
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

class PlayerOpeningStrategy extends BalancedStrategy {
  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    const action = super.decideAction(state, context);
    if (
      action?.type !== "buyResearch" ||
      state.defeatedEncounters.includes("age0_1_first_fire")
    ) {
      return action;
    }
    const resource =
      getRequiredBattleResourceToGather(state) ??
      this.getResourceToGather(state);
    return resource &&
      producerResourceKeys.includes(resource as ProductionResourceKey)
      ? this.focusWorkersForGather(state, { type: "gather", resource }, context)
      : null;
  }

  protected getResearchAction(
    state: CivilizationState,
  ): SimulationAction | null {
    return state.defeatedEncounters.includes("age0_1_first_fire")
      ? super.getResearchAction(state)
      : null;
  }

  protected getSimulatorActions(state: CivilizationState): SimulationAction[] {
    return state.defeatedEncounters.includes("age0_1_first_fire")
      ? super.getSimulatorActions(state)
      : getSimulatorUnitActions(state, getSimulatorBattlePlan(state));
  }

  protected getSimulatorGather(
    state: CivilizationState,
  ): SimulationAction | null {
    return state.defeatedEncounters.includes("age0_1_first_fire")
      ? super.getSimulatorGather(state)
      : null;
  }
}

class PlayerOpeningWoodStrategy extends PlayerOpeningStrategy {
  protected getWorkerRatios(state?: CivilizationState): WorkerRatios {
    if (state?.getCurrentAge()?.key === "age1") {
      return super.getWorkerRatios(state);
    }
    return {
      food: 0.3,
      wood: 0.4,
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
      { building: "house", weight: 9 },
      { building: "lumberYard", weight: 8 },
      { building: "quarry", weight: 7 },
      { building: "farm", weight: 6 },
      { building: "goldMine", weight: 5 },
      { building: "barracks", weight: 4, targetCount: 3 },
      { building: "university", weight: 3, targetCount: 3 },
      { building: "smithy", weight: 3, targetCount: 2 },
      { building: "townHall", weight: 2 },
    ];
  }
}

/**
 * Production-focused strategy: maximize resource generation.
 */
export class ProductionStrategy extends BaseStrategy {
  name = "production";
  description = "Focus on maximizing resource production, minimal military";

  protected getWorkerRatios(state?: CivilizationState): WorkerRatios {
    // Searched on the `entered age1 -> entered age2` window from this
    // strategy's own shipped split (18680 s -> 12545 s, -32.8 %, the largest
    // gain of any strategy). Same story as the others: age 1 is bought with
    // gold, so the opening's 0.2 science share is dead weight here.
    if (state?.getCurrentAge()?.key === "age1") {
      return {
        food: 0.307,
        wood: 0.198,
        stone: 0.142,
        gold: 0.353,
        military: 0,
        science: 0,
        metalwork: 0,
        trade: 0,
      };
    }
    return {
      food: 0.347,
      wood: 0.223,
      stone: 0.16,
      gold: 0.07,
      military: 0,
      science: 0.2,
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

  protected getWorkerRatios(state?: CivilizationState): WorkerRatios {
    // Searched on the `entered age1 -> entered age2` window from this
    // strategy's own shipped split (14299 s -> 12039 s, -15.8 %). Age 1 is
    // gated by battles and the Iron Age research line, and gold buys both the
    // units and the tech, so gold takes ~46 % here against the opening's 15 %.
    if (state?.getCurrentAge()?.key === "age1") {
      return {
        food: 0.241,
        wood: 0.126,
        stone: 0.172,
        gold: 0.46,
        military: 0,
        science: 0,
        metalwork: 0,
        trade: 0,
      };
    }
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

  protected getWorkerRebalanceThreshold(): number {
    return 10;
  }

  protected getWorkerRatios(state?: CivilizationState): WorkerRatios {
    // Searched on the `entered age1 -> entered age2` window from this
    // strategy's own shipped split (17268 s -> 12749 s, -26.2 %). The one
    // winner that keeps a science share: fast-age's whole job is to clear the
    // age's research line, so ~18 % science still pays here while every other
    // strategy dropped it to zero.
    if (state?.getCurrentAge()?.key === "age1") {
      return {
        food: 0.1,
        wood: 0.174,
        stone: 0.211,
        gold: 0.339,
        military: 0,
        science: 0.176,
        metalwork: 0,
        trade: 0,
      };
    }
    return {
      food: 0.263,
      wood: 0.198,
      stone: 0.24,
      gold: 0.099,
      military: 0,
      science: 0.2,
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

  protected getWorkerRatios(state?: CivilizationState): WorkerRatios {
    // Searched on the `entered age1 -> entered age2` window from this
    // strategy's own shipped split (23671 s -> 17892 s, -24.4 %). The biggest
    // surprise of the sweep: economy's opening spends 40 % on science and only
    // 6 % on gold, and in age 1 that is backwards — dropping science to zero
    // and going wood/food heavy is worth a quarter of the window.
    if (state?.getCurrentAge()?.key === "age1") {
      return {
        food: 0.333,
        wood: 0.46,
        stone: 0.107,
        gold: 0.1,
        military: 0,
        science: 0,
        metalwork: 0,
        trade: 0,
      };
    }
    return {
      food: 0.2,
      wood: 0.276,
      stone: 0.064,
      gold: 0.06,
      military: 0,
      science: 0.4,
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

/** Invest in the broad early research path before pushing the next battle. */
export class ResearchStrategy extends BaseStrategy {
  name = "research";
  description = "Prioritize early research and science infrastructure";
  private openingStrategy: SpeedrunStrategy | undefined;

  protected shouldFundResearch(state: CivilizationState): boolean {
    return (
      state.defeatedEncounters.includes("age0_1_first_fire") &&
      !hasCompletedCurrentAgeResearch(state)
    );
  }

  protected getAgeTransitionAction(
    state: CivilizationState,
  ): SimulationAction | null {
    return hasCompletedCurrentAgeResearch(state)
      ? super.getAgeTransitionAction(state)
      : null;
  }

  protected getResearchAction(
    state: CivilizationState,
  ): SimulationAction | null {
    if (hasCompletedCurrentAgeResearch(state)) return null;
    if (!state.defeatedEncounters.includes("age0_1_first_fire")) return null;
    const nextResearch = getDynamicResearchOrder(state, true).find(
      (researchId) => state.isResearchUnlocked(researchId),
    );
    if (!nextResearch || !state.canBuyResearch(nextResearch)) return null;
    return { type: "buyResearch", researchId: nextResearch };
  }

  /**
   * Age-1 split, searched on the `entered age1 -> entered age2` window.
   *
   * The age-aware getter pins this split for age 1 and uses the dynamic
   * research dial in other ages.
   *
   * Measured from the age-1 entry save, 25 000 s cap: 15 740 s -> 12 147 s
   * (-22.8 %), reproduced exactly in an independent process. Gold rises from
   * 0.10 to 0.49, matching every other strategy's optimum on this window.
   */
  protected getWorkerRatios(state?: CivilizationState): WorkerRatios {
    // Searched on the `entered age1 -> entered age2` window from this
    // strategy's own shipped split (15740 s -> 12147 s, -22.8 %).
    //
    // Keep the searched age-1 starting split in the same state-aware resolver
    // as the research dial used in other ages.
    if (state?.getCurrentAge()?.key === "age1") {
      return {
        food: 0.18,
        wood: 0.08,
        stone: 0.253,
        gold: 0.487,
        military: 0,
        science: 0,
        metalwork: 0,
        trade: 0,
      };
    }
    return state
      ? this.getResearchWorkerRatios(state)
      : super.getWorkerRatios(state);
  }

  protected getResearchWorkerRatios(state: CivilizationState): WorkerRatios {
    return hasCompletedCurrentAgeResearch(state)
      ? {
          food: 0.6,
          wood: 0.2,
          stone: 0.1,
          gold: 0.1,
          military: 0,
          science: 0,
          metalwork: 0,
          trade: 0,
        }
      : {
          food: 0.3,
          wood: 0.15,
          stone: 0.15,
          gold: 0.05,
          military: 0.05,
          science: 0.3,
          metalwork: 0,
          trade: 0,
        };
  }

  protected getSimulatorActions(state: CivilizationState): SimulationAction[] {
    if (!hasCompletedCurrentAgeResearch(state)) {
      return super.getSimulatorActions(state);
    }
    return getSimulatorUnitActions(state, getSimulatorBattlePlan(state));
  }

  protected getSimulatorGather(
    state: CivilizationState,
  ): SimulationAction | null {
    return hasCompletedCurrentAgeResearch(state)
      ? null
      : super.getSimulatorGather(state);
  }

  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    if (!state.defeatedEncounters.includes("age0_1_first_fire")) {
      this.openingStrategy ??= new SpeedrunStrategy();
      return this.openingStrategy.decideAction(state, context);
    }

    const requiredAgeAction = this.getAgeTransitionAction(state);
    if (requiredAgeAction) return requiredAgeAction;

    const requiredBattleAction = this.getBattleLaunchAction(state);
    if (requiredBattleAction) return requiredBattleAction;

    const requiredPreparationAction = getRequiredBattlePreparationAction(state);
    if (requiredPreparationAction) {
      return this.focusWorkersForGather(
        state,
        requiredPreparationAction,
        context,
      );
    }

    const researchAction = this.getResearchAction(state);
    if (researchAction) return researchAction;

    if (
      !hasCompletedCurrentAgeResearch(state) &&
      state.defeatedEncounters.includes("age0_1_first_fire") &&
      state.getBuildingCount("university") < 2 &&
      state.canBuild("university")
    ) {
      const affordable = state.getMaxAffordableBuildings("university");
      const remaining = 2 - state.getBuildingCount("university");
      if (affordable > 0) {
        return {
          type: "build",
          building: "university",
          count: Math.min(affordable, remaining),
        };
      }
    }

    return super.decideAction(state, context);
  }
}

/** Uses the faster research order from the historical v4 Age-1 save. */
export class PlayerStrategy extends ResearchStrategy {
  name = "player";
  description = "Follow the fastest save-derived Age-1 research and opening";
  protected playerOpeningStrategy = new PlayerOpeningWoodStrategy();

  protected getOpeningBarracksTarget(): number {
    return 1;
  }

  /**
   * Age-1 split, searched on the `entered age1 -> entered age2` window.
   *
   * Overrides `ResearchStrategy`'s own override: `player` follows a save-derived
   * opening and its wood-driven start means its optimum is *not* research's.
   * Leaving this out would silently hand `player` the `research` numbers.
   *
   * Measured from the age-1 entry save, 25 000 s cap: 11 115 s -> 7 540 s
   * (-32.2 %), reproduced exactly in an independent process. It keeps far more
   * wood than any other strategy (0.197) because its opening is wood-gated,
   * while food drops to 0.088 — the largest food cut measured.
   */
  protected getWorkerRatios(state?: CivilizationState): WorkerRatios {
    // Searched on the `entered age1 -> entered age2` window from this
    // strategy's own shipped split (11115 s -> 7540 s, -32.2 %, the second
    // largest gain). This class overrides the same seam for the same reason as
    // `ResearchStrategy` — see the note there.
    if (state?.getCurrentAge()?.key === "age1") {
      return {
        food: 0.088,
        wood: 0.197,
        stone: 0.25,
        gold: 0.465,
        military: 0,
        science: 0,
        metalwork: 0,
        trade: 0,
      };
    }
    if (state?.getCurrentAge()?.key === "age2") {
      const researchAffordable = state.hasResourcesForResearch();
      const scienceShare = researchAffordable ? 0.05 : 0.5;
      const rest = 1 - scienceShare;
      return {
        food: rest * 0.4,
        wood: rest * 0.25,
        stone: rest * 0.2,
        gold: rest * 0.15,
        military: 0,
        science: scienceShare,
        metalwork: 0,
        trade: 0,
      };
    }
    return super.getWorkerRatios(state);
  }

  protected getResearchAction(
    state: CivilizationState,
  ): SimulationAction | null {
    if (!state.defeatedEncounters.includes("age0_1_first_fire")) return null;
    if (
      state.isResearchBought("pottery") &&
      state.population.lt(ExpNumber.fromNumber(200))
    ) {
      return null;
    }
    const nextResearch = this.getPlayerResearchOrder(state).find(
      (researchId) =>
        state.isResearchUnlocked(researchId) &&
        !state.isResearchBought(researchId),
    );
    if (!nextResearch || !state.canBuyResearch(nextResearch)) return null;
    return { type: "buyResearch", researchId: nextResearch };
  }

  protected getPlayerResearchOrder(
    state?: CivilizationState,
  ): readonly string[] {
    const currentAge = state?.getCurrentAge();
    const currentAgeIndex = currentAge
      ? ageDefinitions.findIndex(({ key }) => key === currentAge.key)
      : 0;
    return (
      getRecordedPlayerResearchOrder(currentAgeIndex) ??
      (state ? getDynamicResearchOrder(state, true) : [])
    );
  }

  private isResearchPaused(state: CivilizationState): boolean {
    return (
      !state.defeatedEncounters.includes("age0_1_first_fire") ||
      (state.isResearchBought("pottery") &&
        state.population.lt(ExpNumber.fromNumber(200)))
    );
  }

  protected shouldFundResearch(state: CivilizationState): boolean {
    return (
      state.defeatedEncounters.includes("age0_1_first_fire") &&
      !this.isResearchPaused(state)
    );
  }

  protected getSimulatorActions(state: CivilizationState): SimulationAction[] {
    return getSimulatorUnitActions(state, getSimulatorBattlePlan(state));
  }

  protected getSimulatorGather(
    state: CivilizationState,
  ): SimulationAction | null {
    return this.isResearchPaused(state)
      ? null
      : super.getSimulatorGather(state);
  }

  protected getResearchWorkerRatios(state: CivilizationState): WorkerRatios {
    const researchComplete = hasCompletedPlayerResearch(state);
    // Searched over food x science x metalwork x military (this path ignores any
    // static ratio, so `getResearchWorkerRatios` is the only dial that reaches
    // `player`). Two changes from the hand-authored values, both measured:
    //   food 0.15 -> 0.08   -119 s
    //   metalwork 0.174 -> 0, i.e. never staff metalwork
    // The smithy share was the larger of the two. A smithy produces 1 metalwork/s,
    // so a sixth of the workforce sat on a resource the settlement cannot spend
    // fast enough to matter, while food is the binding constraint on the build
    // ladder that reaches the age gate. Dropping metalwork and moving that share
    // into the food tail is worth ~100 s on its own.
    return {
      food: 0.08,
      wood: 0.14,
      stone: 0.105,
      gold: 0.025,
      military: 0.025,
      science: researchComplete ? 0 : 0.5,
      metalwork: 0,
      trade: 0,
    };
  }

  protected focusWorkersForGather(
    state: CivilizationState,
    action: SimulationAction,
    _context: SimulationContext,
  ): SimulationAction {
    return action.type === "gather"
      ? (this.assignWorkersByRatio(state, this.getWorkerRatios(state)) ??
          action)
      : action;
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9, targetCount: 100 },
      { building: "farm", weight: 8, targetCount: 100 },
      { building: "lumberYard", weight: 7, targetCount: 100 },
      { building: "quarry", weight: 6, targetCount: 100 },
      { building: "goldMine", weight: 5, targetCount: 100 },
      { building: "barracks", weight: 4, targetCount: 40 },
      { building: "university", weight: 4, targetCount: 40 },
      { building: "smithy", weight: 4, targetCount: 40 },
      { building: "townHall", weight: 3, targetCount: 10 },
    ];
  }

  private getHousingAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    const targetPopulation = getAgeRouteTargetPopulation(state);
    if (
      targetPopulation <= 0 ||
      state.population.gte(ExpNumber.fromNumber(targetPopulation)) ||
      state.population.lt(state.maximumPopulation.floor())
    ) {
      return null;
    }

    const housingBuilding =
      state.getBuildFailureReason("house") === "capacity"
        ? "townHall"
        : "house";
    if (state.canBuild(housingBuilding)) {
      return {
        type: "build",
        building: housingBuilding,
        count: Math.max(1, state.getMaxAffordableBuildings(housingBuilding)),
      };
    }

    const costs = state.getBuildingCost(
      housingBuilding,
      state.getBuildingCount(housingBuilding),
      1,
    );
    const missing = costs
      .filter(({ resource, base }) => state.resources[resource].lt(base))
      .filter(({ resource }) =>
        isResourceGatherable(state, resource as ResourceKey),
      )
      .sort((left, right) => {
        const leftDeficit = left.base.sub(state.resources[left.resource]);
        const rightDeficit = right.base.sub(state.resources[right.resource]);
        return rightDeficit.compareTo(leftDeficit);
      })[0];
    if (!missing) return null;
    return this.focusWorkersForGather(
      state,
      { type: "gather", resource: missing.resource as ProductionResourceKey },
      context,
    );
  }

  private hasCompletedAgeTwoEconomyTargets(state: CivilizationState): boolean {
    const productionComplete = ageTwoProductionTargets.every((building) => {
      const targetUpgrade = upgradeDefinitions.find(
        ({ unlock }) =>
          unlock.building === building &&
          unlock.threshold === ageTwoProductionTargetCount,
      );
      return (
        state.getBuildingCount(building) >= ageTwoProductionTargetCount &&
        (!targetUpgrade || state.isUpgradeBought(targetUpgrade.key))
      );
    });
    const infrastructureComplete =
      state.getBuildingCount(ageTwoTownHallTarget.building) >=
        ageTwoTownHallTarget.targetCount &&
      ageTwoRequiredInfrastructureTargets.every(
        ({ building, targetCount }) =>
          state.getBuildingCount(building) >= targetCount,
      );
    return productionComplete && infrastructureComplete;
  }

  private getProductionUpgradeAction(
    state: CivilizationState,
    building: BuildingKey,
    context: SimulationContext,
  ): SimulationAction | null {
    const buildingCount = state.getBuildingCount(building);
    const nextUpgrade = upgradeDefinitions.find(
      ({ key, unlock }) =>
        unlock.building === building &&
        unlock.threshold <= ageTwoProductionTargetCount &&
        unlock.threshold <= buildingCount &&
        !state.isUpgradeBought(key),
    );
    if (!nextUpgrade) return null;

    const failure = state.getUpgradeFailureReason(nextUpgrade.key);
    if (failure === "locked") return null;
    if (failure === null) {
      return { type: "buyUpgrade", upgradeId: nextUpgrade.key };
    }

    const missing = state
      .getUpgradeCost(nextUpgrade.key)
      .filter(({ resource, base }) => state.resources[resource].lt(base))
      .filter(
        ({ resource }) =>
          producerResourceKeys.includes(resource as ProductionResourceKey) &&
          isResourceGatherable(state, resource),
      )
      .sort((left, right) => {
        const leftDeficit = left.base.sub(state.resources[left.resource]);
        const rightDeficit = right.base.sub(state.resources[right.resource]);
        return rightDeficit.compareTo(leftDeficit);
      })[0];
    return missing
      ? this.focusWorkersForGather(
          state,
          {
            type: "gather",
            resource: missing.resource as ProductionResourceKey,
          },
          context,
        )
      : null;
  }

  protected getAgeTwoProductionAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    if (state.getCurrentAge()?.key !== "age2") return null;

    const housingAction = getAgeRouteGrowthAction(state);
    if (housingAction) {
      return this.focusWorkersForGather(state, housingAction, context);
    }

    let deferredEconomyAction: SimulationAction | null = null;
    const townHallAction = this.getBuildingTargetAction(
      state,
      ageTwoTownHallTarget.building,
      ageTwoTownHallTarget.targetCount,
      context,
    );
    if (townHallAction) {
      if (townHallAction.type === "build") return townHallAction;
      deferredEconomyAction = townHallAction;
    }

    // Build university first: age-2 research is priced in science, and without
    // enough science production the strategy can never buy the techs that unlock
    // age-2 units.
    for (const {
      building,
      targetCount,
    } of ageTwoRequiredInfrastructureTargets) {
      const infrastructureAction = this.getBuildingTargetAction(
        state,
        building,
        targetCount,
        context,
      );
      if (infrastructureAction) {
        if (infrastructureAction.type === "build") return infrastructureAction;
        deferredEconomyAction ??= infrastructureAction;
      }
    }

    for (const building of ageTwoProductionTargets) {
      const upgradeAction = this.getProductionUpgradeAction(
        state,
        building,
        context,
      );
      if (upgradeAction) {
        if (upgradeAction.type === "buyUpgrade") return upgradeAction;
        deferredEconomyAction ??= upgradeAction;
      }

      if (state.getBuildingCount(building) < ageTwoProductionTargetCount) {
        const buildingAction = this.getBuildingTargetAction(
          state,
          building,
          ageTwoProductionTargetCount,
          context,
        );
        if (buildingAction) {
          if (buildingAction.type === "build") return buildingAction;
          deferredEconomyAction ??= buildingAction;
        }
      }
    }

    for (const {
      building,
      targetCount,
    } of ageTwoOptionalInfrastructureTargets) {
      const infrastructureAction = this.getBuildingTargetAction(
        state,
        building,
        targetCount,
        context,
      );
      if (infrastructureAction) {
        if (infrastructureAction.type === "build") return infrastructureAction;
        deferredEconomyAction ??= infrastructureAction;
      }
    }

    if (this.hasCompletedAgeTwoEconomyTargets(state)) return null;
    return (
      deferredEconomyAction ??
      this.focusWorkersForGather(
        state,
        { type: "gather", resource: "food" },
        context,
      )
    );
  }

  private getBattleTwoInfrastructureAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    if (state.defeatedEncounters.includes("age0_2_wolf_pack")) return null;

    const barracksAction = this.getBuildingTargetAction(
      state,
      "barracks",
      3,
      context,
    );
    if (barracksAction) return barracksAction;

    return this.getBuildingTargetAction(state, "university", 2, context);
  }

  private getBuildingTargetAction(
    state: CivilizationState,
    building: BuildingKey,
    targetCount: number,
    context: SimulationContext,
  ): SimulationAction | null {
    const currentCount = state.getBuildingCount(building);
    if (currentCount >= targetCount) return null;

    if (state.canBuild(building)) {
      const affordable = state.getMaxAffordableBuildings(building);
      if (affordable > 0) {
        return {
          type: "build",
          building,
          count: Math.min(affordable, targetCount - currentCount),
        };
      }
    }
    if (state.getBuildFailureReason(building) !== "resources") return null;

    const missing = state
      .getBuildingCost(building, currentCount, 1)
      .filter(({ resource, base }) => state.resources[resource].lt(base))
      .filter(({ resource }) =>
        isResourceGatherable(state, resource as ResourceKey),
      )
      .sort((left, right) => {
        const leftDeficit = left.base.sub(state.resources[left.resource]);
        const rightDeficit = right.base.sub(state.resources[right.resource]);
        return rightDeficit.compareTo(leftDeficit);
      })[0];
    return missing
      ? this.focusWorkersForGather(
          state,
          {
            type: "gather",
            resource: missing.resource as ProductionResourceKey,
          },
          context,
        )
      : null;
  }

  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    if (!state.defeatedEncounters.includes("age0_1_first_fire")) {
      const openingBarracksTarget = this.getOpeningBarracksTarget();
      if (
        openingBarracksTarget > 0 &&
        state.population.gte(ExpNumber.fromNumber(90))
      ) {
        const barracksAction = this.getBuildingTargetAction(
          state,
          "barracks",
          openingBarracksTarget,
          context,
        );
        if (barracksAction) return barracksAction;
      }
      return this.playerOpeningStrategy.decideAction(state, context);
    }

    if (hasCompletedPlayerResearch(state)) {
      const workerAction = this.assignWorkersByRatio(
        state,
        this.getWorkerRatios(state),
      );
      if (workerAction) return workerAction;
    }

    // In age 2, buy research and upgrades before building economy: age-2
    // research unlocks the units the battle simulator needs, and upgrades boost
    // production so research becomes affordable sooner.
    if (state.getCurrentAge()?.key === "age2") {
      // Adaptive worker allocation based on next objective.
      const nextBattle = state.getNextBattle();
      const hasAge2Units = state
        .getRosterUnits()
        .some((unit) => unit.age === 2 && state.isUnitAvailable(unit.key));

      let scienceShare = 0.05;
      let militaryShare = 0;
      let metalworkShare = 0;
      let tradeShare = 0;

      if (!state.hasResourcesForResearch()) {
        // 50% science, 50% economy: balances research speed and economy building.
        scienceShare = 0.5;
      } else if (nextBattle && hasAge2Units) {
        // Battle pending and units unlocked → check if we can win.
        const plan = getSimulatorBattlePlan(state);
        if (plan) {
          // Need to buy units → allocate to military/metalwork.
          militaryShare = 0.3;
          metalworkShare = 0.2;
        }
      } else {
        // Economy building phase → allocate to food/wood/stone/gold.
        scienceShare = 0.1;
      }

      // Check if any wonder is unlocked and affordable.
      const affordableWonders = upgradeDefinitions.filter(
        (u) =>
          u.key.startsWith("wonder_a2") &&
          !state.isUpgradeBought(u.key) &&
          state.isUpgradeUnlocked(u.key) &&
          state.hasResourcesForUpgrade(u.key),
      );
      if (affordableWonders.length > 0) {
        tradeShare = 0.3;
      }

      const rest = Math.max(
        0.05,
        1 - scienceShare - militaryShare - metalworkShare - tradeShare,
      );
      const workerAction = this.assignWorkersByRatio(state, {
        food: rest * 0.35,
        wood: rest * 0.25,
        stone: rest * 0.25,
        gold: rest * 0.15,
        military: militaryShare,
        science: scienceShare,
        metalwork: metalworkShare,
        trade: tradeShare,
      });
      if (workerAction) return workerAction;

      // After battle 8, build economy before research if university count < 600.
      const battle8Won = state.defeatedEncounters.includes("age2_1_marathon");
      if (battle8Won) {
        const uniCount = state.getBuildingCount("university");
        if (uniCount < 600) {
          const ageTwoProductionAction = this.getAgeTwoProductionAction(
            state,
            context,
          );
          if (ageTwoProductionAction) return ageTwoProductionAction;
        }
      }
      const battle9Ready = state.defeatedEncounters.includes("age2_1_marathon") &&
        state.isResearchBought("martial_drill") &&
        state.isResearchBought("subterfuge");

      // After martial_drill + subterfuge, prioritize units and battle 9.
      if (battle9Ready) {
        const hasAge2Units = state
          .getRosterUnits()
          .some((unit) => unit.age === 2 && state.isUnitAvailable(unit.key));
        if (hasAge2Units) {
          const simulatorAction = this.getSimulatorActions(state)[0];
          if (simulatorAction) return simulatorAction;
          const battleAction = this.getBattleLaunchAction(state);
          if (battleAction) return battleAction;
        }
      }

      // Buy affordable enhancer upgrades first (boosts production).
      for (const building of [
        "farm",
        "lumberYard",
        "quarry",
        "goldMine",
        "barracks",
        "university",
        "smithy",
        "market",
      ] as BuildingKey[]) {
        const upgradeAction = this.getProductionUpgradeAction(
          state,
          building,
          context,
        );
        if (upgradeAction?.type === "buyUpgrade") return upgradeAction;
      }
      // After battle 8, build economy before buying research.
      const battle8Won2 = state.defeatedEncounters.includes("age2_1_marathon");
      if (battle8Won2) {
        const uniCount = state.getBuildingCount("university");
        if (uniCount < 600) {
          const ageTwoProductionAction = this.getAgeTwoProductionAction(
            state,
            context,
          );
          if (ageTwoProductionAction) return ageTwoProductionAction;
        }
      }
      const researchAction = this.getResearchAction(state);
      if (researchAction) return researchAction;
      // Only buy units if age-2 units are actually unlocked (research done).
      if (hasAge2Units) {
        const simulatorAction = this.getSimulatorActions(state)[0];
        if (simulatorAction) return simulatorAction;
        const battleAction = this.getBattleLaunchAction(state);
        if (battleAction) return battleAction;
      }
    }

    const ageTwoProductionAction = this.getAgeTwoProductionAction(
      state,
      context,
    );
    if (ageTwoProductionAction) return ageTwoProductionAction;

    const ageAction = this.getAgeTransitionAction(state);
    if (ageAction) return ageAction;

    const battleAction = this.getBattleLaunchAction(state);
    if (battleAction) return battleAction;

    const preparationAction = getRequiredBattlePreparationAction(state);
    if (preparationAction) {
      return this.focusWorkersForGather(state, preparationAction, context);
    }

    const simulatorAction = this.getSimulatorActions(state)[0];
    if (simulatorAction) return simulatorAction;

    const infrastructureAction = this.getBattleTwoInfrastructureAction(
      state,
      context,
    );
    if (infrastructureAction) return infrastructureAction;

    const researchAction = this.getResearchAction(state);
    if (researchAction) return researchAction;

    const housingAction = this.getHousingAction(state, context);
    if (housingAction) return housingAction;

    const universityCount = state.getBuildingCount("university");
    if (universityCount < 40 && state.canBuild("university")) {
      const affordable = state.getMaxAffordableBuildings("university");
      if (affordable > 0) {
        return {
          type: "build",
          building: "university",
          count: Math.min(affordable, 40 - universityCount),
        };
      }
    }

    return super.decideAction(state, context);
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

  protected getWorkerRatios(_state?: CivilizationState): WorkerRatios {
    return {
      food: 0.225,
      wood: 0.322,
      stone: 0.303,
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
 * `player` with the research pause removed.
 *
 * ## Why this exists
 *
 * `PlayerStrategy` withholds research until First Fire is won *and* pottery is
 * bought with population at 200. Measured on the current engine (the one where
 * `assignWorker` is gated by `isResourceGatherable`, so science workers do
 * nothing until a university exists), the science share is a large lever and it
 * peaks at 0.5:
 *
 *   science share | no pause
 *   ------------- | --------
 *   0             | 2988 s
 *   0.25          | 2352 s
 *   0.5           | 2169 s
 *   0.7           | 2308 s
 *
 * The pause was measured on the *previous* engine, before `assignWorker` was
 * gated, and it was a small net negative there: "no pause" and "pause until
 * First Fire" came out identical in every science row, because First Fire lands
 * early enough that the gate rarely binds, while the extra `pop200` condition
 * cost time. That comparison has **not** been re-run on the current engine, so
 * treat the size of the gain as unverified; the direction is what motivated this
 * subclass, and the "no pause" column above is current-engine data.
 *
 * This subclass removed only the pause and inherited everything else — the
 * research order, the science-heavy worker ratios, the opening, the building
 * plan — so a `player` vs `unpaused` comparison would have isolated exactly one
 * variable. **It was built, measured, and then deleted.** On the current engine
 * it arrives at 2147 s, bit-identical to `player`: the pause is inert. Fixing
 * `assignWorker` to respect `isResourceGatherable` gated science workers behind
 * the university, which unlocks on First Fire — so the engine now enforces the
 * ordering the pause was hand-enforcing. The finding that *was* real on the
 * previous engine does not survive the fix, and a strategy that duplicates
 * `player` is worse than no strategy.
 *
 * The measurement worth keeping from all of this is the science share itself,
 * which is a large lever and is already at its optimum here: 0 -> 2988 s,
 * 0.25 -> 2352 s, 0.5 -> 2169 s, 0.7 -> 2308 s (peak at 0.5, current engine).
 */

/**
 * ROI-first speedrun strategy. Required campaign actions remain authoritative;
 * otherwise it asks the shared ROI evaluator for the best time-adjusted buy.
 */
export class SpeedrunStrategy extends BaseStrategy {
  name = "speedrun";
  description = "Buy the best time-adjusted ROI purchase for fast progression";
  /**
   * This strategy's valuation profile, applied only to its own ROI calls.
   *
   * The evaluator's weights are a shared objective function, so tuning them in
   * place re-ranks every strategy at once — measured in
   * `docs/age1-optimization.md` §11, where raising the shared `military` weight
   * cost six other strategies 3–7 minutes each. Overriding the profile here keeps
   * the dial local: `military` is raised so a recruit competes with research on
   * equal terms, instead of losing to it by two orders of magnitude. Unspecified
   * keys inherit the shared defaults.
   *
   * Only `military` is raised. Pulling `researchTime` down as well was measured
   * too, and it is a trap: `military: 100, researchTime: 8` left all nine other
   * strategies bit-identical (confirming the override really is local) but made
   * `speedrun` stop completing the age at all — it builds an army and never
   * researches the units that army needs. The tech line is load-bearing.
   */
  protected readonly metricWeights: Partial<RoiMetricWeights> = {
    military: 12,
    researchTime: 8,
    campaignTime: 8,
  };

  /**
   * How this strategy measures a purchase's military value.
   *
   * `"threatClosure"` scores a recruit by the fraction of the shortfall to the
   * pending enemy it closes, rather than by the change in `log10` of army power.
   * The default is the wrong shape for a stockpile being filled toward a fixed
   * enemy: 3812 → 5000 is a 31% gain but 0.12 of a decade, so each incremental
   * recruit scored ~0.1 and this strategy stopped recruiting altogether — the
   * army froze at 46 warriors for 3000 seconds of the age.
   *
   * `metricWeights.military` alone does *not* fix it (measured: 7448 s, worse
   * than the 6531 s baseline). The metric shape is what matters; the weight only
   * scales a signal that was already wrong.
   */
  protected readonly militaryMetric: RoiMilitaryMetric = "threatClosure";
  private roiGatherFocus:
    | {
        readonly resource: ProductionResourceKey;
        readonly until: number;
        readonly snapshots: SimulationContext["snapshots"];
      }
    | undefined;

  /**
   * Worker split derived from whatever is currently blocking progress, instead
   * of a hardcoded table.
   *
   * This is the whole point of the strategy. The previous version hardcoded
   * `science: 0.05` alongside a hand-picked food/wood/stone/gold mix, and
   * measured 8243 s — eighth of ten. The science share is the single largest
   * lever in the economy (0 -> 2988 s, 0.25 -> 2352 s, 0.5 -> 2169 s,
   * 0.7 -> 2308 s), and hardcoding it meant the strategy was pinned to whatever
   * the balance happened to be on the day it was written. It also could not
   * survive a rebalance, which is the failure mode that matters most.
   *
   * The principle instead — *longest pole gets the workers*:
   *
   *   1. collect the resources the next few purchases need (the remaining army
   *      for the next battle, the next tech, the next building);
   *   2. for each resource compute how long it would take to afford, i.e.
   *      `deficit / rate`, using the engine's own `computeResourceRate`;
   *   3. give each resource a share proportional to that time.
   *
   * The resource that blocks longest therefore attracts labour automatically.
   * There are no content ids in this method: every number comes from live
   * state, so it holds at age 1 and after any cost or multiplier change.
   */
  private deriveWorkerRatios(state: CivilizationState): WorkerRatios {
    const deficit = new Map<ProductionResourceKey, number>();

    /** Add a cost entry to the running demand for its resource. */
    const demand = (resource: string, base: ExpNumber): void => {
      const key = resource as ProductionResourceKey;
      if (!producerResourceKeys.includes(key)) return;
      const value = base.toNumber();
      if (!Number.isFinite(value)) return;
      deficit.set(key, (deficit.get(key) ?? 0) + value);
    };

    // The army the battle plan still needs.
    const plan = getSimulatorBattlePlan(state);
    if (plan) {
      for (const [unitId, count] of plan.composition) {
        if (count <= 0 || !state.isUnitAvailable(unitId)) continue;
        for (const { resource, base } of state.getUnitCost(unitId, count)) {
          demand(resource, base);
        }
      }
      for (const { resource, base } of plan.research.costs) {
        demand(resource, base);
      }
    }

    // The next tech, and the next building the route is waiting on.
    for (const { resource, base } of state.getResearchNextCost()) {
      demand(resource, base);
    }
    const populationTarget = getAgeRouteTargetPopulation(state);
    if (populationTarget > 0) {
      for (const { resource, base } of state.getBuildingCost(
        "people",
        state.getBuildingCount("people"),
        1,
      )) {
        demand(resource, base);
      }
    }

    // Time-to-afford per resource: the longer a resource blocks, the more of
    // the workforce it earns. Resources with nothing pending fall to a floor so
    // they are not abandoned entirely (they still drain upkeep and fund the
    // next purchase once demand shifts).
    const blocking = new Map<ProductionResourceKey, number>();
    // `producerResourceKeys` is typed as ResourceKey[]; the worker map and the
    // demand map are keyed by the narrower ProductionResourceKey, so narrow once.
    const gatherableKeys = producerResourceKeys as ProductionResourceKey[];
    let totalBlocking = 0;
    for (const [resource, need] of deficit) {
      const rate = state.computeResourceRate(resource).toNumber();
      const shortfall = Math.max(
        0,
        need - state.resources[resource].toNumber(),
      );
      // A resource already in surplus blocks for zero seconds.
      const seconds =
        rate > 0 ? shortfall / rate : shortfall > 0 ? Infinity : 0;
      const weight = Number.isFinite(seconds) ? seconds : 1e12;
      blocking.set(resource, weight);
      totalBlocking += weight;
    }

    const ratios: WorkerRatios = {
      food: 0,
      wood: 0,
      stone: 0,
      gold: 0,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
    if (totalBlocking <= 0) {
      // Nothing is pending (e.g. research complete and no battle due): fall back
      // to food, which is the resource every citizen drains.
      ratios.food = 1;
      return ratios;
    }
    for (const key of gatherableKeys) {
      if (!state.isResourceGatherable(key)) continue;
      ratios[key] = (blocking.get(key) ?? 0) / totalBlocking;
    }
    // Normalise over the resources that can actually take a worker.
    let assigned = 0;
    for (const key of gatherableKeys) {
      if (state.isResourceGatherable(key)) assigned += ratios[key];
    }
    if (assigned > 0) {
      for (const key of gatherableKeys) {
        ratios[key] /= assigned;
      }
    } else {
      ratios.food = 1;
    }
    return ratios;
  }

  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    const roiAction = getBestRoiAction(state, {
      // Units are evaluated as standalone purchases too. With `includeUnits`
      // off the evaluator can see the army a battle needs but never issues the
      // recruit itself, so the run reaches the 1500-building target and then
      // spends the remainder of the age fighting battles it never armed for.
      includeUnits: true,
      populationTarget: getAgeRouteTargetPopulation(state),
      metricWeights: this.metricWeights,
      militaryMetric: this.militaryMetric,
      planBattle: (battleState, battleId) =>
        planBattleForRoi(
          battleState,
          battleId,
          this.getCachedSimulatorPlan(battleState, context),
        ),
    });
    if (roiAction && roiAction.type !== "gather") {
      this.roiGatherFocus = undefined;
      return roiAction;
    }

    const previousFocus = this.roiGatherFocus;
    const focusIsCurrent =
      previousFocus?.snapshots === context.snapshots &&
      context.gameTime < previousFocus.until;
    const resource = focusIsCurrent
      ? previousFocus.resource
      : roiAction?.type === "gather"
        ? (roiAction.resource as ProductionResourceKey)
        : null;
    if (resource) {
      this.roiGatherFocus = {
        resource,
        until: context.gameTime + 1,
        snapshots: context.snapshots,
      };
      const focusedAction = this.focusWorkersForGather(
        state,
        {
          type: "gather",
          resource,
        },
        context,
      );
      return focusedAction;
    }
    this.roiGatherFocus = undefined;

    // NOTE: an "army reserve" (recruit toward N x the minimum winning army) was
    // tried here and removed. It is the obvious fix for the army freezing at 46
    // warriors for fifty minutes, and it does not work at this layer:
    //   - run BEFORE the ROI evaluator, it never yields — the settlement spends
    //     everything on recruits, never researches, never unlocks the bronze
    //     units, and stalls at the second battle (measured: never reaches the
    //     Iron Age, at both a 2x and a 1.5x reserve);
    //   - run HERE, it never fires — the evaluator always has some cheaper
    //     purchase queued, so the fallback is unreachable (7751 s either way).
    // The stall is not a "buy more soldiers" problem; the minimum-army plan is
    // simply empty once satisfied, so army growth has to be *valued inside* the
    // evaluator's own benefit metric, not appended to its output.
    const workerAction = this.assignWorkersByRatio(
      state,
      this.deriveWorkerRatios(state),
    );
    if (workerAction) return workerAction;

    const resourceToGather = this.getResourceToGather(state);
    return resourceToGather
      ? { type: "gather", resource: resourceToGather }
      : null;
  }
}

/**
 * Follow an explicit per-age objective plan, funding whatever is first and
 * unfinished from that objective's own cost set.
 */
export class ObjectiveStrategy implements SimulationStrategy {
  name = "objective";
  description =
    "Follow an explicit per-age objective plan and fund each one from its own cost set";

  private focus:
    | { signature: string; updatedAt: number; focus: WorkerFocus | null }
    | undefined;

  // Once the plan is finished the settlement keeps playing under a generic
  // strategy rather than freezing on the idle tail. A fresh instance, not the
  // registry singleton — see the note on `strategyRegistry` about per-run state.
  private readonly fallback = new BalancedStrategy();
  private planCompleteAnnounced = false;

  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    const ageAction = getRequiredAgeAction(state);
    if (ageAction) return ageAction;

    const objective = currentObjective(state);
    if (!objective) {
      // The plan is finished. Hand off to the generic strategy so the
      // settlement keeps growing, and say so loudly once — everything logged
      // after this banner is generic play, not the authored objective plan.
      this.announcePlanComplete();
      return this.fallback.decideAction(state, context);
    }

    const purchase = objective.purchase(state);
    if (purchase) return purchase;

    const launch = getRequiredBattleAction(state);
    if (launch) return launch;

    // Buy science-boosting research (writing, etc.) only for population objectives, not battles
    if (objective.id.startsWith("pop")) {
      const boughtResearch = new Set(state.boughtResearch);
      const currentAge = state.getCurrentAge();
      const currentAgeIndex = currentAge
        ? ageDefinitions.findIndex(({ key }) => key === currentAge.key)
        : -1;

      for (const research of researchDefinitions) {
        if (boughtResearch.has(research.key)) continue;
        if (currentAgeIndex < 0 || research.age !== currentAgeIndex) continue;
        if (
          research.prerequisites.some((prereq) => !boughtResearch.has(prereq))
        ) {
          continue;
        }

        // Check if research boosts science production
        const boostsScience = research.bonuses.some((bonus) => {
          if (bonus.type === "attributeMultiplier") {
            return (
              bonus.destination === "science" ||
              bonus.destination === "allProduction"
            );
          }
          if (bonus.type === "costReductionPercent") {
            return bonus.destination === "allBuildings.costs.all";
          }
          return false;
        });

        if (!boostsScience) continue;

        if (
          state.isResearchUnlocked(research.key) &&
          state.getResearchFailureReason(research.key) === null
        ) {
          return { type: "buyResearch", researchId: research.key };
        }
      }
    }

    const costs = objective.costs(state);
    if (costs.length > 0) {
      const focus = this.focusFor(state, costs, objective.id, context.gameTime);
      if (focus) {
        const reassignment = getWorkerAssignmentAction(state, focus);
        if (reassignment) return reassignment;
      }
      const helper = helperBuildingAction(state, costs);
      if (helper) return helper;
      const deficit = largestDeficitResource(state, costs);
      if (deficit) return { type: "gather", resource: deficit };
    }

    const bootstrap = getBootstrapGatherResource(state);
    if (bootstrap) return { type: "gather", resource: bootstrap };
    const idle = getCheapestPurchaseCandidate(state);
    if (!idle) return null;
    // Affordable: buy it (widened to the most we can pay for). Not yet: gather
    // toward it instead of emitting a build the engine refuses forever — that
    // unguarded `count: 1` is the `built 0/1` freeze, spinning on one building
    // the settlement cannot afford while no gather rung is ever reached.
    if (isPurchaseAffordable(state, idle)) {
      return withMaxAffordableCount(state, idle);
    }
    const towardIdle = gatherForPurchase(state, idle);
    return towardIdle
      ? { type: "gather", resource: towardIdle }
      : withMaxAffordableCount(state, idle);
  }

  /**
   * One loud line marking the end of the authored objective plan. Everything a
   * run logs after this is generic `balanced` play, so a reader of the log can
   * tell exactly where the planned work stops and free-form play begins.
   */
  private announcePlanComplete(): void {
    if (this.planCompleteAnnounced) return;
    this.planCompleteAnnounced = true;
    console.warn(
      [
        "",
        "########################################################################",
        "#  END OF OBJECTIVE PLAN — generic `balanced` strategy engaged.",
        "#  Everything logged AFTER this line is free-form play, NOT part of the",
        "#  authored age-0 objective plan. This banner marks the boundary of the",
        "#  current objective work.",
        "########################################################################",
        "",
      ].join("\n"),
    );
  }

  private focusFor(
    state: CivilizationState,
    costs: readonly FundingCost[],
    objectiveId: string,
    gameTime: number,
  ): WorkerFocus | null {
    const signature = JSON.stringify({
      objective: objectiveId,
      costs: costs.map(({ resource, base }) => [resource, base.toString()]),
      buildings: state.builtBuildings,
      units: Object.fromEntries(
        Object.entries(state.unitCounts).map(([id, count]) => [
          id,
          count.toString(),
        ]),
      ),
      research: state.boughtResearch,
      battles: state.defeatedEncounters,
      enteredAges: state.enteredAges,
      workforce: state.assignedWorkers + state.availableWorkers,
    });
    if (
      !this.focus ||
      this.focus.signature !== signature ||
      gameTime - this.focus.updatedAt >= 30
    ) {
      this.focus = {
        signature,
        updatedAt: gameTime,
        focus: getFastestWorkerAllocation(state, costs),
      };
    }
    return this.focus.focus;
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
  research: new ResearchStrategy(),
  player: new PlayerStrategy(),
  speedrun: new SpeedrunStrategy(),
  trader: new TradeStrategy(),
  objective: new ObjectiveStrategy(),
};

/**
 * A strategy instance carries mutable state across a run — `ResearchStrategy`
 * lazily caches its opening strategy, `PlayerStrategy` holds one as a field.
 * Handing out the registry's singleton therefore makes a second run of the same
 * strategy in the same process start from wherever the first one left off, which
 * two identical `balanced` runs proved did not produce the same final state.
 *
 * Every caller wants an independent strategy, so construct a fresh one per call.
 * The registry is kept only to map a name to its class.
 */
const strategyRegistryNames: Record<string, new () => SimulationStrategy> = {
  cheapest: CheapestStrategy,
  balanced: BalancedStrategy,
  production: ProductionStrategy,
  military: MilitaryStrategy,
  "fast-age": FastAgeStrategy,
  economy: EconomyStrategy,
  research: ResearchStrategy,
  player: PlayerStrategy,
  speedrun: SpeedrunStrategy,
  trader: TradeStrategy,
  objective: ObjectiveStrategy,
};

/** Get a strategy by name. Always a fresh instance — see the note above. */
export function getStrategy(name: string): SimulationStrategy | undefined {
  const Ctor = strategyRegistryNames[name];
  return Ctor ? new Ctor() : undefined;
}

/**
 * Get all available strategy names.
 */
export function getStrategyNames(): string[] {
  return Object.keys(strategyRegistryNames);
}
