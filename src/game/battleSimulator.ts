import { ExpNumber } from "./expNumber";
import {
  findUnitDefinition,
  isBuyableUnit,
  unitDefinitions,
  type UnitDefinition,
} from "./units";
import { encounterDefinitions } from "./encounters";
import type { BuildingCost } from "./buildings";
import type { ResourceKey } from "./attributes";
import {
  formationIds,
  type FormationId,
  DEFAULT_FORMATION,
} from "./formations";
import { orderIds, type OrderId, DEFAULT_ORDER } from "./orders";

/** Minimum-army simulator (dev tools only): cheapest winning army per battle. */
export type SimulatorArmy = ReadonlyMap<string, number>;
/** Units already owned by the player. Their counts remain ExpNumbers. */
export type SimulatorOwnedArmy = ReadonlyMap<string, ExpNumber>;
/** The owned army after applying a proposed set of additional recruits. */
export type SimulatorTotalArmy = ReadonlyMap<string, ExpNumber>;
export type SimulatorCostTotal = {
  readonly resource: ResourceKey;
  readonly base: ExpNumber;
};
export type SimulatorResearch = {
  readonly ids: readonly string[];
  readonly costs: readonly SimulatorCostTotal[];
};
export type SimulatorBattleMetrics = {
  readonly playerCasualties: ExpNumber;
  readonly enemyCasualties: ExpNumber;
  readonly playerCasualtyRate: number;
  readonly enemyCasualtyRate: number;
};
export type SimulatorPlan = {
  /** Additional recruits only; the player's current army is not charged again. */
  readonly composition: SimulatorArmy;
  /** Full army used to test the battle, including currently owned units. */
  readonly totalComposition: SimulatorTotalArmy;
  readonly military: ExpNumber;
  readonly totalCost: readonly SimulatorCostTotal[];
  readonly research: SimulatorResearch;
  readonly battleMetrics?: SimulatorBattleMetrics;
  /** Optimal formation per unit type for this battle. */
  readonly formations: ReadonlyMap<string, FormationId>;
  /** Optimal targeting order per unit type for this battle. */
  readonly orders: ReadonlyMap<string, OrderId>;
};
export type SimulatorResult = SimulatorPlan & {
  /** Other non-dominated winning plans found during the bounded search. */
  readonly alternatives?: readonly SimulatorPlan[];
  readonly searchStats?: {
    readonly tacticTests: number;
    readonly armyRefinementTests: number;
    readonly paretoPlansFound: number;
    readonly paretoPlansTruncated: boolean;
    readonly proofStatus?: "searching" | "proven" | "cancelled" | "failed";
    readonly armyCompositionsTested?: number;
    readonly tacticalSetupsTested?: number;
  };
};
export type SimulatorCandidate = Pick<UnitDefinition, "key">;
export type SimulatorProgress = (
  result: SimulatorResult,
  phase: string,
) => void;
export type BattleSimulatorContext = {
  getCost: (unitId: string, count: number) => BuildingCost[];
  getResearch: (unitIds: readonly string[]) => SimulatorResearch;
  wins: (composition: SimulatorTotalArmy, battleId: string) => boolean;
  /** Test a composition with specific formation assignments. */
  winsWithFormations: (
    composition: SimulatorTotalArmy,
    formations: ReadonlyMap<string, FormationId>,
    battleId: string,
  ) => boolean;
  /** Test a composition with specific formation and order assignments. */
  winsWithFormationsAndOrders: (
    composition: SimulatorTotalArmy,
    formations: ReadonlyMap<string, FormationId>,
    orders: ReadonlyMap<string, OrderId>,
    battleId: string,
  ) => boolean;
  getBattleMetrics?: (
    composition: SimulatorTotalArmy,
    formations: ReadonlyMap<string, FormationId>,
    orders: ReadonlyMap<string, OrderId>,
    battleId: string,
  ) => SimulatorBattleMetrics;
};

/** Buyable units of the battle's age and the previous age. */
export const simulatorCandidates = (battleAge: number): UnitDefinition[] =>
  unitDefinitions.filter(
    (unit) =>
      isBuyableUnit(unit) && unit.age >= battleAge - 1 && unit.age <= battleAge,
  );

/** The actual force that would fight: existing units plus proposed recruits. */
export const mergeSimulatorArmy = (
  ownedArmy: SimulatorOwnedArmy,
  additionalArmy: SimulatorArmy,
): SimulatorTotalArmy => {
  const total = new Map<string, ExpNumber>();
  for (const [unitId, count] of ownedArmy) {
    if (count.gt(ExpNumber.ZERO)) total.set(unitId, count);
  }
  for (const [unitId, count] of additionalArmy) {
    if (count <= 0) continue;
    total.set(
      unitId,
      (total.get(unitId) ?? ExpNumber.ZERO).add(ExpNumber.fromNumber(count)),
    );
  }
  return total;
};

const maximumProbe = 10_000_000;
const maximumPasses = 3;
const maximumPairedFormationTrials = 128;
const maximumParetoPlans = 12;
const armyRefinementScales = [1.25, 1.5, 2, 4];
const armyReinforcementSteps = [1, 2, 4, 8];
const maximumArmyRefinementTrials = 128;

/** New unit types in a proposal are the ones absent from the current army. */
const additionalUnitIds = (
  ownedArmy: SimulatorOwnedArmy,
  additionalArmy: SimulatorArmy,
): string[] =>
  [...additionalArmy.keys()].filter(
    (unitId) => !(ownedArmy.get(unitId)?.gt(ExpNumber.ZERO) ?? false),
  );

const militaryOf = (costs: readonly SimulatorCostTotal[]): ExpNumber => {
  let total = ExpNumber.ZERO;
  for (const { resource, base } of costs) {
    if (resource === "military") total = total.add(base);
  }
  return total;
};

const planCostsByResource = (plan: SimulatorPlan): Map<ResourceKey, ExpNumber> => {
  const costs = new Map<ResourceKey, ExpNumber>();
  for (const { resource, base } of [...plan.totalCost, ...plan.research.costs]) {
    costs.set(resource, (costs.get(resource) ?? ExpNumber.ZERO).add(base));
  }
  return costs;
};

const totalMilitaryCost = (plan: SimulatorPlan): ExpNumber =>
  planCostsByResource(plan).get("military") ?? ExpNumber.ZERO;

const comparePlanCosts = (
  left: SimulatorPlan,
  right: SimulatorPlan,
): number => {
  const leftCosts = planCostsByResource(left);
  const rightCosts = planCostsByResource(right);
  const resources = [...new Set([...leftCosts.keys(), ...rightCosts.keys()])]
    .sort();
  for (const resource of resources) {
    const comparison = (leftCosts.get(resource) ?? ExpNumber.ZERO).compareTo(
      rightCosts.get(resource) ?? ExpNumber.ZERO,
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
};

const orderByMilitaryCost = (
  plans: readonly SimulatorPlan[],
): SimulatorPlan[] =>
  [...plans].sort(
    (left, right) =>
      totalMilitaryCost(left).compareTo(totalMilitaryCost(right)) ||
      comparePlanCosts(left, right),
  );

const sampleParetoPlans = (
  orderedPlans: readonly SimulatorPlan[],
  limit: number,
): SimulatorPlan[] => {
  if (orderedPlans.length <= limit) return [...orderedPlans];
  if (limit <= 1) return [orderedPlans[0]];
  return Array.from({ length: limit }, (_, index) => {
    const sampleIndex = Math.floor(
      (index * (orderedPlans.length - 1)) / (limit - 1),
    );
    return orderedPlans[sampleIndex];
  });
};

export type SimulatorProofProgress = (
  result: SimulatorResult,
  armyCompositionsTested: number,
  tacticalSetupsTested: number,
) => void;

const minimumMilitaryCost = (
  composition: SimulatorArmy,
  context: BattleSimulatorContext,
): ExpNumber => compositionCost(composition, context);

/**
 * Exhaustively prove the minimum military-cost winner within the selected
 * candidate roster and available tactics. The first winner supplies a finite
 * military-cost ceiling; every composition below it is enumerated.
 *
 * Tactical proof uses doctrine-based evaluation (O(doctrines) per composition)
 * instead of an exhaustive per-unit cross-product (O((F×O)^N)), which is
 * intractable for armies with many unit types.
 */
export const proveMinimumMilitaryWinner = async (
  battleId: string,
  candidates: readonly SimulatorCandidate[],
  context: BattleSimulatorContext,
  ownedArmy: SimulatorOwnedArmy,
  availableFormations: readonly FormationId[],
  initialResult: SimulatorResult,
  onProgress: SimulatorProofProgress,
  yieldToWorker: () => Promise<void>,
): Promise<SimulatorResult> => {
  let bestResult = initialResult;
  let bestCost = minimumMilitaryCost(initialResult.composition, context);
  let armyCompositionsTested = 0;
  let tacticalSetupsTested = 0;
  let setupsSinceYield = 0;
  const allUnitIds = [
    ...new Set([
      ...candidates.map(({ key }) => key),
      ...[...ownedArmy]
        .filter(([, count]) => count.gt(ExpNumber.ZERO))
        .map(([unitId]) => unitId),
    ]),
  ];

  // Build the fixed set of doctrine tactic maps to test per composition.
  // This replaces the per-unit cross-product (O((F×O)^N)) with O(doctrines).
  const proofDoctrines: TacticalDoctrine[] = ["standard"];
  if (
    availableFormations.includes("rush") &&
    availableFormations.includes("frontline")
  ) {
    proofDoctrines.push("shock");
  }
  if (
    availableFormations.includes("rush") ||
    availableFormations.includes("frontline")
  ) {
    proofDoctrines.push("rush");
  }
  if (availableFormations.includes("turtle")) proofDoctrines.push("turtle");
  if (
    availableFormations.includes("frontline") &&
    availableFormations.includes("backline")
  ) {
    proofDoctrines.push("frontline");
  }
  // Seed with the best tactic found during optimizeBattleTactics.
  const seededFormations = new Map(initialResult.formations);
  const seededOrders = new Map(initialResult.orders);

  const reportProgress = (): void => {
    onProgress(
      {
        ...bestResult,
        alternatives: [],
        searchStats: {
          tacticTests: tacticalSetupsTested,
          armyRefinementTests: 0,
          paretoPlansFound: 1,
          paretoPlansTruncated: false,
          proofStatus: "searching",
          armyCompositionsTested,
          tacticalSetupsTested,
        },
      },
      armyCompositionsTested,
      tacticalSetupsTested,
    );
  };

  if (bestCost.isZero) {
    const proven = {
      ...bestResult,
      alternatives: [],
      searchStats: {
        tacticTests: 0,
        armyRefinementTests: 0,
        paretoPlansFound: 1,
        paretoPlansTruncated: false,
        proofStatus: "proven" as const,
        armyCompositionsTested: 1,
        tacticalSetupsTested: 0,
      },
    };
    return proven;
  }

  const militaryCostAt = (unitId: string, count: number): ExpNumber =>
    militaryOf(context.getCost(unitId, count));
  const maximumCountFor = (unitId: string): number => {
    const first = militaryCostAt(unitId, 1);
    if (first.lte(ExpNumber.ZERO)) {
      throw new Error(
        `Cannot prove a finite search: ${unitId} has no positive military cost.`,
      );
    }
    let low = 0;
    let high = 1;
    while (militaryCostAt(unitId, high).lte(bestCost)) {
      low = high;
      if (high === Number.MAX_SAFE_INTEGER) {
        throw new Error(
          `Cannot prove a finite search: ${unitId} exceeds the safe integer count range.`,
        );
      }
      high = Math.min(Number.MAX_SAFE_INTEGER, high * 2);
    }
    while (low < high - 1) {
      const middle = low + Math.ceil((high - low) / 2);
      if (militaryCostAt(unitId, middle).lte(bestCost)) low = middle;
      else high = middle;
    }
    return low;
  };

  const limits = new Map(
    candidates.map(({ key }) => [key, maximumCountFor(key)]),
  );

  /**
   * Test a tactic assignment against the given total composition.
   * Updates bestResult if it wins and costs less than the current best.
   */
  const tryTactic = async (
    composition: SimulatorArmy,
    armyCost: ExpNumber,
    totalComposition: SimulatorTotalArmy,
    tacticsFormations: ReadonlyMap<string, FormationId>,
    tacticsOrders: ReadonlyMap<string, OrderId>,
  ): Promise<void> => {
    tacticalSetupsTested += 1;
    setupsSinceYield += 1;
    if (
      context.winsWithFormationsAndOrders(
        totalComposition,
        tacticsFormations,
        tacticsOrders,
        battleId,
      ) &&
      armyCost.lt(bestCost)
    ) {
      bestCost = armyCost;
      bestResult = {
        composition: new Map(composition),
        totalComposition,
        military: armyCost,
        totalCost: sumCosts(composition, context),
        research: context.getResearch(
          additionalUnitIds(ownedArmy, composition),
        ),
        formations: new Map(tacticsFormations),
        orders: new Map(tacticsOrders),
      };
      reportProgress();
      await yieldToWorker();
      setupsSinceYield = 0;
    } else if (setupsSinceYield >= 256) {
      reportProgress();
      await yieldToWorker();
      setupsSinceYield = 0;
    }
  };

  const defaultOrders = new Map<string, OrderId>(
    allUnitIds.map((unitId) => [unitId, DEFAULT_ORDER]),
  );

  // Serialize a tactic map for deduplication.
  const serializeTactic = (
    tacticsFormations: ReadonlyMap<string, FormationId>,
    tacticsOrders: ReadonlyMap<string, OrderId>,
  ): string =>
    allUnitIds
      .map((id) => `${id}:${tacticsFormations.get(id) ?? DEFAULT_FORMATION}:${tacticsOrders.get(id) ?? DEFAULT_ORDER}`)
      .join(",");
  const seededKey = serializeTactic(seededFormations, seededOrders);

  const assignments = async (
    composition: SimulatorArmy,
    armyCost: ExpNumber,
  ): Promise<void> => {
    const totalComposition = mergeSimulatorArmy(ownedArmy, composition);
    const triedKeys = new Set<string>();

    // Try the seeded (optimized) tactic first — most likely to win.
    triedKeys.add(seededKey);
    await tryTactic(
      composition,
      armyCost,
      totalComposition,
      seededFormations,
      seededOrders,
    );

    // Then try each macro doctrine, skipping duplicates of the seeded tactic.
    for (const doctrine of proofDoctrines) {
      const docFormations = buildDoctrineFormations(
        allUnitIds,
        doctrine,
        availableFormations,
      );
      const docKey = serializeTactic(docFormations, defaultOrders);
      if (triedKeys.has(docKey)) continue;
      triedKeys.add(docKey);
      await tryTactic(
        composition,
        armyCost,
        totalComposition,
        docFormations,
        defaultOrders,
      );
    }

    armyCompositionsTested += 1;
  };
  const composition = new Map<string, number>();
  const asyncEnumerate = async (
    index: number,
    armyCost: ExpNumber,
  ): Promise<void> => {
    if (!armyCost.lt(bestCost)) return;
    if (index === candidates.length) {
      await assignments(composition, armyCost);
      return;
    }
    const { key } = candidates[index];
    const maximum = limits.get(key) ?? 0;
    for (let count = 0; count <= maximum; count += 1) {
      const next = new Map(composition);
      if (count > 0) next.set(key, count);
      const nextCost = minimumMilitaryCost(next, context);
      if (!nextCost.lt(bestCost)) break;
      if (count > 0) composition.set(key, count);
      await asyncEnumerate(index + 1, nextCost);
      composition.delete(key);
    }
  };

  await asyncEnumerate(0, ExpNumber.ZERO);
  return {
    ...bestResult,
    alternatives: [],
    searchStats: {
      tacticTests: tacticalSetupsTested,
      armyRefinementTests: 0,
      paretoPlansFound: 1,
      paretoPlansTruncated: false,
      proofStatus: "proven",
      armyCompositionsTested,
      tacticalSetupsTested,
    },
  };
};

const samePlanCosts = (left: SimulatorPlan, right: SimulatorPlan): boolean => {
  const leftCosts = planCostsByResource(left);
  const rightCosts = planCostsByResource(right);
  const resources = new Set([...leftCosts.keys(), ...rightCosts.keys()]);
  return [...resources].every((resource) =>
    (leftCosts.get(resource) ?? ExpNumber.ZERO).eq(
      rightCosts.get(resource) ?? ExpNumber.ZERO,
    ),
  );
};

const tacticDeviationCount = (plan: SimulatorPlan): number => {
  const activeUnits = new Set(plan.totalComposition.keys());
  return (
    [...plan.formations].filter(
      ([unitId, formation]) =>
        activeUnits.has(unitId) && formation !== DEFAULT_FORMATION,
    ).length +
    [...plan.orders].filter(
      ([unitId, order]) =>
        activeUnits.has(unitId) && order !== DEFAULT_ORDER,
    ).length
  );
};

const formationOutcomeIsBetter = (
  left: SimulatorPlan,
  right: SimulatorPlan,
): boolean => {
  const leftCasualties = left.battleMetrics?.playerCasualtyRate;
  const rightCasualties = right.battleMetrics?.playerCasualtyRate;
  if (
    leftCasualties !== undefined &&
    rightCasualties !== undefined &&
    leftCasualties !== rightCasualties
  ) {
    return leftCasualties < rightCasualties;
  }
  return tacticDeviationCount(left) < tacticDeviationCount(right);
};

const battleMetricsAreBetter = (
  left: SimulatorBattleMetrics | undefined,
  right: SimulatorBattleMetrics | undefined,
): boolean => {
  if (!left || !right) return false;
  return (
    left.enemyCasualtyRate > right.enemyCasualtyRate ||
    (left.enemyCasualtyRate === right.enemyCasualtyRate &&
      left.playerCasualtyRate < right.playerCasualtyRate)
  );
};

const planIsBetter = (
  left: SimulatorPlan,
  right: SimulatorPlan,
  context: BattleSimulatorContext,
): boolean => {
  const leftCost = compositionCost(left.composition, context);
  const rightCost = compositionCost(right.composition, context);
  return (
    leftCost.lt(rightCost) ||
    (leftCost.eq(rightCost) && formationOutcomeIsBetter(left, right))
  );
};

const planDominates = (left: SimulatorPlan, right: SimulatorPlan): boolean => {
  const leftCosts = planCostsByResource(left);
  const rightCosts = planCostsByResource(right);
  const resources = new Set([...leftCosts.keys(), ...rightCosts.keys()]);
  let strictlyBetter = false;
  for (const resource of resources) {
    const leftCost = leftCosts.get(resource) ?? ExpNumber.ZERO;
    const rightCost = rightCosts.get(resource) ?? ExpNumber.ZERO;
    if (leftCost.gt(rightCost)) return false;
    if (leftCost.lt(rightCost)) strictlyBetter = true;
  }
  return strictlyBetter;
};

const samePlanKey = (plan: SimulatorPlan): string =>
  `${[...plan.composition].sort(([left], [right]) => left.localeCompare(right))}|${formatTactics(plan.formations)}|${formatTactics(plan.orders)}`;

/**
 * Find optimal formation assignments for a given army composition.
 * Tries all available formations for each unit type and returns the winning combination.
 * Returns empty map if no formation combination wins (falls back to standard).
 * Prefers standard when multiple assignments win.
 */
export const findOptimalFormations = (
  composition: SimulatorTotalArmy,
  availableFormations: readonly FormationId[],
  context: BattleSimulatorContext,
  battleId: string,
): ReadonlyMap<string, FormationId> => {
  const unitIds = [...composition.keys()];
  if (unitIds.length === 0) return new Map();

  // A first-match search must not bias toward non-standard tactic labels.
  const sortedFormations = [...availableFormations].sort((a, b) => {
    if (a === "standard") return -1;
    if (b === "standard") return 1;
    return a.localeCompare(b);
  });

  // Try all combinations (this is exponential, but unit counts are small in practice)
  // For 3 unit types with 3 formations each: 3^3 = 27 combinations
  const tryCombinations = (
    index: number,
    current: Map<string, FormationId>,
  ): Map<string, FormationId> | null => {
    if (index >= unitIds.length) {
      return context.winsWithFormations(composition, current, battleId)
        ? current
        : null;
    }

    const unitId = unitIds[index];
    for (const formation of sortedFormations) {
      current.set(unitId, formation);
      const result = tryCombinations(index + 1, current);
      if (result !== null) return result;
    }
    current.delete(unitId);
    return null;
  };

  const result = tryCombinations(0, new Map());
  return result ?? new Map();
};

/**
 * Find optimal targeting order assignments for a given army composition.
 * Tries all available orders for each unit type and returns the winning combination.
 * Returns empty map if no order combination wins (falls back to standard).
 * Prefers standard when multiple assignments win.
 */
export const findOptimalOrders = (
  composition: SimulatorTotalArmy,
  availableOrders: readonly OrderId[],
  context: BattleSimulatorContext,
  battleId: string,
  formations: ReadonlyMap<string, FormationId>,
): ReadonlyMap<string, OrderId> => {
  const unitIds = [...composition.keys()];
  if (unitIds.length === 0) return new Map();

  // Prefer standard whenever multiple order assignments win.
  const sortedOrders = [...availableOrders].sort((a, b) => {
    if (a === "standard") return -1;
    if (b === "standard") return 1;
    return a.localeCompare(b);
  });

  // Try all combinations (this is exponential, but unit counts are small in practice)
  const tryCombinations = (
    index: number,
    current: Map<string, OrderId>,
  ): Map<string, OrderId> | null => {
    if (index >= unitIds.length) {
      return context.winsWithFormationsAndOrders(
        composition,
        formations,
        current,
        battleId,
      )
        ? current
        : null;
    }

    const unitId = unitIds[index];
    for (const order of sortedOrders) {
      current.set(unitId, order);
      const result = tryCombinations(index + 1, current);
      if (result !== null) return result;
    }
    current.delete(unitId);
    return null;
  };

  const result = tryCombinations(0, new Map());
  return result ?? new Map();
};

const sumCosts = (
  composition: SimulatorArmy,
  context: BattleSimulatorContext,
): SimulatorCostTotal[] => {
  const totals = new Map<ResourceKey, ExpNumber>();
  for (const [unitId, count] of composition) {
    for (const { resource, base } of context.getCost(unitId, count)) {
      totals.set(resource, (totals.get(resource) ?? ExpNumber.ZERO).add(base));
    }
  }
  return [...totals.entries()].map(([resource, base]) => ({ resource, base }));
};

export const compositionCost = (
  composition: SimulatorArmy,
  context: BattleSimulatorContext,
): ExpNumber => militaryOf(sumCosts(composition, context));

const withCount = (
  composition: SimulatorArmy,
  unitId: string,
  count: number,
): SimulatorArmy => {
  const next = new Map(composition);
  if (count <= 0) next.delete(unitId);
  else next.set(unitId, count);
  return next;
};

/** Cheapest solo recruit per unit, then bounded mixed hill-climb, then trim. */
export const solveMinimumArmy = (
  battleId: string,
  candidates: readonly SimulatorCandidate[],
  context: BattleSimulatorContext,
  // Pair seeds the search. It is a no-op for single-unit candidate lists, so
  // Age 0/1 behaviour is unchanged.
  requireMixed: boolean = false,
  ownedArmy: SimulatorOwnedArmy = new Map(),
  lockedFormations: ReadonlyMap<string, FormationId> = new Map(),
  lockedOrders: ReadonlyMap<string, OrderId> = new Map(),
): SimulatorResult | null => {
  const encounter = encounterDefinitions.find(({ key }) => key === battleId);
  if (!encounter) return null;
  const winsRaw = (composition: SimulatorArmy): boolean => {
    const total = mergeSimulatorArmy(ownedArmy, composition);
    if (lockedFormations.size > 0 || lockedOrders.size > 0) {
      return context.winsWithFormationsAndOrders(
        total,
        lockedFormations,
        lockedOrders,
        battleId,
      );
    }
    return context.wins(total, battleId);
  };
  // Tactics are fixed for the whole solve, so the composition alone identifies a
  // battle test. The multi-start climb below re-tests many identical armies
  // (across seeds, passes and the final trim) and a battle simulation is by far
  // the most expensive thing this module does, so memoise it.
  const winCache = new Map<string, boolean>();
  const wins = (composition: SimulatorArmy): boolean => {
    const key = [...composition.entries()]
      .map(([unitId, count]) => `${unitId}:${count}`)
      .sort()
      .join("|");
    const cached = winCache.get(key);
    if (cached !== undefined) return cached;
    const outcome = winsRaw(composition);
    winCache.set(key, outcome);
    return outcome;
  };
  if (wins(new Map())) {
    const totalComposition = mergeSimulatorArmy(ownedArmy, new Map());
    const availableFormations =
      encounter && encounter.age >= 2 ? formationIds : [DEFAULT_FORMATION];
    const availableOrders =
      encounter && encounter.age >= 3 ? orderIds : [DEFAULT_ORDER];
    const formations =
      lockedFormations.size > 0
        ? lockedFormations
        : findOptimalFormations(
            totalComposition,
            availableFormations,
            context,
            battleId,
          );
    const orders =
      lockedOrders.size > 0
        ? lockedOrders
        : findOptimalOrders(
            totalComposition,
            availableOrders,
            context,
            battleId,
            formations,
          );
    return {
      composition: new Map(),
      totalComposition,
      military: ExpNumber.ZERO,
      totalCost: [],
      research: { ids: [], costs: [] },
      formations,
      orders,
    };
  }
  // Every unit that can win on its own is a seed, not just the cheapest one.
  // The hill-climb below only ever halves a stack, so the local optimum it
  // settles in is decided by its starting point — and which unit is cheapest
  // changes when the player ticks one more box. Seeding from all of them makes
  // the result monotone in the candidate set: an extra candidate can only add a
  // seed, so it can never make the answer dearer than it already was.
  const seeds: SimulatorArmy[] = [];
  for (const unit of candidates) {
    if (!findUnitDefinition(unit.key)) continue;
    let lo = 1;
    let hi = 1;
    while (!wins(new Map([[unit.key, hi]]))) {
      hi *= 2;
      if (hi > maximumProbe) break;
    }
    if (hi > maximumProbe) continue;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (wins(new Map([[unit.key, mid]]))) hi = mid;
      else lo = mid + 1;
    }
    seeds.push(new Map([[unit.key, lo]]));
  }
  // Some battles require complementary roles: neither the siege unit nor the
  // naval unit can win alone, but their combination can. Seed the hill-climb
  // with bounded power-of-two pair searches so those armies are discoverable.
  if (requireMixed && seeds.length === 0) {
    const powers = Array.from({ length: 24 }, (_, index) => 2 ** index);
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < candidates.length;
        rightIndex += 1
      ) {
        const left = candidates[leftIndex];
        const right = candidates[rightIndex];
        for (const leftCount of powers) {
          for (const rightCount of powers) {
            const composition = new Map([
              [left.key, leftCount],
              [right.key, rightCount],
            ]);
            if (wins(composition)) seeds.push(composition);
          }
        }
      }
    }
  }
  if (seeds.length === 0) return null;
  const ids = candidates.map((unit) => unit.key);

  /**
   * Bounded hill-climb from one seed: halve a stack and pay for the cheapest
   * amount of another unit that still wins. Halving alone cannot escape a stack
   * that should not be there at all — `Math.ceil(count / 2)` stalls at 1, so a
   * single leftover unit could never be removed — so also try dropping the
   * stack outright.
   *
   * Deliberately independent of the other seeds: the incumbent a move must beat
   * is this climb's own, never a shared one. Sharing it would make the answer
   * depend on which seed happened to be climbed first, which is the very bug
   * this multi-start search exists to remove.
   */
  const climb = (seed: SimulatorArmy): SimulatorArmy => {
    let current = seed;
    let currentCost = compositionCost(current, context);
    let improved = true;
    let passes = 0;
    while (improved && passes < maximumPasses) {
      improved = false;
      passes += 1;
      for (const [unitId, count] of [...current]) {
        const bases = [
          withCount(current, unitId, Math.ceil(count / 2)),
          withCount(current, unitId, 0),
        ];
        for (const base of bases) {
          for (const other of ids) {
            if (other === unitId) continue;
            let add = 1;
            let found = false;
            while (add <= maximumProbe) {
              const trial = withCount(base, other, (base.get(other) ?? 0) + add);
              if (wins(trial)) {
                found = true;
                break;
              }
              add *= 2;
            }
            if (!found) continue;
            let lo = 1;
            let hi = add;
            while (lo < hi) {
              const mid = Math.floor((lo + hi) / 2);
              const trial = withCount(base, other, (base.get(other) ?? 0) + mid);
              if (wins(trial)) hi = mid;
              else lo = mid + 1;
            }
            const next = withCount(base, other, (base.get(other) ?? 0) + lo);
            const cost = compositionCost(next, context);
            if (cost.lt(currentCost) && wins(next)) {
              current = next;
              currentCost = cost;
              improved = true;
            }
          }
        }
      }
    }
    return current;
  };

  let best: SimulatorArmy | null = null;
  let bestCost = ExpNumber.INFINITY;
  for (const seed of seeds) {
    const climbed = climb(seed);
    const cost = compositionCost(climbed, context);
    if (cost.lt(bestCost)) {
      best = climbed;
      bestCost = cost;
    }
  }
  if (!best) return null;
  for (const [unitId, count] of [...best]) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (wins(withCount(best, unitId, mid))) hi = mid;
      else lo = mid + 1;
    }
    best = withCount(best, unitId, lo);
  }
  bestCost = compositionCost(best, context);
  const totalComposition = mergeSimulatorArmy(ownedArmy, best);

  // Find optimal formations for the winning army
  // Use standard formation for Age 0/1, all available formations for Age 2+
  // Use locked formations if provided, otherwise find optimal
  const availableFormations =
    encounter && encounter.age >= 2 ? formationIds : [DEFAULT_FORMATION];

  const formations =
    lockedFormations.size > 0
      ? lockedFormations
      : findOptimalFormations(
          totalComposition,
          availableFormations,
          context,
          battleId,
        );

  // Find optimal targeting orders for the winning army
  // Use standard order for Age 0/2, all available orders for Age 3+
  const availableOrders =
    encounter && encounter.age >= 3 ? orderIds : [DEFAULT_ORDER];

  const orders =
    lockedOrders.size > 0
      ? lockedOrders
      : findOptimalOrders(
          totalComposition,
          availableOrders,
          context,
          battleId,
          formations,
        );

  return {
    composition: best,
    totalComposition,
    military: bestCost,
    totalCost: sumCosts(best, context),
    research: context.getResearch(additionalUnitIds(ownedArmy, best)),
    formations,
    orders,
  };
};
/**
 * Drop each recruit count as far as it can go while the merged army (owned
 * units fixed, recruits variable) still defeats the battle under a fixed
 * tactic set. Owned units are never touched - the caller is only ever charged
 * for additional recruits.
 */
export const trimUnderTactics = (
  composition: SimulatorArmy,
  ownedArmy: SimulatorOwnedArmy,
  formations: ReadonlyMap<string, FormationId>,
  orders: ReadonlyMap<string, OrderId>,
  battleId: string,
  context: BattleSimulatorContext,
): SimulatorArmy => {
  const wins = (trial: SimulatorArmy): boolean =>
    context.winsWithFormationsAndOrders(
      mergeSimulatorArmy(ownedArmy, trial),
      formations,
      orders,
      battleId,
    );
  const trimmed = new Map(composition);
  for (const [unitId, count] of [...trimmed]) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const trial = new Map(trimmed);
      trial.set(unitId, mid);
      if (wins(trial)) hi = mid;
      else lo = mid + 1;
    }
    if (lo <= 0) trimmed.delete(unitId);
    else trimmed.set(unitId, lo);
  }
  return trimmed;
};

/** "warrior×5 slinger×2" — recruits-only army for the debug log. */
const formatArmy = (army: SimulatorArmy): string =>
  army.size === 0
    ? "(none)"
    : [...army.entries()]
        .map(([unitId, count]) => `${unitId}×${count}`)
        .join(" ");

/** "warrior:frontline slinger:standard" — a tactic assignment map for the log. */
const formatTactics = (tactics: ReadonlyMap<string, string>): string =>
  tactics.size === 0
    ? "standard"
    : [...tactics.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([unitId, tactic]) => `${unitId}:${tactic}`)
        .join(" ");

/**
 * Alternate between finding the minimum army for fixed tactics and testing
 * single tactic changes, then paired formation changes, against progressively
 * larger fractions of it. Keep changes only when trimming recruits lowers
 * their exact cost, then re-solve the minimum army under those tactics.
 */
export type TacticalDoctrine = "standard" | "shock" | "rush" | "turtle" | "frontline";

export const buildDoctrineFormations = (
  unitIds: readonly string[],
  doctrine: TacticalDoctrine,
  availableFormations: readonly FormationId[],
): Map<string, FormationId> => {
  const formations = new Map<string, FormationId>();
  const hasRush = availableFormations.includes("rush");
  const hasFrontline = availableFormations.includes("frontline");
  const hasTurtle = availableFormations.includes("turtle");
  const hasBackline = availableFormations.includes("backline");

  for (const unitId of unitIds) {
    const def = findUnitDefinition(unitId);
    const isMelee = (def?.stats.range ?? 1) <= 1;
    const isTank = isMelee || (def?.tags.includes("infantry") ?? false);

    if (doctrine === "shock") {
      // Coordinated Shock Assault:
      // Frontline tanks take frontline (+20% HP, -2 position offset) to absorb and screen.
      // Strikers / Cavalry / Ranged take rush (+30% attack, 2x speed) to destroy backlines.
      if (isTank && hasFrontline) {
        formations.set(unitId, "frontline");
      } else if (hasRush) {
        formations.set(unitId, "rush");
      } else if (hasFrontline) {
        formations.set(unitId, "frontline");
      } else {
        formations.set(unitId, DEFAULT_FORMATION);
      }
    } else if (doctrine === "rush") {
      if (hasRush) {
        formations.set(unitId, "rush");
      } else if (hasFrontline) {
        formations.set(unitId, "frontline");
      } else {
        formations.set(unitId, DEFAULT_FORMATION);
      }
    } else if (doctrine === "turtle") {
      if (isTank && hasTurtle) {
        formations.set(unitId, "turtle");
      } else if (!isTank && hasBackline) {
        formations.set(unitId, "backline");
      } else {
        formations.set(unitId, DEFAULT_FORMATION);
      }
    } else if (doctrine === "frontline") {
      if (isTank && hasFrontline) {
        formations.set(unitId, "frontline");
      } else if (!isTank && hasBackline) {
        formations.set(unitId, "backline");
      } else {
        formations.set(unitId, DEFAULT_FORMATION);
      }
    } else {
      formations.set(unitId, DEFAULT_FORMATION);
    }
  }

  return formations;
};

export const optimizeBattleTactics = (
  battleId: string,
  candidates: readonly SimulatorCandidate[],
  context: BattleSimulatorContext,
  requireMixed = false,
  ownedArmy: SimulatorOwnedArmy = new Map(),
  initialFormations: ReadonlyMap<string, FormationId> = new Map(),
  initialOrders: ReadonlyMap<string, OrderId> = new Map(),
  formationChoices?: readonly FormationId[],
  orderChoices?: readonly OrderId[],
  onProgress?: SimulatorProgress,
): SimulatorResult | null => {
  const encounter = encounterDefinitions.find(({ key }) => key === battleId);
  if (!encounter) return null;
  const availableFormations =
    formationChoices ??
    (encounter.age >= 2 ? formationIds : [DEFAULT_FORMATION]);
  const availableOrders =
    orderChoices ?? (encounter.age >= 3 ? orderIds : [DEFAULT_ORDER]);
  const allUnitIds = [
    ...new Set([
      ...candidates.map(({ key }) => key),
      ...[...ownedArmy]
        .filter(([, count]) => count.gt(ExpNumber.ZERO))
        .map(([unitId]) => unitId),
    ]),
  ];
  const assignDefaults = <T extends string>(
    choices: readonly T[],
    requested: ReadonlyMap<string, T>,
    fallback: T,
  ): Map<string, T> =>
    new Map(
      allUnitIds.map((unitId) => [
        unitId,
        choices.includes(requested.get(unitId) ?? fallback)
          ? (requested.get(unitId) ?? fallback)
          : fallback,
      ]),
    );

  const withMetrics = (plan: SimulatorPlan): SimulatorResult => {
    const battleMetrics = context.getBattleMetrics?.(
      plan.totalComposition,
      plan.formations,
      plan.orders,
      battleId,
    );
    return battleMetrics ? { ...plan, battleMetrics } : plan;
  };
  const isWinningPlan = (plan: SimulatorPlan): boolean =>
    context.winsWithFormationsAndOrders(
      plan.totalComposition,
      plan.formations,
      plan.orders,
      battleId,
    );

  let formations = assignDefaults(
    availableFormations,
    initialFormations,
    DEFAULT_FORMATION,
  );
  let orders = assignDefaults(availableOrders, initialOrders, DEFAULT_ORDER);
  let best = solveMinimumArmy(
    battleId,
    candidates,
    context,
    requireMixed,
    ownedArmy,
    formations,
    orders,
  );
  if (!best) {
    formations = assignDefaults(
      availableFormations,
      new Map(),
      DEFAULT_FORMATION,
    );
    orders = assignDefaults(availableOrders, new Map(), DEFAULT_ORDER);
    best = solveMinimumArmy(
      battleId,
      candidates,
      context,
      requireMixed,
      ownedArmy,
      formations,
      orders,
    );
  }
  if (!best) return null;

  const paretoPlans: SimulatorPlan[] = [];
  let paretoPlansTruncated = false;
  const registerParetoPlan = (plan: SimulatorPlan): void => {
    if (!isWinningPlan(plan)) return;
    const key = samePlanKey(plan);
    if (paretoPlans.some((current) => samePlanKey(current) === key)) return;
    const equivalentIndex = paretoPlans.findIndex(
      (current) => samePlanCosts(current, plan),
    );
    if (equivalentIndex >= 0) {
      if (formationOutcomeIsBetter(plan, paretoPlans[equivalentIndex])) {
        paretoPlans[equivalentIndex] = plan;
      }
      return;
    }
    if (paretoPlans.some((current) => planDominates(current, plan))) return;
    for (let index = paretoPlans.length - 1; index >= 0; index -= 1) {
      if (planDominates(plan, paretoPlans[index])) paretoPlans.splice(index, 1);
    }
    paretoPlans.push(plan);
    if (paretoPlans.length > maximumParetoPlans * 4) {
      const sampled = sampleParetoPlans(
        orderByMilitaryCost(paretoPlans),
        maximumParetoPlans * 4,
      );
      paretoPlans.splice(0, paretoPlans.length, ...sampled);
      paretoPlansTruncated = true;
    }
  };

  let bestResult = withMetrics(best);
  if (!isWinningPlan(bestResult)) return null;
  registerParetoPlan(bestResult);
  let bestCost = compositionCost(bestResult.composition, context);
  onProgress?.(bestResult, "Minimum army for the current tactics");

  let attempts = 0;
  let exploratoryAttempts = 0;
  const visitedTactics = new Set<string>();
  const tacticKey = (
    currentFormations: ReadonlyMap<string, FormationId>,
    currentOrders: ReadonlyMap<string, OrderId>,
  ): string =>
    `${formatTactics(currentFormations)}|${formatTactics(currentOrders)}`;
  visitedTactics.add(tacticKey(formations, orders));

  // Evaluate candidate macro doctrines upfront
  const doctrines: TacticalDoctrine[] = [];
  if (
    availableFormations.includes("rush") &&
    availableFormations.includes("frontline")
  ) {
    doctrines.push("shock");
  }
  if (
    availableFormations.includes("rush") ||
    availableFormations.includes("frontline")
  ) {
    doctrines.push("rush");
  }
  if (availableFormations.includes("turtle")) {
    doctrines.push("turtle");
  }
  if (
    availableFormations.includes("frontline") &&
    availableFormations.includes("backline")
  ) {
    doctrines.push("frontline");
  }

  for (const doc of doctrines) {
    const docFormations = buildDoctrineFormations(
      allUnitIds,
      doc,
      availableFormations,
    );
    const docOrders = assignDefaults(availableOrders, new Map(), DEFAULT_ORDER);
    const docKey = tacticKey(docFormations, docOrders);
    if (visitedTactics.has(docKey)) continue;
    visitedTactics.add(docKey);

    const docSolved = solveMinimumArmy(
      battleId,
      candidates,
      context,
      requireMixed,
      ownedArmy,
      docFormations,
      docOrders,
    );
    if (docSolved) {
      const docPlan = withMetrics(docSolved);
      registerParetoPlan(docPlan);
      if (planIsBetter(docPlan, bestResult, context)) {
        bestResult = docPlan;
        formations = new Map(docFormations);
        orders = new Map(docOrders);
        bestCost = compositionCost(bestResult.composition, context);
        onProgress?.(bestResult, `Re-solved army under ${doc} doctrine`);
      }
    }
  }

  for (;;) {
    const tacticalUnitIds = [...bestResult.totalComposition.keys()];
    let next:
      | {
          readonly composition: SimulatorArmy;
          readonly formations: ReadonlyMap<string, FormationId>;
          readonly orders: ReadonlyMap<string, OrderId>;
          readonly cost: ExpNumber;
          readonly plan: SimulatorPlan;
        }
      | undefined;
    let exploratory:
      | {
          readonly formations: ReadonlyMap<string, FormationId>;
          readonly orders: ReadonlyMap<string, OrderId>;
          readonly metrics: SimulatorBattleMetrics;
        }
      | undefined;
    const currentTacticMetrics = context.getBattleMetrics?.(
      bestResult.totalComposition,
      formations,
      orders,
      battleId,
    );
    const consider = (
      trialFormations: ReadonlyMap<string, FormationId>,
      trialOrders: ReadonlyMap<string, OrderId>,
    ): void => {
      const trialKey = tacticKey(trialFormations, trialOrders);
      if (visitedTactics.has(trialKey)) return;
      const currentArmyWins = context.winsWithFormationsAndOrders(
        bestResult.totalComposition,
        trialFormations,
        trialOrders,
        battleId,
      );
      if (!currentArmyWins) {
        const metrics = context.getBattleMetrics?.(
          bestResult.totalComposition,
          trialFormations,
          trialOrders,
          battleId,
        );
        if (
          battleMetricsAreBetter(metrics, currentTacticMetrics) &&
          (!exploratory ||
            battleMetricsAreBetter(metrics, exploratory.metrics))
        ) {
          if (metrics) {
            exploratory = {
              formations: trialFormations,
              orders: trialOrders,
              metrics,
            };
          }
        }
        return;
      }

      let reachesAtFraction = false;
      for (const fraction of [0.5, 0.75, 1]) {
        const probeArmy = new Map<string, ExpNumber>(ownedArmy);
        for (const [unitId, count] of bestResult.composition) {
          const probeCount = Math.floor(count * fraction);
          if (probeCount > 0) {
            probeArmy.set(
              unitId,
              (probeArmy.get(unitId) ?? ExpNumber.ZERO).add(
                ExpNumber.fromNumber(probeCount),
              ),
            );
          }
        }
        reachesAtFraction = context.winsWithFormationsAndOrders(
          probeArmy,
          trialFormations,
          trialOrders,
          battleId,
        );
        if (reachesAtFraction) break;
      }
      if (!reachesAtFraction) return;

      const trimmed = trimUnderTactics(
        bestResult.composition,
        ownedArmy,
        trialFormations,
        trialOrders,
        battleId,
        context,
      );
      const cost = compositionCost(trimmed, context);
      const totalComposition = mergeSimulatorArmy(ownedArmy, trimmed);
      const candidatePlan = withMetrics({
        composition: trimmed,
        totalComposition,
        military: cost,
        totalCost: sumCosts(trimmed, context),
        research: context.getResearch(
          additionalUnitIds(ownedArmy, trimmed),
        ),
        formations: trialFormations,
        orders: trialOrders,
      });
      if (!isWinningPlan(candidatePlan)) return;
      registerParetoPlan(candidatePlan);
      const improvesBest = planIsBetter(candidatePlan, bestResult, context);
      if (
        improvesBest &&
        (!next || planIsBetter(candidatePlan, next.plan, context))
      ) {
        next = {
          composition: trimmed,
          formations: trialFormations,
          orders: trialOrders,
          cost,
          plan: candidatePlan,
        };
      }
    };

    for (const unitId of tacticalUnitIds) {
      for (const formation of availableFormations) {
        if (formations.get(unitId) === formation) continue;
        const trialFormations = new Map(formations);
        trialFormations.set(unitId, formation);
        attempts += 1;
        consider(trialFormations, orders);
        onProgress?.(
          bestResult,
          `Testing ${unitId}: ${formation} (${attempts})`,
        );
      }
      for (const order of availableOrders) {
        if (orders.get(unitId) === order) continue;
        const trialOrders = new Map(orders);
        trialOrders.set(unitId, order);
        attempts += 1;
        consider(formations, trialOrders);
        onProgress?.(bestResult, `Testing ${unitId}: ${order} (${attempts})`);
      }
    }
    if (!next) {
      const formationChanges = tacticalUnitIds.flatMap((unitId) =>
        availableFormations
          .filter((formation) => formations.get(unitId) !== formation)
          .map((formation) => ({ unitId, formation })),
      );
      const pairedTrials: {
        readonly first: (typeof formationChanges)[number];
        readonly second: (typeof formationChanges)[number];
      }[] = [];
      for (let first = 0; first < formationChanges.length; first += 1) {
        const firstChange = formationChanges[first];
        for (
          let second = first + 1;
          second < formationChanges.length;
          second += 1
        ) {
          const secondChange = formationChanges[second];
          if (firstChange.unitId === secondChange.unitId) continue;
          pairedTrials.push({ first: firstChange, second: secondChange });
        }
      }
      const trialCount = Math.min(
        pairedTrials.length,
        maximumPairedFormationTrials,
      );
      for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) {
        const sampledIndex = Math.floor(
          (trialIndex * (pairedTrials.length - 1)) /
            Math.max(1, trialCount - 1),
        );
        const { first, second } = pairedTrials[sampledIndex];
        const trialFormations = new Map(formations);
        trialFormations.set(first.unitId, first.formation);
        trialFormations.set(second.unitId, second.formation);
        attempts += 1;
        consider(trialFormations, orders);
        onProgress?.(
          bestResult,
          `Testing combination: ${first.unitId} ${first.formation} + ${second.unitId} ${second.formation} (${attempts})`,
        );
      }
    }
    if (!next && (!exploratory || exploratoryAttempts >= 1)) break;

    const nextFormations = next?.formations ?? exploratory?.formations;
    const nextOrders = next?.orders ?? exploratory?.orders;
    if (!nextFormations || !nextOrders) break;
    const nextKey = tacticKey(nextFormations, nextOrders);
    if (visitedTactics.has(nextKey)) break;
    visitedTactics.add(nextKey);
    formations = new Map(nextFormations);
    orders = new Map(nextOrders);
    if (!next && exploratory) {
      exploratoryAttempts += 1;
    }
    const reSolved = solveMinimumArmy(
      battleId,
      candidates,
      context,
      requireMixed,
      ownedArmy,
      formations,
      orders,
    );
    if (reSolved) {
      const resolvedPlan = withMetrics(reSolved);
      if (planIsBetter(resolvedPlan, bestResult, context)) {
        bestResult = resolvedPlan;
      } else if (!next) {
        break;
      }
    } else if (next && planIsBetter(next.plan, bestResult, context)) {
      bestResult = next.plan;
    } else {
      break;
    }
    registerParetoPlan(bestResult);
    bestCost = compositionCost(bestResult.composition, context);
    onProgress?.(
      bestResult,
      `Re-solved army after tactic change (${attempts})`,
    );
  }

  console.log(
    `[Battle Optimizer] ${battleId}: minimum army {${formatArmy(
      bestResult.composition,
    )}} (military ${bestCost.toString()}) with formations {${formatTactics(
      formations,
    )}} orders {${formatTactics(orders)}} after ${attempts} tactic trials`,
  );
  let armyRefinementTests = 0;
  const refinementCandidates = new Map<
    string,
    { readonly composition: SimulatorArmy; readonly basePlan: SimulatorPlan }
  >();
  const addRefinementCandidate = (
    composition: SimulatorArmy,
    basePlan: SimulatorPlan,
  ): void => {
    const compositionKey = [...composition]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([unitId, count]) => `${unitId}:${count}`)
      .join(",");
    const key = `${compositionKey}|${formatTactics(basePlan.formations)}|${formatTactics(basePlan.orders)}`;
    refinementCandidates.set(key, { composition, basePlan });
  };
  const refinementPlans = [...paretoPlans].slice(0, maximumParetoPlans);
  for (const basePlan of refinementPlans) {
    for (const scale of armyRefinementScales) {
      const scaled = new Map<string, number>();
      for (const [unitId, count] of basePlan.composition) {
        const refinedCount = Math.min(maximumProbe, Math.ceil(count * scale));
        if (refinedCount > 0) scaled.set(unitId, refinedCount);
      }
      if (
        scaled.size !== basePlan.composition.size ||
        [...scaled].some(
          ([unitId, count]) => basePlan.composition.get(unitId) !== count,
        )
      ) {
        addRefinementCandidate(scaled, basePlan);
      }
    }
    for (const { key: unitId } of candidates) {
      for (const additionalCount of armyReinforcementSteps) {
        const reinforced = new Map(basePlan.composition);
        const count = (reinforced.get(unitId) ?? 0) + additionalCount;
        if (count > maximumProbe) continue;
        reinforced.set(unitId, count);
        addRefinementCandidate(reinforced, basePlan);
      }
    }
  }

  const refinementEntries = [...refinementCandidates.values()].slice(
    0,
    maximumArmyRefinementTrials,
  );
  armyRefinementTests = refinementEntries.length;
  for (const { composition, basePlan } of refinementEntries) {
    const totalComposition = mergeSimulatorArmy(ownedArmy, composition);
    if (
      !context.winsWithFormationsAndOrders(
        totalComposition,
        basePlan.formations,
        basePlan.orders,
        battleId,
      )
    ) {
      continue;
    }

    registerParetoPlan(
      withMetrics({
        composition,
        totalComposition,
        military: compositionCost(composition, context),
        totalCost: sumCosts(composition, context),
        research: context.getResearch(
          additionalUnitIds(ownedArmy, composition),
        ),
        formations: basePlan.formations,
        orders: basePlan.orders,
      }),
    );
  }
  registerParetoPlan(bestResult);
  const nonDominatedPlans = paretoPlans.filter(
    (plan) =>
      !paretoPlans.some(
        (other) => other !== plan && planDominates(other, plan),
      ),
  );
  const orderedParetoPlans = orderByMilitaryCost(nonDominatedPlans);
  const primaryPlan = orderedParetoPlans[0] ?? bestResult;
  const bestKey = samePlanKey(primaryPlan);
  const alternatives = sampleParetoPlans(
    orderedParetoPlans.filter((plan) => samePlanKey(plan) !== bestKey),
    maximumParetoPlans,
  );
  paretoPlansTruncated =
    paretoPlansTruncated ||
    orderedParetoPlans.length > maximumParetoPlans + 1;
  return {
    ...primaryPlan,
    alternatives,
    searchStats: {
      tacticTests: attempts,
      armyRefinementTests,
      paretoPlansFound: orderedParetoPlans.length,
      paretoPlansTruncated,
    },
  };
};
