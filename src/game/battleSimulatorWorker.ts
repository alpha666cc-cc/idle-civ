/**
 * Battle-simulator Web Worker.
 *
 * The main thread serialises every ExpNumber before posting; this worker
 * deserialises them, runs the optimiser, and posts progress + the final
 * result back. The worker never touches the DOM or React — only pure game
 * domain modules are imported.
 */
import { ExpNumber } from "./expNumber";
import { calculateCostSeries, type CostParameters } from "./buyableCost";
import {
  simulateBattleOutcome,
  simulateBattleSummary,
} from "./battle";
import type { ArmyStack } from "./battle";
import type { FormationId } from "./formations";
import { DEFAULT_FORMATION } from "./formations";
import type { OrderId } from "./orders";
import { DEFAULT_ORDER } from "./orders";
import {
  optimizeBattleTactics,
  optimizeOwnedArmyTactics,
  proveMinimumMilitaryWinner,
  type SimulatorArmy,
  type SimulatorOwnedArmy,
  type SimulatorTotalArmy,
  type BattleSimulatorContext,
  type SimulatorCandidate,
  type SimulatorCostTotal,
  type SimulatorBattleMetrics,
  type SimulatorPlan,
  type SimulatorResult,
  type SimulatorHistoricalSeed,
} from "./battleSimulator";
import type { ResourceKey } from "./attributes";

// ---------------------------------------------------------------------------
// Wire types — what goes over postMessage
// ---------------------------------------------------------------------------

export type SerializedExpNumber = { s: number; m: number; e: number };

export type SerializedUnitStats = {
  hp: SerializedExpNumber;
  attack: SerializedExpNumber;
  armor: number;
  range: number;
  speed: number;
  accuracy: number;
};

export type SerializedCostParameters = {
  resource: ResourceKey;
  base: SerializedExpNumber;
  factor: number;
  exponent: number;
  unitBase: SerializedExpNumber;
  unitFactor: SerializedExpNumber;
  reductions: {
    base: SerializedExpNumber;
    factor: SerializedExpNumber;
    percent: SerializedExpNumber;
    flat: SerializedExpNumber;
  };
};

export type SerializedArmyStack = {
  unitId: string;
  count: SerializedExpNumber;
  stats: SerializedUnitStats;
  formation?: FormationId;
  order?: OrderId;
};

export type WorkerInput = {
  type: "start";
  battleId: string;
  battleAge: number;
  /** Pre-computed stats for every candidate unit, keyed by unitId. */
  candidateStats: Record<string, SerializedUnitStats>;
  /** Candidate unit IDs in the order the solver should try them. */
  candidateIds: string[];
  /** Candidates with exact unit-cost curve parameters. */
  candidateCosts: [string, SerializedCostParameters[]][];
  /** Unbought unlock-research IDs associated with each available unit. */
  candidateResearchIds: Record<string, string[]>;
  /** Sequential research cost curves indexed by required unique tech count. */
  researchCostsByCount: {
    resource: ResourceKey;
    base: SerializedExpNumber;
  }[][];
  /** Currently owned army counts. */
  ownedArmy: [string, SerializedExpNumber][];
  /** Fully serialised enemy stacks for the battle. */
  enemyStacks: SerializedArmyStack[];
  availableFormations: FormationId[];
  availableOrders: OrderId[];
  requireMixed: boolean;
  currentFormations?: [string, FormationId][];
  currentOrders?: [string, OrderId][];
  historicalSeeds?: SimulatorHistoricalSeed[];
};

export type SerializedSimulatorPlan = {
  composition: [string, SerializedExpNumber][];
  totalComposition: [string, SerializedExpNumber][];
  military: SerializedExpNumber;
  totalCost: { resource: string; base: SerializedExpNumber }[];
  research: { ids: string[]; costs: { resource: string; base: SerializedExpNumber }[] };
  formations: [string, FormationId][];
  orders: [string, OrderId][];
};

export type SerializedSimulatorResult = SerializedSimulatorPlan & {
  alternatives?: SerializedSimulatorPlan[];
  searchStats?: {
    tacticTests: number;
    armyRefinementTests: number;
    paretoPlansFound: number;
    paretoPlansTruncated: boolean;
    proofStatus?: "searching" | "proven" | "cancelled" | "failed";
    armyCompositionsTested?: number;
    tacticalSetupsTested?: number;
  };
};

export type WorkerOutput =
  | { type: "progress"; phase: string; result?: SerializedSimulatorResult }
  | { type: "done"; result: SerializedSimulatorResult | null }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const serExp = (n: ExpNumber): SerializedExpNumber => ({
  s: n.sign,
  m: n.mantissa,
  e: n.exponent,
});

const deserExp = (s: SerializedExpNumber): ExpNumber =>
  new ExpNumber(s.s, s.m, s.e);

const deserStats = (s: SerializedUnitStats) => ({
  hp: deserExp(s.hp),
  attack: deserExp(s.attack),
  armor: s.armor,
  range: s.range,
  speed: s.speed,
  accuracy: s.accuracy,
});

const serializeResult = (
  composition: SimulatorArmy,
  totalComposition: SimulatorTotalArmy,
  military: ExpNumber,
  totalCost: readonly SimulatorCostTotal[],
  formations: ReadonlyMap<string, FormationId>,
  orders: ReadonlyMap<string, OrderId>,
  extras?: Pick<
    SimulatorResult,
    "alternatives" | "searchStats"
  >,
): SerializedSimulatorResult => ({
  composition: [...composition.entries()].map(([id, n]) => [id, serExp(n)]),
  totalComposition: [...totalComposition.entries()].map(([id, n]) => [id, serExp(n)]),
  military: serExp(military),
  totalCost: totalCost.map(({ resource, base }) => ({ resource, base: serExp(base) })),
  research: { ids: [], costs: [] }, // filled in on the main thread from the result
  formations: [...formations.entries()],
  orders: [...orders.entries()],
  ...(extras?.alternatives
    ? { alternatives: extras.alternatives.map(serializePlan) }
    : {}),
  ...(extras?.searchStats ? { searchStats: extras.searchStats } : {}),
});

const serializePlan = (plan: SimulatorPlan): SerializedSimulatorPlan => ({
  composition: [...plan.composition.entries()].map(([id, n]) => [
    id,
    serExp(n),
  ]),
  totalComposition: [...plan.totalComposition.entries()].map(([id, n]) => [
    id,
    serExp(n),
  ]),
  military: serExp(plan.military),
  totalCost: plan.totalCost.map(({ resource, base }) => ({
    resource,
    base: serExp(base),
  })),
  research: {
    ids: [...plan.research.ids],
    costs: plan.research.costs.map(({ resource, base }) => ({
      resource,
      base: serExp(base),
    })),
  },
  formations: [...plan.formations.entries()],
  orders: [...plan.orders.entries()],
});

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

self.onmessage = async (event: MessageEvent<WorkerInput>) => {
  if (event.data.type !== "start") return;

  const {
    battleId,
    candidateStats,
    candidateIds,
    candidateCosts,
    candidateResearchIds,
    researchCostsByCount,
    ownedArmy: rawOwned,
    enemyStacks: rawEnemy,
    availableFormations,
    availableOrders,
    requireMixed,
    currentFormations,
    currentOrders,
    historicalSeeds = [],
  } = event.data;

  try {
    // Deserialise inputs -------------------------------------------------
    const ownedArmy: SimulatorOwnedArmy = new Map(
      rawOwned.map(([id, n]) => [id, deserExp(n)]),
    );

    const enemyStacks: ArmyStack[] = rawEnemy.map((s) => ({
      unitId: s.unitId,
      count: deserExp(s.count),
      stats: deserStats(s.stats),
      formation: s.formation,
      order: s.order,
    }));

    // Pre-computed stats for candidates (including owned units present in the army)
    const allStats: Record<string, ReturnType<typeof deserStats>> = {};
    for (const [id, raw] of Object.entries(candidateStats)) {
      allStats[id] = deserStats(raw);
    }

    // Cost lookup table: unitId -> [resource, ExpNumber][]
    const costTable = new Map<string, CostParameters[]>();
    for (const [unitId, pairs] of candidateCosts) {
      costTable.set(
        unitId,
        pairs.map(
          ({
            resource,
            base,
            factor,
            exponent,
            unitBase,
            unitFactor,
            reductions,
          }) => ({
            cost: { resource, base: deserExp(base), factor, exponent },
            unitBase: deserExp(unitBase),
            unitFactor: deserExp(unitFactor),
            reductions: {
              base: deserExp(reductions.base),
              factor: deserExp(reductions.factor),
              percent: deserExp(reductions.percent),
              flat: deserExp(reductions.flat),
            },
          }),
        ),
      );
    }

    // Battle outcome and metrics caches across all search phases
    const outcomeCache = new Map<string, boolean>();
    const metricsCache = new Map<string, SimulatorBattleMetrics>();

    const getStackKey = (stacks: readonly ArmyStack[]): string =>
      stacks
        .map(
          (s) =>
            `${s.unitId}:${s.count.mantissa}e${s.count.exponent}:${s.formation ?? DEFAULT_FORMATION}:${s.order ?? DEFAULT_ORDER}`,
        )
        .join(";");

    // Build the context the solver uses -----------------------------------
    const wins = (total: SimulatorTotalArmy): boolean => {
      const playerStacks: ArmyStack[] = buildStacks(total, allStats, undefined, undefined);
      if (playerStacks.length === 0 || enemyStacks.length === 0) return false;
      const key = getStackKey(playerStacks);
      const cached = outcomeCache.get(key);
      if (cached !== undefined) return cached;
      const outcome = simulateBattleOutcome(playerStacks, enemyStacks) === "player";
      outcomeCache.set(key, outcome);
      return outcome;
    };

    const winsWithFormations = (
      total: SimulatorTotalArmy,
      formations: ReadonlyMap<string, FormationId>,
      _battleId: string,
    ): boolean => {
      const playerStacks: ArmyStack[] = buildStacks(total, allStats, formations, undefined);
      if (playerStacks.length === 0 || enemyStacks.length === 0) return false;
      const key = getStackKey(playerStacks);
      const cached = outcomeCache.get(key);
      if (cached !== undefined) return cached;
      const outcome = simulateBattleOutcome(playerStacks, enemyStacks) === "player";
      outcomeCache.set(key, outcome);
      return outcome;
    };

    const winsWithFormationsAndOrders = (
      total: SimulatorTotalArmy,
      formations: ReadonlyMap<string, FormationId>,
      orders: ReadonlyMap<string, OrderId>,
      _battleId: string,
    ): boolean => {
      const playerStacks: ArmyStack[] = buildStacks(total, allStats, formations, orders);
      if (playerStacks.length === 0 || enemyStacks.length === 0) return false;
      const key = getStackKey(playerStacks);
      const cached = outcomeCache.get(key);
      if (cached !== undefined) return cached;
      const outcome = simulateBattleOutcome(playerStacks, enemyStacks) === "player";
      outcomeCache.set(key, outcome);
      return outcome;
    };

    const getBattleMetrics = (
      total: SimulatorTotalArmy,
      formations: ReadonlyMap<string, FormationId>,
      orders: ReadonlyMap<string, OrderId>,
      _battleId: string,
    ): SimulatorBattleMetrics => {
      const playerStacks = buildStacks(total, allStats, formations, orders);
      const key = getStackKey(playerStacks);
      const cached = metricsCache.get(key);
      if (cached !== undefined) return cached;
      const simulation = simulateBattleSummary(playerStacks, enemyStacks);
      const playerInitial = playerStacks.reduce(
        (sum, stack) => sum.add(stack.count),
        ExpNumber.ZERO,
      );
      const enemyInitial = enemyStacks.reduce(
        (sum, stack) => sum.add(stack.count),
        ExpNumber.ZERO,
      );
      const playerCasualties = ExpNumber.max(
        ExpNumber.ZERO,
        playerInitial.sub(simulation.playerSurvivors),
      );
      const enemyCasualties = ExpNumber.max(
        ExpNumber.ZERO,
        enemyInitial.sub(simulation.enemySurvivors),
      );
      const percentage = (casualties: ExpNumber, initial: ExpNumber): number =>
        initial.isZero
          ? 0
          : Math.min(
              100,
              Math.max(
                0,
                casualties
                  .div(initial)
                  .mul(ExpNumber.fromNumber(100))
                  .toNumber(),
              ),
            );
      const metrics: SimulatorBattleMetrics = {
        playerCasualties,
        enemyCasualties,
        playerCasualtyRate: percentage(playerCasualties, playerInitial),
        enemyCasualtyRate: percentage(enemyCasualties, enemyInitial),
      };
      metricsCache.set(key, metrics);
      return metrics;
    };

    const context: BattleSimulatorContext = {
      getCost: (unitId, count) => {
        return calculateCostSeries(
          costTable.get(unitId) ?? [],
          ownedArmy.get(unitId) ?? ExpNumber.ZERO,
          count,
        );
      },
      // The solver already merges owned+additional before calling context.wins,
      // so `composition` here is a SimulatorTotalArmy — pass it directly.
      wins: (composition, _bid) => wins(composition),
      winsWithFormations: (composition, formations, _bid) =>
        winsWithFormations(composition, formations, battleId),
      winsWithFormationsAndOrders: (composition, formations, orders, _bid) =>
        winsWithFormationsAndOrders(composition, formations, orders, battleId),
      getBattleMetrics,
      getResearch: (unitIds) => {
        const ids = [
          ...new Set(
            unitIds.flatMap((unitId) => candidateResearchIds[unitId] ?? []),
          ),
        ];
        return {
          ids,
          costs: ids.length
            ? (researchCostsByCount[ids.length - 1] ?? []).map(
                ({ resource, base }) => ({
                  resource,
                  base: deserExp(base),
                }),
              )
            : [],
        };
      },
    };

    const candidateDefs: SimulatorCandidate[] = candidateIds.map((key) => ({
      key,
    }));

    // Test current tactics first, but still search alternatives for cheaper wins.
    let currentFormationsMap = new Map<string, FormationId>(currentFormations ?? []);
    let currentOrdersMap = new Map<string, OrderId>(currentOrders ?? []);

    // Step 0: Check if the already-owned army can win with tactics alone (no purchases needed).
    // If so, cost is 0, which is the proven global minimum.
    if ([...ownedArmy.values()].some((c) => c.gt(ExpNumber.ZERO))) {
      post({
        type: "progress",
        phase: "Testing current army tactics (no recruits needed)…",
      });
      await tick();

      const ownedTactics = optimizeOwnedArmyTactics(
        battleId,
        context,
        ownedArmy,
        availableFormations,
        availableOrders,
        currentFormationsMap,
        currentOrdersMap,
      );

      if (ownedTactics?.wins) {
        const fullResult = serializeResult(
          new Map(),
          ownedArmy,
          ExpNumber.ZERO,
          [],
          ownedTactics.formations,
          ownedTactics.orders,
          {
            alternatives: [],
            searchStats: {
              tacticTests: 0,
              armyRefinementTests: 0,
              paretoPlansFound: 1,
              paretoPlansTruncated: false,
              proofStatus: "proven",
              armyCompositionsTested: 1,
              tacticalSetupsTested: 0,
            },
          },
        );
        post({
          type: "progress",
          phase: "Victory with current army! No purchases needed.",
          result: fullResult,
        });
      }
      if (ownedTactics) {
        currentFormationsMap = new Map(ownedTactics.formations);
        currentOrdersMap = new Map(ownedTactics.orders);
      }
      await tick();
    }

    post({
      type: "progress",
      phase: "Optimizing formations/orders across starting armies…",
    });
    await tick();

    const refined = optimizeBattleTactics(
      battleId,
      candidateDefs,
      context,
      requireMixed,
      ownedArmy,
      currentFormationsMap,
      currentOrdersMap,
      availableFormations,
      availableOrders,
      (intermediate, phase, improved) => {
        const formatArmy = (army: ReadonlyMap<string, ExpNumber>): string =>
          [...army]
            .map(([unitId, count]) => `${unitId}:${count.toString()}`)
            .join(", ") || "(none)";
        const formatTactics = (tactics: ReadonlyMap<string, string>): string =>
          [...tactics]
            .map(([unitId, tactic]) => `${unitId}:${tactic}`)
            .join(", ") || "standard";
        console.debug(
          `[Battle Simulator] ${battleId}: ${phase}` +
            (improved ? " — new best winning plan" : "") +
            `; army {${formatArmy(intermediate.totalComposition)}}; ` +
            `formations {${formatTactics(intermediate.formations)}}; ` +
            `orders {${formatTactics(intermediate.orders)}}`,
        );
        post({
          type: "progress",
          phase: improved ? `Better winning plan found: ${phase}` : phase,
          result: serializeResult(
            intermediate.composition,
            intermediate.totalComposition,
            intermediate.military,
            intermediate.totalCost,
            intermediate.formations,
            intermediate.orders,
            intermediate,
          ),
        });
      },
      historicalSeeds,
    );
    const result = refined;
    if (result) {
      post({
        type: "progress",
        phase: "Proving the lowest military-cost winning plan…",
        result: serializeResult(
          result.composition,
          result.totalComposition,
          result.military,
          result.totalCost,
          result.formations,
          result.orders,
          {
            ...result,
            alternatives: [],
            searchStats: {
              tacticTests: 0,
              armyRefinementTests: 0,
              paretoPlansFound: 1,
              paretoPlansTruncated: false,
              proofStatus: "searching",
              armyCompositionsTested: 0,
              tacticalSetupsTested: 0,
            },
          },
        ),
      });
      await tick();
    }

    const proven = result
      ? await proveMinimumMilitaryWinner(
          battleId,
          candidateDefs,
          context,
          ownedArmy,
          availableFormations,
          result,
          (intermediate, armyCompositionsTested, tacticalSetupsTested) => {
            console.debug(
              `[Battle Simulator] ${battleId}: proof tested ` +
                `${armyCompositionsTested} armies and ` +
                `${tacticalSetupsTested} formation/order setups`,
            );
            post({
              type: "progress",
              phase:
                `Proving minimum military cost: ${armyCompositionsTested} ` +
                `armies, ${tacticalSetupsTested} tactic setups tested…`,
              result: serializeResult(
                intermediate.composition,
                intermediate.totalComposition,
                intermediate.military,
                intermediate.totalCost,
                intermediate.formations,
                intermediate.orders,
                intermediate,
              ),
            });
          },
          tick,
        )
      : null;

    post({
      type: "done",
      result: proven
        ? serializeResult(
            proven.composition,
            proven.totalComposition,
            proven.military,
            proven.totalCost,
            proven.formations,
            proven.orders,
            proven,
          )
        : null,
    });
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStacks(
  total: SimulatorTotalArmy,
  allStats: Record<string, { hp: ExpNumber; attack: ExpNumber; armor: number; range: number; speed: number; accuracy: number }>,
  formations: ReadonlyMap<string, FormationId> | undefined,
  orders: ReadonlyMap<string, OrderId> | undefined,
): ArmyStack[] {
  const stacks: ArmyStack[] = [];
  for (const [unitId, count] of total) {
    const stats = allStats[unitId];
    if (!stats) continue;
    stacks.push({
      unitId,
      count,
      stats,
      formation: formations?.get(unitId) ?? DEFAULT_FORMATION,
      order: orders?.get(unitId) ?? DEFAULT_ORDER,
    });
  }
  return stacks;
}

// Typed postMessage wrapper
function post(msg: WorkerOutput): void {
  (self as unknown as { postMessage: (msg: WorkerOutput) => void }).postMessage(msg);
}
