import { ExpNumber } from "./expNumber";
import {
  findUnitDefinition,
  isBuyableUnit,
  unitPower,
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
export type SimulatorArmy = ReadonlyMap<string, ExpNumber>;
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
  improved: boolean,
) => void;
export type SimulatorTacticSearch = {
  readonly formations: ReadonlyMap<string, FormationId>;
  readonly orders: ReadonlyMap<string, OrderId>;
  readonly wins: boolean;
  readonly battleMetrics?: SimulatorBattleMetrics;
};
export type SimulatorHistoricalSeed = {
  readonly playerArmy: readonly {
    readonly unitId: string;
    readonly count: string;
    readonly formation: FormationId;
    readonly order: OrderId;
  }[];
};
export type BattleSimulatorContext = {
  getCost: (unitId: string, count: ExpNumber) => BuildingCost[];
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
    if (!count.gt(ExpNumber.ZERO)) continue;
    total.set(unitId, (total.get(unitId) ?? ExpNumber.ZERO).add(count));
  }
  return total;
};

const maximumProbe = ExpNumber.from("1e308");
const maximumPasses = 1_000_000;
const maximumPairedFormationTrials = 128;
const tacticSearchProbeFraction = 0.7;
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

const planCostsByResource = (
  plan: SimulatorPlan,
): Map<ResourceKey, ExpNumber> => {
  const costs = new Map<ResourceKey, ExpNumber>();
  for (const { resource, base } of [
    ...plan.totalCost,
    ...plan.research.costs,
  ]) {
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
  const resources = [
    ...new Set([...leftCosts.keys(), ...rightCosts.keys()]),
  ].sort();
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

  const militaryCostAt = (unitId: string, count: ExpNumber): ExpNumber =>
    militaryOf(context.getCost(unitId, count));
  const maximumCountFor = (unitId: string): number => {
    const first = militaryCostAt(unitId, ExpNumber.ONE);
    if (first.lte(ExpNumber.ZERO)) {
      throw new Error(
        `Cannot prove a finite search: ${unitId} has no positive military cost.`,
      );
    }
    let low = 0;
    let high = 1;
    while (militaryCostAt(unitId, ExpNumber.fromNumber(high)).lte(bestCost)) {
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
      if (militaryCostAt(unitId, ExpNumber.fromNumber(middle)).lte(bestCost)) {
        low = middle;
      } else high = middle;
    }
    return low;
  };

  const limits = new Map(
    candidates.map(({ key }) => [key, maximumCountFor(key)]),
  );
  console.debug(
    `[Battle Simulator] ${battleId}: minimum-cost proof started; ` +
      `${candidates.length} candidate unit types, ` +
      `${proofDoctrines.join(", ")} tactics, current military cost ` +
      `${bestCost.toString()}`,
  );
  console.debug(
    `[Battle Simulator] ${battleId}: proof count ceilings: ` +
      [...limits].map(([unitId, count]) => `${unitId} <= ${count}`).join(", "),
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
      .map(
        (id) =>
          `${id}:${tacticsFormations.get(id) ?? DEFAULT_FORMATION}:${tacticsOrders.get(id) ?? DEFAULT_ORDER}`,
      )
      .join(",");
  const assignments = async (
    composition: SimulatorArmy,
    armyCost: ExpNumber,
  ): Promise<void> => {
    const totalComposition = mergeSimulatorArmy(ownedArmy, composition);
    const triedKeys = new Set<string>();

    /**
     * Sieve of Eratosthenes approach:
     * Each doctrine is a "prime" seed.  From each seed we sieve outward by
     * changing exactly one unit's formation at a time, producing all
     * single-step neighbours.  This covers O(doctrines × F × N) tactic
     * configurations per composition — e.g. 5 × 8 × 13 ≈ 520 — rather than
     * the intractable O(F^N) cross-product while still finding any combination
     * reachable in one step from a sensible baseline.
     */
    const tryIfNew = async (
      tacticsFormations: ReadonlyMap<string, FormationId>,
      tacticsOrders: ReadonlyMap<string, OrderId>,
    ): Promise<void> => {
      const key = serializeTactic(tacticsFormations, tacticsOrders);
      if (triedKeys.has(key)) return;
      triedKeys.add(key);
      await tryTactic(
        composition,
        armyCost,
        totalComposition,
        tacticsFormations,
        tacticsOrders,
      );
    };

    // Build seed set: seeded tactic + all doctrines.
    const seeds: Map<string, FormationId>[] = [new Map(seededFormations)];
    for (const doctrine of proofDoctrines) {
      seeds.push(
        buildDoctrineFormations(allUnitIds, doctrine, availableFormations),
      );
    }

    // Active units in this total composition (count > 0)
    const activeUnitIds = allUnitIds.filter((unitId) =>
      (totalComposition.get(unitId) ?? ExpNumber.ZERO).gt(ExpNumber.ZERO),
    );

    // For each seed: test it, then test all single-unit formation perturbations.
    for (const baseFormations of seeds) {
      // Test the seed itself.
      await tryIfNew(baseFormations, seededOrders);
      await tryIfNew(baseFormations, defaultOrders);

      // Sieve step: perturb active units' formation through all available options.
      for (const unitId of activeUnitIds) {
        for (const formation of availableFormations) {
          const perturbed = new Map(baseFormations);
          perturbed.set(unitId, formation);
          await tryIfNew(perturbed, defaultOrders);
        }
      }
    }

    armyCompositionsTested += 1;
  };
  // Sort candidates by cost per unit descending so that higher-cost units
  // branch-prune early in the search tree.
  const sortedCandidates = [...candidates].sort((a, b) =>
    militaryCostAt(b.key, ExpNumber.ONE).compareTo(
      militaryCostAt(a.key, ExpNumber.ONE),
    ),
  );
  const composition = new Map<string, ExpNumber>();
  const asyncEnumerate = async (
    index: number,
    armyCost: ExpNumber,
  ): Promise<void> => {
    if (!armyCost.lt(bestCost)) return;
    if (index === sortedCandidates.length) {
      await assignments(composition, armyCost);
      return;
    }
    const { key } = sortedCandidates[index];
    const maximum = limits.get(key) ?? 0;
    for (let count = 0; count <= maximum; count += 1) {
      const next = new Map(composition);
      if (count > 0) next.set(key, ExpNumber.fromNumber(count));
      const nextCost = minimumMilitaryCost(next, context);
      if (!nextCost.lt(bestCost)) break;
      if (count > 0) composition.set(key, ExpNumber.fromNumber(count));
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
      ([unitId, order]) => activeUnits.has(unitId) && order !== DEFAULT_ORDER,
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
  isWin = false,
): boolean => {
  if (!left || !right) return false;
  if (isWin) {
    return left.playerCasualtyRate < right.playerCasualtyRate;
  }
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
 * Returns empty map if no order combination wins (falls back to Hunt the weak).
 * Prefers Hunt the weak when multiple assignments win.
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

  // Prefer Hunt the weak whenever multiple order assignments win.
  const sortedOrders = [...availableOrders].sort((a, b) => {
    if (a === DEFAULT_ORDER) return -1;
    if (b === DEFAULT_ORDER) return 1;
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
  count: ExpNumber,
): SimulatorArmy => {
  const next = new Map(composition);
  if (!count.gt(ExpNumber.ZERO)) next.delete(unitId);
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
  countCeiling?: ReadonlyMap<string, ExpNumber>,
): SimulatorResult | null => {
  const encounter = encounterDefinitions.find(({ key }) => key === battleId);
  if (!encounter) return null;
  let searchStage = "checking whether the owned army wins";
  let testAttempts = 0;
  let battleSimulations = 0;
  let lastDebugLogAt = 0;
  let lastDebugTestCount = 0;
  let lastTestedComposition = "";
  let lastTestedTactics = "";
  let lastTestOutcome = "pending";
  const reportTestProgress = (): void => {
    const now = Date.now();
    if (
      testAttempts !== 1 &&
      testAttempts - lastDebugTestCount < 256 &&
      now - lastDebugLogAt < 1000
    ) {
      return;
    }
    lastDebugLogAt = now;
    lastDebugTestCount = testAttempts;
    console.debug(
      `[Battle Simulator] ${battleId}: ${searchStage}; ` +
        `${testAttempts} tests, ${battleSimulations} battle simulations; ` +
        `army {${lastTestedComposition}}; ` +
        `tactics {${lastTestedTactics || "defaults"}}; ${lastTestOutcome}`,
    );
  };
  console.debug(
    `[Battle Simulator] ${battleId}: starting minimum-army search with ` +
      `${candidates.length} candidate unit types`,
  );
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
    testAttempts += 1;
    const key = [...composition.entries()]
      .map(([unitId, count]) => `${unitId}:${count}`)
      .sort()
      .join("|");
    lastTestedComposition = key || "(owned army only)";
    lastTestedTactics =
      [...lockedFormations]
        .map(([unitId, formation]) => `${unitId}:${formation}`)
        .join(",") +
      (lockedOrders.size > 0
        ? `; orders ${[...lockedOrders]
            .map(([unitId, order]) => `${unitId}:${order}`)
            .join(",")}`
        : "");
    if (
      countCeiling &&
      [...composition].some(([unitId, count]) =>
        count.gt(countCeiling.get(unitId) ?? ExpNumber.ZERO),
      )
    ) {
      lastTestOutcome = "loss (exceeds winning ceiling)";
      reportTestProgress();
      return false;
    }
    const cached = winCache.get(key);
    if (cached !== undefined) {
      lastTestOutcome = cached ? "WIN (cached)" : "loss (cached)";
      reportTestProgress();
      return cached;
    }
    battleSimulations += 1;
    const outcome = winsRaw(composition);
    winCache.set(key, outcome);
    lastTestOutcome = outcome ? "WIN" : "loss";
    reportTestProgress();
    return outcome;
  };
  searchStage = "checking whether the owned army wins";
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
  const two = ExpNumber.fromNumber(2);
  for (const [unitIndex, unit] of candidates.entries()) {
    if (!findUnitDefinition(unit.key)) continue;
    const maximumSoloCount = countCeiling?.get(unit.key) ?? maximumProbe;
    if (maximumSoloCount.lt(ExpNumber.ONE)) continue;
    searchStage =
      `finding solo threshold for ${unit.key} ` +
      `(${unitIndex + 1}/${candidates.length})`;
    let low = ExpNumber.ONE;
    let high = ExpNumber.min(ExpNumber.ONE, maximumSoloCount);
    while (!wins(new Map([[unit.key, high]]))) {
      if (high.gte(maximumSoloCount)) {
        high = ExpNumber.ZERO;
        break;
      }
      high = ExpNumber.min(high.mul(two), maximumSoloCount);
    }
    if (high.isZero) continue;
    while (low.lt(high)) {
      let middle = low.add(high).div(two).floor();
      if (!middle.gt(low)) middle = low.add(ExpNumber.ONE);
      if (!middle.lt(high)) break;
      if (wins(new Map([[unit.key, middle]]))) high = middle;
      else low = middle.add(ExpNumber.ONE);
    }
    seeds.push(new Map([[unit.key, high]]));
  }
  // Some battles require complementary roles: neither the siege unit nor the
  // naval unit can win alone, but their combination can. Seed the hill-climb
  // with bounded power-of-two pair searches so those armies are discoverable.
  // Powers are sized so pair searches can probe up to ~134M units per type,
  // enough for battles with 200M+ enemies (e.g. Hastings).
  if (requireMixed && seeds.length === 0) {
    const powersFor = (unitId: string): number[] => {
      const maximum = Math.min(
        2 ** 28,
        countCeiling?.get(unitId)?.floor().toNumber() ?? 2 ** 28,
      );
      const powers: number[] = [];
      for (let power = 1; power <= maximum; power *= 2) {
        powers.push(power);
      }
      if (maximum >= 1 && powers[powers.length - 1] !== maximum) {
        powers.push(maximum);
      }
      return powers;
    };
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < candidates.length;
        rightIndex += 1
      ) {
        const left = candidates[leftIndex];
        const right = candidates[rightIndex];
        const leftPowers = powersFor(left.key);
        const rightPowers = powersFor(right.key);
        const maxLeft = leftPowers[leftPowers.length - 1] ?? 0;
        const maxRight = rightPowers[rightPowers.length - 1] ?? 0;
        if (maxLeft === 0 || maxRight === 0) continue;
        searchStage =
          `checking mixed pair ${left.key} + ${right.key} ` +
          `(${leftIndex + 1}/${candidates.length}, ` +
          `${rightIndex + 1}/${candidates.length})`;
        // If maximum counts of both units cannot win, no smaller counts can either.
        if (
          !wins(
            new Map([
              [left.key, ExpNumber.fromNumber(maxLeft)],
              [right.key, ExpNumber.fromNumber(maxRight)],
            ]),
          )
        ) {
          continue;
        }

        for (const leftCount of leftPowers) {
          // If maximum rightCount cannot win with this leftCount, skip all smaller rightCounts.
          if (
            !wins(
              new Map([
                [left.key, ExpNumber.fromNumber(leftCount)],
                [right.key, ExpNumber.fromNumber(maxRight)],
              ]),
            )
          ) {
            continue;
          }

          // Binary search over powers for the minimum winning rightCount
          let lo = 0;
          let hi = rightPowers.length - 1;
          while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (
              wins(
                new Map([
                  [left.key, ExpNumber.fromNumber(leftCount)],
                  [right.key, ExpNumber.fromNumber(rightPowers[mid])],
                ]),
              )
            ) {
              hi = mid;
            } else {
              lo = mid + 1;
            }
          }
          seeds.push(
            new Map([
              [left.key, ExpNumber.fromNumber(leftCount)],
              [right.key, ExpNumber.fromNumber(rightPowers[lo])],
            ]),
          );
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
  const climb = (seed: SimulatorArmy, seedIndex: number): SimulatorArmy => {
    let current = seed;
    let currentCost = compositionCost(current, context);
    let improved = true;
    let passes = 0;
    while (improved && passes < maximumPasses) {
      improved = false;
      passes += 1;
      for (const [unitId, count] of [...current]) {
        searchStage =
          `climbing seed ${seedIndex + 1}/${seeds.length}, pass ${passes}, ` +
          `adjusting ${unitId}`;
        const bases = [
          withCount(current, unitId, count.div(two).ceil()),
          withCount(current, unitId, ExpNumber.ZERO),
        ];
        for (const base of bases) {
          for (const other of ids) {
            if (other === unitId) continue;
            const currentOtherCount = base.get(other) ?? ExpNumber.ZERO;
            const maximumOtherCount = countCeiling?.get(other) ?? maximumProbe;
            const maximumAddition = maximumOtherCount.sub(currentOtherCount);
            if (!maximumAddition.gt(ExpNumber.ZERO)) continue;
            let add = ExpNumber.ONE;
            let found = false;
            while (add.lte(maximumAddition)) {
              const trial = withCount(base, other, currentOtherCount.add(add));
              if (wins(trial)) {
                found = true;
                break;
              }
              if (add.gte(maximumAddition)) break;
              add = ExpNumber.min(add.mul(two), maximumAddition);
            }
            if (!found) continue;
            let low = ExpNumber.ONE;
            let high = add;
            while (low.lt(high)) {
              let middle = low.add(high).div(two).floor();
              if (!middle.gt(low)) middle = low.add(ExpNumber.ONE);
              if (!middle.lt(high)) break;
              const trial = withCount(
                base,
                other,
                currentOtherCount.add(middle),
              );
              if (wins(trial)) high = middle;
              else low = middle.add(ExpNumber.ONE);
            }
            const next = withCount(base, other, currentOtherCount.add(high));
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
  for (const [seedIndex, seed] of seeds.entries()) {
    searchStage = `climbing solo/pair seed ${seedIndex + 1}/${seeds.length}`;
    const climbed = climb(seed, seedIndex);
    const cost = compositionCost(climbed, context);
    if (cost.lt(bestCost)) {
      best = climbed;
      bestCost = cost;
    }
  }
  if (!best) return null;
  for (const [unitIndex, [unitId, count]] of [...best].entries()) {
    searchStage =
      `trimming final army unit ${unitId} ` + `(${unitIndex + 1}/${best.size})`;
    let lo = ExpNumber.ZERO;
    let hi = count;
    while (lo.lt(hi)) {
      let mid = lo.add(hi).div(ExpNumber.fromNumber(2)).floor();
      if (!mid.gt(lo)) mid = lo.add(ExpNumber.ONE);
      if (!mid.lt(hi)) break;
      if (wins(withCount(best, unitId, mid))) hi = mid;
      else lo = mid.add(ExpNumber.ONE);
    }
    best = withCount(best, unitId, hi);
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
  // Use Hunt the weak for Age 0/2, all available orders for Age 3+
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

  console.debug(
    `[Battle Simulator] ${battleId}: minimum-army solve finished; ` +
      `${testAttempts} tests, ${battleSimulations} battle simulations; ` +
      `winning recruits {${[...best]
        .map(([unitId, count]) => `${unitId}:${count.toString()}`)
        .join(",")}}`,
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
  let changed = true;
  while (changed) {
    changed = false;
    for (const [unitId, count] of [...trimmed]) {
      const withoutUnit = new Map(trimmed);
      withoutUnit.delete(unitId);
      if (wins(withoutUnit)) {
        trimmed.delete(unitId);
        changed = true;
        continue;
      }

      const countAsNumber = count.toNumber();
      let minimumWinningCount: ExpNumber | undefined;
      if (Number.isSafeInteger(countAsNumber)) {
        const integerCount = ExpNumber.fromNumber(countAsNumber);
        const integerTrial = new Map(trimmed);
        integerTrial.set(unitId, integerCount);
        if (integerCount.lte(count) && wins(integerTrial)) {
          let lo = 0;
          let hi = countAsNumber;
          while (lo < hi) {
            const mid = lo + Math.floor((hi - lo) / 2);
            const trial = new Map(trimmed);
            trial.set(unitId, ExpNumber.fromNumber(mid));
            if (wins(trial)) hi = mid;
            else lo = mid + 1;
          }
          minimumWinningCount = ExpNumber.fromNumber(hi);
        }
      } else {
        let lo = ExpNumber.ONE;
        let hi = count;
        const oneUnitTrial = new Map(trimmed);
        oneUnitTrial.set(unitId, ExpNumber.ONE);
        if (wins(oneUnitTrial)) {
          minimumWinningCount = ExpNumber.ONE;
        } else {
          for (let step = 0; lo.lt(hi) && step < 2048; step += 1) {
            const mid = ExpNumber.fromLog10(
              (lo.log10() + hi.log10()) / 2,
            );
            if (!mid.gt(lo) || !mid.lt(hi)) break;
            const trial = new Map(trimmed);
            trial.set(unitId, mid);
            if (wins(trial)) hi = mid;
            else lo = mid;
          }
          minimumWinningCount = hi;
        }
      }

      if (
        minimumWinningCount &&
        minimumWinningCount.gt(ExpNumber.ZERO) &&
        minimumWinningCount.lt(count)
      ) {
        trimmed.set(unitId, minimumWinningCount);
        changed = true;
      }
    }
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
 * single tactic changes, then paired formation changes, against the owned army
 * plus 80% of recruits. Trim accepted changes and re-solve under those tactics.
 */
export type TacticalDoctrine =
  | "standard"
  | "shock"
  | "rush"
  | "turtle"
  | "frontline";

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

/**
 * Searches the owned army's formations and orders, strongest unit first.
 * Returns the best tactical setup even when it still needs more units.
 */
export const optimizeOwnedArmyTactics = (
  battleId: string,
  context: BattleSimulatorContext,
  ownedArmy: SimulatorOwnedArmy,
  availableFormations: readonly FormationId[],
  availableOrders: readonly OrderId[],
  initialFormations: ReadonlyMap<string, FormationId> = new Map(),
  initialOrders: ReadonlyMap<string, OrderId> = new Map(),
): SimulatorTacticSearch | null => {
  const activeOwnedUnitIds = [...ownedArmy.entries()]
    .filter(([, count]) => count.gt(ExpNumber.ZERO))
    .sort(([leftId, leftCount], [rightId, rightCount]) => {
      const left = findUnitDefinition(leftId);
      const right = findUnitDefinition(rightId);
      const leftStrength = left
        ? unitPower(left.stats).mul(leftCount)
        : ExpNumber.ZERO;
      const rightStrength = right
        ? unitPower(right.stats).mul(rightCount)
        : ExpNumber.ZERO;
      return rightStrength.compareTo(leftStrength);
    })
    .map(([id]) => id);

  if (activeOwnedUnitIds.length === 0) return null;

  const totalComposition: SimulatorTotalArmy = new Map(ownedArmy);

  const winsTactics = (
    formations: ReadonlyMap<string, FormationId>,
    orders: ReadonlyMap<string, OrderId>,
  ): boolean =>
    context.winsWithFormationsAndOrders(
      totalComposition,
      formations,
      orders,
      battleId,
    );

  // 1. Check current tactics
  const currentFormations = new Map<string, FormationId>(
    activeOwnedUnitIds.map((id) => [
      id,
      availableFormations.includes(
        initialFormations.get(id) ?? DEFAULT_FORMATION,
      )
        ? (initialFormations.get(id) ?? DEFAULT_FORMATION)
        : DEFAULT_FORMATION,
    ]),
  );
  const currentOrders = new Map<string, OrderId>(
    activeOwnedUnitIds.map((id) => [
      id,
      availableOrders.includes(initialOrders.get(id) ?? DEFAULT_ORDER)
        ? (initialOrders.get(id) ?? DEFAULT_ORDER)
        : DEFAULT_ORDER,
    ]),
  );
  // 2. Check default tactics (all standard)
  const defaultFormations = new Map<string, FormationId>(
    activeOwnedUnitIds.map((id) => [id, DEFAULT_FORMATION]),
  );
  const defaultOrders = new Map<string, OrderId>(
    activeOwnedUnitIds.map((id) => [id, DEFAULT_ORDER]),
  );
  // 3. Check macro doctrines (shock, rush, turtle, frontline)
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
  if (availableFormations.includes("turtle")) doctrines.push("turtle");
  if (
    availableFormations.includes("frontline") &&
    availableFormations.includes("backline")
  ) {
    doctrines.push("frontline");
  }

  const keyOrders: OrderId[] = [DEFAULT_ORDER];
  for (const ord of ["focus_weak", "focus_strong", "focus_counter"] as const) {
    if (ord !== DEFAULT_ORDER && availableOrders.includes(ord)) {
      keyOrders.push(ord);
    }
  }

  const isBetterTactic = (
    formations: ReadonlyMap<string, FormationId>,
    orders: ReadonlyMap<string, OrderId>,
    metrics: SimulatorBattleMetrics | undefined,
    currentFormations: ReadonlyMap<string, FormationId>,
    currentOrders: ReadonlyMap<string, OrderId>,
    currentMetrics: SimulatorBattleMetrics | undefined,
  ): boolean => {
    const wins = winsTactics(formations, orders);
    const currentWins = winsTactics(currentFormations, currentOrders);
    if (wins !== currentWins) return wins;
    if (battleMetricsAreBetter(metrics, currentMetrics, wins)) return true;
    if (battleMetricsAreBetter(currentMetrics, metrics, wins)) return false;
    const deviations = (
      candidateFormations: ReadonlyMap<string, FormationId>,
      candidateOrders: ReadonlyMap<string, OrderId>,
    ): number =>
      [...candidateFormations.values()].filter(
        (value) => value !== DEFAULT_FORMATION,
      ).length +
      [...candidateOrders.values()].filter((value) => value !== DEFAULT_ORDER)
        .length;
    return (
      deviations(formations, orders) <
      deviations(currentFormations, currentOrders)
    );
  };

  let bestTactics = {
    formations: currentFormations,
    orders: currentOrders,
    metrics: context.getBattleMetrics?.(
      totalComposition,
      currentFormations,
      currentOrders,
      battleId,
    ),
  };
  const defaultMetrics = context.getBattleMetrics?.(
    totalComposition,
    defaultFormations,
    defaultOrders,
    battleId,
  );
  if (
    isBetterTactic(
      defaultFormations,
      defaultOrders,
      defaultMetrics,
      bestTactics.formations,
      bestTactics.orders,
      bestTactics.metrics,
    )
  ) {
    bestTactics = {
      formations: defaultFormations,
      orders: defaultOrders,
      metrics: defaultMetrics,
    };
  }

  for (const doc of doctrines) {
    const docFormations = buildDoctrineFormations(
      activeOwnedUnitIds,
      doc,
      availableFormations,
    );
    for (const ord of keyOrders) {
      const docOrders = new Map<string, OrderId>(
        activeOwnedUnitIds.map((id) => [id, ord]),
      );
      const metrics = context.getBattleMetrics?.(
        totalComposition,
        docFormations,
        docOrders,
        battleId,
      );
      if (
        isBetterTactic(
          docFormations,
          docOrders,
          metrics,
          bestTactics.formations,
          bestTactics.orders,
          bestTactics.metrics,
        )
      ) {
        bestTactics = { formations: docFormations, orders: docOrders, metrics };
      }
    }
  }

  // 4. Local coordinate search / hill-climb from best candidate tactics
  let curFormations = new Map(bestTactics.formations);
  let curOrders = new Map(bestTactics.orders);
  let curMetrics = bestTactics.metrics;

  // Search formations first, then orders. Within each phase, stronger stacks
  // get first choice and each accepted change becomes the next starting point.
  for (let pass = 0; pass < 2; pass += 1) {
    let improved = false;
    for (const unitId of activeOwnedUnitIds) {
      for (const form of availableFormations) {
        if (curFormations.get(unitId) === form) continue;
        const testFormations = new Map(curFormations);
        testFormations.set(unitId, form);
        const outcome = winsTactics(testFormations, curOrders);
        const metrics = context.getBattleMetrics?.(
          totalComposition,
          testFormations,
          curOrders,
          battleId,
        );
        const kept = isBetterTactic(
          testFormations,
          curOrders,
          metrics,
          curFormations,
          curOrders,
          curMetrics,
        );
        if (kept) {
          curFormations = testFormations;
          curMetrics = metrics;
          improved = true;
        }
        console.debug(
          `[Battle Simulator] ${battleId}: testing formation ${unitId} -> ${form}; ` +
            `${outcome ? "WIN" : "loss"}` +
            (metrics
              ? `; casualties player ${metrics.playerCasualtyRate}% / ` +
                `enemy ${metrics.enemyCasualtyRate}%`
              : "") +
            ` -> ${curFormations.get(unitId) ?? DEFAULT_FORMATION} kept`,
        );
      }
    }
    for (const unitId of activeOwnedUnitIds) {
      for (const ord of availableOrders) {
        if (curOrders.get(unitId) === ord) continue;
        const testOrders = new Map(curOrders);
        testOrders.set(unitId, ord);
        const outcome = winsTactics(curFormations, testOrders);
        const metrics = context.getBattleMetrics?.(
          totalComposition,
          curFormations,
          testOrders,
          battleId,
        );
        const kept = isBetterTactic(
          curFormations,
          testOrders,
          metrics,
          curFormations,
          curOrders,
          curMetrics,
        );
        if (kept) {
          curOrders = testOrders;
          curMetrics = metrics;
          improved = true;
        }
        console.debug(
          `[Battle Simulator] ${battleId}: testing order ${unitId} -> ${ord}; ` +
            `${outcome ? "WIN" : "loss"}` +
            (metrics
              ? `; casualties player ${metrics.playerCasualtyRate}% / ` +
                `enemy ${metrics.enemyCasualtyRate}%`
              : "") +
            ` -> ${curOrders.get(unitId) ?? DEFAULT_ORDER} kept`,
        );
      }
    }
    if (!improved) break;
  }

  const wins = winsTactics(curFormations, curOrders);
  const battleMetrics = context.getBattleMetrics?.(
    totalComposition,
    curFormations,
    curOrders,
    battleId,
  );
  return {
    formations: curFormations,
    orders: curOrders,
    wins,
    ...(battleMetrics ? { battleMetrics } : {}),
  };
};

export const solveOwnedArmyTactics = (
  battleId: string,
  context: BattleSimulatorContext,
  ownedArmy: SimulatorOwnedArmy,
  availableFormations: readonly FormationId[],
  availableOrders: readonly OrderId[],
  initialFormations: ReadonlyMap<string, FormationId> = new Map(),
  initialOrders: ReadonlyMap<string, OrderId> = new Map(),
): SimulatorResult | null => {
  const optimized = optimizeOwnedArmyTactics(
    battleId,
    context,
    ownedArmy,
    availableFormations,
    availableOrders,
    initialFormations,
    initialOrders,
  );
  if (!optimized?.wins) return null;
  const totalComposition = new Map(ownedArmy);
  return {
    composition: new Map(),
    totalComposition,
    military: ExpNumber.ZERO,
    totalCost: [],
    research: { ids: [], costs: [] },
    formations: new Map(optimized.formations),
    orders: new Map(optimized.orders),
    ...(optimized.battleMetrics
      ? { battleMetrics: optimized.battleMetrics }
      : {}),
  };
};

export const optimizeBattleTactics = (
  battleId: string,
  candidates: readonly SimulatorCandidate[],
  rawContext: BattleSimulatorContext,
  requireMixed = false,
  ownedArmy: SimulatorOwnedArmy = new Map(),
  initialFormations: ReadonlyMap<string, FormationId> = new Map(),
  initialOrders: ReadonlyMap<string, OrderId> = new Map(),
  formationChoices?: readonly FormationId[],
  orderChoices?: readonly OrderId[],
  onProgress?: SimulatorProgress,
  historicalSeeds: readonly SimulatorHistoricalSeed[] = [],
): SimulatorResult | null => {
  const encounter = encounterDefinitions.find(({ key }) => key === battleId);
  if (!encounter) return null;

  const outcomeCache = new Map<string, boolean>();
  const metricsCache = new Map<string, SimulatorBattleMetrics>();

  const context: BattleSimulatorContext = {
    ...rawContext,
    wins: (composition, bid) => {
      const key = [...composition.entries()]
        .map(([u, c]) => `${u}:${c.toString()}`)
        .sort()
        .join("|");
      const cached = outcomeCache.get(key);
      if (cached !== undefined) return cached;
      const res = rawContext.wins(composition, bid);
      outcomeCache.set(key, res);
      return res;
    },
    winsWithFormations: (composition, formations, bid) => {
      const cKey = [...composition.entries()]
        .map(([u, c]) => `${u}:${c.toString()}`)
        .sort()
        .join("|");
      const fKey = [...formations.entries()]
        .map(([u, f]) => `${u}:${f}`)
        .sort()
        .join("|");
      const key = `${cKey}#${fKey}`;
      const cached = outcomeCache.get(key);
      if (cached !== undefined) return cached;
      const res = rawContext.winsWithFormations(composition, formations, bid);
      outcomeCache.set(key, res);
      return res;
    },
    winsWithFormationsAndOrders: (composition, formations, orders, bid) => {
      const cKey = [...composition.entries()]
        .map(([u, c]) => `${u}:${c.toString()}`)
        .sort()
        .join("|");
      const fKey = [...formations.entries()]
        .map(([u, f]) => `${u}:${f}`)
        .sort()
        .join("|");
      const oKey = [...orders.entries()]
        .map(([u, o]) => `${u}:${o}`)
        .sort()
        .join("|");
      const key = `${cKey}#${fKey}#${oKey}`;
      const cached = outcomeCache.get(key);
      if (cached !== undefined) return cached;
      const res = rawContext.winsWithFormationsAndOrders(
        composition,
        formations,
        orders,
        bid,
      );
      outcomeCache.set(key, res);
      return res;
    },
    getBattleMetrics: rawContext.getBattleMetrics
      ? (composition, formations, orders, bid) => {
          const cKey = [...composition.entries()]
            .map(([u, c]) => `${u}:${c.toString()}`)
            .sort()
            .join("|");
          const fKey = [...formations.entries()]
            .map(([u, f]) => `${u}:${f}`)
            .sort()
            .join("|");
          const oKey = [...orders.entries()]
            .map(([u, o]) => `${u}:${o}`)
            .sort()
            .join("|");
          const key = `${cKey}#${fKey}#${oKey}`;
          const cached = metricsCache.get(key);
          if (cached !== undefined) return cached;
          const res = rawContext.getBattleMetrics!(
            composition,
            formations,
            orders,
            bid,
          );
          metricsCache.set(key, res);
          return res;
        }
      : undefined,
  };
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
  let lastReportedPlan: SimulatorResult | null = null;
  const reportImprovement = (plan: SimulatorResult, phase: string): void => {
    if (!onProgress) return;
    const improved =
      !lastReportedPlan || planIsBetter(plan, lastReportedPlan, context);
    if (improved) {
      lastReportedPlan = plan;
    }
    onProgress(lastReportedPlan ?? plan, phase, improved);
  };

  let formations = assignDefaults(
    availableFormations,
    initialFormations,
    DEFAULT_FORMATION,
  );
  let orders = assignDefaults(availableOrders, initialOrders, DEFAULT_ORDER);
  let best: SimulatorResult | null = null;
  const allowedUnitIds = new Set([
    ...candidates.map(({ key }) => key),
    ...ownedArmy.keys(),
  ]);
  const usableHistoricalSeeds = historicalSeeds.flatMap((seed) => {
    const playerArmy = seed.playerArmy.filter(({ unitId }) =>
      allowedUnitIds.has(unitId),
    );
    return playerArmy.length > 0 ? [{ playerArmy }] : [];
  });
  const optimizedSeedTactics: (readonly [
    ReadonlyMap<string, FormationId>,
    ReadonlyMap<string, OrderId>,
  ])[] = [];
  for (const seed of usableHistoricalSeeds) {
    const seedArmy = new Map<string, ExpNumber>();
    for (const { unitId, count } of seed.playerArmy) {
      const parsedCount = ExpNumber.from(count);
      if (!parsedCount.isFinite || !parsedCount.gt(ExpNumber.ZERO)) continue;
      seedArmy.set(
        unitId,
        (seedArmy.get(unitId) ?? ExpNumber.ZERO).add(parsedCount),
      );
    }
    if (seedArmy.size === 0) continue;

    const seedAdditional = new Map<string, ExpNumber>();
    for (const [unitId, count] of seedArmy) {
      const additional = ExpNumber.max(
        ExpNumber.ZERO,
        count.sub(ownedArmy.get(unitId) ?? ExpNumber.ZERO),
      );
      if (additional.gt(ExpNumber.ZERO)) seedAdditional.set(unitId, additional);
    }
    const seedFormations = assignDefaults(
      availableFormations,
      new Map(
        seed.playerArmy.map(({ unitId, formation }) => [unitId, formation]),
      ),
      DEFAULT_FORMATION,
    );
    const seedOrders = assignDefaults(
      availableOrders,
      new Map(seed.playerArmy.map(({ unitId, order }) => [unitId, order])),
      DEFAULT_ORDER,
    );
    const seedTotal = mergeSimulatorArmy(ownedArmy, seedAdditional);
    const tunedSeed = optimizeOwnedArmyTactics(
      battleId,
      context,
      seedTotal,
      availableFormations,
      availableOrders,
      seedFormations,
      seedOrders,
    );
    if (!tunedSeed) continue;
    const winningFormations = tunedSeed.formations;
    const winningOrders = tunedSeed.orders;
    optimizedSeedTactics.push([
      assignDefaults(availableFormations, winningFormations, DEFAULT_FORMATION),
      assignDefaults(availableOrders, winningOrders, DEFAULT_ORDER),
    ]);
    if (!tunedSeed.wins) continue;

    const trimmed = trimUnderTactics(
      seedAdditional,
      ownedArmy,
      winningFormations,
      winningOrders,
      battleId,
      context,
    );
    const totalComposition = mergeSimulatorArmy(ownedArmy, trimmed);
    const seedPlan = withMetrics({
      composition: trimmed,
      totalComposition,
      military: compositionCost(trimmed, context),
      totalCost: sumCosts(trimmed, context),
      research: context.getResearch(additionalUnitIds(ownedArmy, trimmed)),
      formations: winningFormations,
      orders: winningOrders,
    });
    if (
      !context.winsWithFormationsAndOrders(
        seedPlan.totalComposition,
        seedPlan.formations,
        seedPlan.orders,
        battleId,
      )
    )
      continue;
    const improvesBest =
      !best || planIsBetter(seedPlan, withMetrics(best), context);
    if (improvesBest) lastReportedPlan = seedPlan;
    onProgress?.(
      seedPlan,
      "Saved starting army wins after formation/order optimization",
      improvesBest,
    );
    if (improvesBest) {
      best = seedPlan;
      formations = new Map(winningFormations);
      orders = new Map(winningOrders);
    }
  }

  const defaultFormations = assignDefaults(
    availableFormations,
    new Map(),
    DEFAULT_FORMATION,
  );
  const defaultOrders = assignDefaults(
    availableOrders,
    new Map(),
    DEFAULT_ORDER,
  );
  const tacticSeeds: (readonly [
    ReadonlyMap<string, FormationId>,
    ReadonlyMap<string, OrderId>,
  ])[] = [
    [formations, orders],
    ...optimizedSeedTactics,
    [defaultFormations, defaultOrders],
  ];
  const uniqueTacticSeeds = tacticSeeds
    .filter(([seedFormations, seedOrders], index, all) => {
      const key = `${formatTactics(seedFormations)}|${formatTactics(seedOrders)}`;
      return (
        all.findIndex(
          ([otherFormations, otherOrders]) =>
            `${formatTactics(otherFormations)}|${formatTactics(otherOrders)}` ===
            key,
        ) === index
      );
    })
    .slice(0, 5);

  let winningCountCeiling: Map<string, ExpNumber> | undefined;
  // Always establish a balanced-army ceiling, even when a smaller win was
  // found under one fixed tactic set. It gives the later unit-removal search a
  // known winning army and tests each saved starting tactic independently.
  if (candidates.length > 0) {
    for (const [seedFormations, seedOrders] of uniqueTacticSeeds) {
      for (let count = 1; count <= 2 ** 28; count *= 2) {
        const balancedArmy = new Map(
          candidates.map(({ key }) => [key, ExpNumber.fromNumber(count)]),
        );
        const balancedTotal = mergeSimulatorArmy(ownedArmy, balancedArmy);
        const wins = context.winsWithFormationsAndOrders(
          balancedTotal,
          seedFormations,
          seedOrders,
          battleId,
        );
        console.debug(
          `[Battle Simulator] ${battleId}: balanced ceiling test ` +
            `${count}/unit, ${candidates.length} unit types; ` +
            `units [${candidates.map(({ key }) => key).join(", ")}]; ` +
            `formations {${formatTactics(seedFormations)}}; ` +
            `orders {${formatTactics(seedOrders)}}; ${wins ? "WIN" : "loss"}`,
        );
        if (!wins) continue;

        winningCountCeiling ??= new Map();
        for (const [unitId, count] of balancedArmy) {
          winningCountCeiling.set(
            unitId,
            ExpNumber.max(
              winningCountCeiling.get(unitId) ?? ExpNumber.ZERO,
              count,
            ),
          );
        }
        const ceilingPlan = withMetrics({
          composition: balancedArmy,
          totalComposition: balancedTotal,
          military: compositionCost(balancedArmy, context),
          totalCost: sumCosts(balancedArmy, context),
          research: context.getResearch(
            additionalUnitIds(ownedArmy, balancedArmy),
          ),
          formations: seedFormations,
          orders: seedOrders,
        });
        const improvesBest =
          !best || planIsBetter(ceilingPlan, withMetrics(best), context);
        if (improvesBest) lastReportedPlan = ceilingPlan;
        onProgress?.(
          ceilingPlan,
          `Balanced army ceiling wins at ${count} of each candidate unit`,
          improvesBest,
        );
        if (improvesBest) {
          best = ceilingPlan;
          formations = new Map(seedFormations);
          orders = new Map(seedOrders);
        }

        const startingComposition = trimUnderTactics(
          balancedArmy,
          ownedArmy,
          seedFormations,
          seedOrders,
          battleId,
          context,
        );
        const startingTotal = mergeSimulatorArmy(
          ownedArmy,
          startingComposition,
        );
        const startingPlan = withMetrics({
          composition: startingComposition,
          totalComposition: startingTotal,
          military: compositionCost(startingComposition, context),
          totalCost: sumCosts(startingComposition, context),
          research: context.getResearch(
            additionalUnitIds(ownedArmy, startingComposition),
          ),
          formations: seedFormations,
          orders: seedOrders,
        });
        const ceilingWasTrimmed =
          startingComposition.size !== balancedArmy.size ||
          [...balancedArmy].some(
            ([unitId, count]) => !startingComposition.get(unitId)?.eq(count),
          );
        if (ceilingWasTrimmed) {
          const improvesBest =
            !best || planIsBetter(startingPlan, withMetrics(best), context);
          if (improvesBest) {
            best = startingPlan;
            lastReportedPlan = startingPlan;
            formations = new Map(seedFormations);
            orders = new Map(seedOrders);
          }
          onProgress?.(
            startingPlan,
            "Reduced balanced ceiling before formation/order search",
            improvesBest,
          );
        }

        // Search tactics on the reduced winning army, not the ceiling-sized one.
        const tuned = optimizeOwnedArmyTactics(
          battleId,
          context,
          startingTotal,
          availableFormations,
          availableOrders,
          seedFormations,
          seedOrders,
        );
        const winningFormations = tuned?.formations ?? seedFormations;
        const winningOrders = tuned?.orders ?? seedOrders;
        const trimmed = trimUnderTactics(
          startingComposition,
          ownedArmy,
          winningFormations,
          winningOrders,
          battleId,
          context,
        );
        const totalComposition = mergeSimulatorArmy(ownedArmy, trimmed);
        const balancedPlan = withMetrics({
          composition: trimmed,
          totalComposition,
          military: compositionCost(trimmed, context),
          totalCost: sumCosts(trimmed, context),
          research: context.getResearch(additionalUnitIds(ownedArmy, trimmed)),
          formations: winningFormations,
          orders: winningOrders,
        });
        if (
          context.winsWithFormationsAndOrders(
            balancedPlan.totalComposition,
            balancedPlan.formations,
            balancedPlan.orders,
            battleId,
          )
        ) {
          const improvesBest =
            !best || planIsBetter(balancedPlan, withMetrics(best), context);
          if (improvesBest) lastReportedPlan = balancedPlan;
          onProgress?.(
            balancedPlan,
            "Trimmed the balanced winning ceiling and re-optimized tactics",
            improvesBest,
          );
          if (improvesBest) {
            best = balancedPlan;
            formations = new Map(winningFormations);
            orders = new Map(winningOrders);
          }
        }
        break;
      }
    }
  }
  const armySolveSeeds = [
    [formations, orders] as const,
    ...optimizedSeedTactics,
    [defaultFormations, defaultOrders] as const,
  ]
    .filter(([seedFormations, seedOrders], index, all) => {
      const key = `${formatTactics(seedFormations)}|${formatTactics(seedOrders)}`;
      return (
        all.findIndex(
          ([otherFormations, otherOrders]) =>
            `${formatTactics(otherFormations)}|${formatTactics(otherOrders)}` ===
            key,
        ) === index
      );
    })
    .slice(0, 5);
  for (const [seedFormations, seedOrders] of armySolveSeeds) {
    const solved = solveMinimumArmy(
      battleId,
      candidates,
      context,
      requireMixed,
      ownedArmy,
      seedFormations,
      seedOrders,
      winningCountCeiling,
    );
    if (!solved) continue;
    const candidatePlan = withMetrics(solved);
    const improvesBest =
      !best || planIsBetter(candidatePlan, withMetrics(best), context);
    if (improvesBest) lastReportedPlan = candidatePlan;
    onProgress?.(
      candidatePlan,
      "Winning army found after balanced ceiling and tactic refinement",
      improvesBest,
    );
    if (improvesBest) {
      best = candidatePlan;
      formations = new Map(seedFormations);
      orders = new Map(seedOrders);
    }
  }
  if (!best) return null;

  const paretoPlans: SimulatorPlan[] = [];
  let paretoPlansTruncated = false;
  const registerParetoPlan = (plan: SimulatorPlan): void => {
    if (!isWinningPlan(plan)) return;
    const key = samePlanKey(plan);
    if (paretoPlans.some((current) => samePlanKey(current) === key)) return;
    const equivalentIndex = paretoPlans.findIndex((current) =>
      samePlanCosts(current, plan),
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
  console.log(
    `[OPT START] ${battleId} cand=${candidates.length}: bestCost=${bestCost.toString()}`,
  );
  reportImprovement(bestResult, "Winning plan found for the current tactics");

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
      winningCountCeiling,
    );
    if (docSolved) {
      const docPlan = withMetrics(docSolved);
      registerParetoPlan(docPlan);
      if (planIsBetter(docPlan, bestResult, context)) {
        bestResult = docPlan;
        formations = new Map(docFormations);
        orders = new Map(docOrders);
        bestCost = compositionCost(bestResult.composition, context);
        console.log(
          `[OPT DOC ${doc}] ${battleId} cand=${candidates.length}: bestCost=${bestCost.toString()}`,
        );
        reportImprovement(bestResult, `Re-solved army under ${doc} doctrine`);
      }
    }
  }

  const maximumTacticIterations = 12;
  let tacticIteration = 0;
  for (;;) {
    if (tacticIteration >= maximumTacticIterations) break;
    tacticIteration += 1;
    const tacticalUnitIds = [...bestResult.totalComposition.keys()].sort(
      (left, right) => {
        const leftDefinition = findUnitDefinition(left);
        const rightDefinition = findUnitDefinition(right);
        const leftPower = leftDefinition
          ? unitPower(leftDefinition.stats).mul(
              bestResult.totalComposition.get(left) ?? ExpNumber.ZERO,
            )
          : ExpNumber.ZERO;
        const rightPower = rightDefinition
          ? unitPower(rightDefinition.stats).mul(
              bestResult.totalComposition.get(right) ?? ExpNumber.ZERO,
            )
          : ExpNumber.ZERO;
        return rightPower.compareTo(leftPower);
      },
    );
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
    const tacticProbeArmy = new Map<string, ExpNumber>(ownedArmy);
    for (const [unitId, count] of bestResult.composition) {
      const reducedCount = count
        .mul(ExpNumber.fromNumber(tacticSearchProbeFraction))
        .floor();
      if (reducedCount.gt(ExpNumber.ZERO)) {
        tacticProbeArmy.set(
          unitId,
          (tacticProbeArmy.get(unitId) ?? ExpNumber.ZERO).add(reducedCount),
        );
      }
    }
    const currentTacticMetrics = context.getBattleMetrics?.(
      tacticProbeArmy,
      formations,
      orders,
      battleId,
    );
    const consider = (
      trialFormations: ReadonlyMap<string, FormationId>,
      trialOrders: ReadonlyMap<string, OrderId>,
    ): string => {
      const trialKey = tacticKey(trialFormations, trialOrders);
      if (visitedTactics.has(trialKey)) return "already tested";
      const currentArmyWins = context.winsWithFormationsAndOrders(
        tacticProbeArmy,
        trialFormations,
        trialOrders,
        battleId,
      );
      if (!currentArmyWins) {
        const metrics = context.getBattleMetrics?.(
          tacticProbeArmy,
          trialFormations,
          trialOrders,
          battleId,
        );
        if (
          battleMetricsAreBetter(metrics, currentTacticMetrics) &&
          (!exploratory || battleMetricsAreBetter(metrics, exploratory.metrics))
        ) {
          if (metrics) {
            exploratory = {
              formations: trialFormations,
              orders: trialOrders,
              metrics,
            };
          }
        }
        return "loss with 80% recruits";
      }

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
        research: context.getResearch(additionalUnitIds(ownedArmy, trimmed)),
        formations: trialFormations,
        orders: trialOrders,
      });
      if (!isWinningPlan(candidatePlan)) return "loss after count trimming";
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
      return improvesBest ? "WIN; cheaper army" : "WIN; not cheaper";
    };

    for (const unitId of tacticalUnitIds) {
      for (const formation of availableFormations) {
        if (formations.get(unitId) === formation) continue;
        const trialFormations = new Map(formations);
        trialFormations.set(unitId, formation);
        attempts += 1;
        const outcome = consider(trialFormations, orders);
        reportImprovement(
          bestResult,
          `Testing ${unitId}: formation ${formation} (${attempts}) — ${outcome}`,
        );
      }
      for (const order of availableOrders) {
        if (orders.get(unitId) === order) continue;
        const trialOrders = new Map(orders);
        trialOrders.set(unitId, order);
        attempts += 1;
        const outcome = consider(formations, trialOrders);
        reportImprovement(
          bestResult,
          `Testing ${unitId}: order ${order} (${attempts}) — ${outcome}`,
        );
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
        const outcome = consider(trialFormations, orders);
        reportImprovement(
          bestResult,
          `Testing combination: ${first.unitId} ${first.formation} + ${second.unitId} ${second.formation} (${attempts}) — ${outcome}`,
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
      winningCountCeiling,
    );
    let improvedPlan: SimulatorPlan | undefined;
    if (reSolved) {
      const resolvedPlan = withMetrics(reSolved);
      if (planIsBetter(resolvedPlan, bestResult, context)) {
        improvedPlan = resolvedPlan;
      }
    }
    if (
      next &&
      planIsBetter(next.plan, bestResult, context) &&
      (!improvedPlan || planIsBetter(next.plan, improvedPlan, context))
    ) {
      improvedPlan = next.plan;
    }
    if (!improvedPlan) break;
    bestResult = improvedPlan;
    formations = new Map(bestResult.formations);
    orders = new Map(bestResult.orders);
    registerParetoPlan(bestResult);
    bestCost = compositionCost(bestResult.composition, context);
    console.log(
      `[OPT ITER ${tacticIteration}] cand=${candidates.length}: bestCost=${bestCost.toString()}`,
    );
    reportImprovement(
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
      const scaled = new Map<string, ExpNumber>();
      for (const [unitId, count] of basePlan.composition) {
        const refinedCount = ExpNumber.min(
          maximumProbe,
          count.mul(ExpNumber.fromNumber(scale)).ceil(),
        );
        if (refinedCount.gt(ExpNumber.ZERO)) scaled.set(unitId, refinedCount);
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
        const count = (reinforced.get(unitId) ?? ExpNumber.ZERO).add(
          ExpNumber.fromNumber(additionalCount),
        );
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
    paretoPlansTruncated || orderedParetoPlans.length > maximumParetoPlans + 1;
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
