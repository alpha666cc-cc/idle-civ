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
export type SimulatorResult = {
  /** Additional recruits only; the player's current army is not charged again. */
  readonly composition: SimulatorArmy;
  /** Full army used to test the battle, including currently owned units. */
  readonly totalComposition: SimulatorTotalArmy;
  readonly military: ExpNumber;
  readonly totalCost: readonly SimulatorCostTotal[];
  readonly research: SimulatorResearch;
  /** Optimal formation per unit type for this battle. */
  readonly formations: ReadonlyMap<string, FormationId>;
  /** Optimal targeting order per unit type for this battle. */
  readonly orders: ReadonlyMap<string, OrderId>;
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
        .map(([unitId, tactic]) => `${unitId}:${tactic}`)
        .join(" ");

/**
 * Alternate between finding the minimum army for fixed tactics and testing
 * recruit formations/orders against progressively larger fractions of it.
 * Keep tactic changes only when trimming recruits lowers their exact cost, then
 * re-solve the minimum army under those tactics.
 */
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

  const tacticalUnitIds = [...best.composition.keys()];
  let bestResult = best;
  let bestCost = compositionCost(bestResult.composition, context);
  onProgress?.(bestResult, "Minimum army for the current tactics");
  let attempts = 0;
  const visitedTactics = new Set<string>();
  const tacticKey = (
    currentFormations: ReadonlyMap<string, FormationId>,
    currentOrders: ReadonlyMap<string, OrderId>,
  ): string =>
    `${formatTactics(currentFormations)}|${formatTactics(currentOrders)}`;
  visitedTactics.add(tacticKey(formations, orders));

  for (;;) {
    let next:
      | {
          readonly composition: SimulatorArmy;
          readonly formations: ReadonlyMap<string, FormationId>;
          readonly orders: ReadonlyMap<string, OrderId>;
          readonly cost: ExpNumber;
        }
      | undefined;
    const consider = (
      trialFormations: ReadonlyMap<string, FormationId>,
      trialOrders: ReadonlyMap<string, OrderId>,
    ): void => {
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
      if (cost.lt(bestCost) && (!next || cost.lt(next.cost))) {
        next = {
          composition: trimmed,
          formations: trialFormations,
          orders: trialOrders,
          cost,
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
    if (!next) break;

    const nextKey = tacticKey(next.formations, next.orders);
    if (visitedTactics.has(nextKey)) break;
    visitedTactics.add(nextKey);
    formations = new Map(next.formations);
    orders = new Map(next.orders);
    const reSolved = solveMinimumArmy(
      battleId,
      candidates,
      context,
      requireMixed,
      ownedArmy,
      formations,
      orders,
    );
    bestResult =
      reSolved && compositionCost(reSolved.composition, context).lte(next.cost)
        ? reSolved
        : {
            composition: next.composition,
            totalComposition: mergeSimulatorArmy(ownedArmy, next.composition),
            military: next.cost,
            totalCost: sumCosts(next.composition, context),
            research: context.getResearch(
              additionalUnitIds(ownedArmy, next.composition),
            ),
            formations,
            orders,
          };
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
  return {
    ...bestResult,
    military: bestCost,
    formations,
    orders,
  };
};
