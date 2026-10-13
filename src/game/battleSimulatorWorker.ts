/**
 * Battle-simulator Web Worker.
 *
 * The main thread serialises every ExpNumber before posting; this worker
 * deserialises them, runs the optimiser, and posts progress + the final
 * result back. The worker never touches the DOM or React — only pure game
 * domain modules are imported.
 */
import { ExpNumber } from "./expNumber";
import { simulateBattleOutcome } from "./battle";
import type { ArmyStack, BattleOutcome } from "./battle";
import type { FormationId } from "./formations";
import { DEFAULT_FORMATION } from "./formations";
import type { OrderId } from "./orders";
import { DEFAULT_ORDER } from "./orders";
import {
  mergeSimulatorArmy,
  solveMinimumArmy,
  findOptimalFormations,
  findOptimalOrders,
  trimUnderTactics,
  compositionCost,
  type SimulatorArmy,
  type SimulatorOwnedArmy,
  type SimulatorTotalArmy,
  type BattleSimulatorContext,
  type SimulatorCostTotal,
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
  /** Candidates with costs: [unitId, [resource, {s,m,e}][]][] */
  candidateCosts: [string, [string, SerializedExpNumber][]][];
  /** Currently owned army counts. */
  ownedArmy: [string, SerializedExpNumber][];
  /** Fully serialised enemy stacks for the battle. */
  enemyStacks: SerializedArmyStack[];
  availableFormations: FormationId[];
  availableOrders: OrderId[];
  requireMixed: boolean;
  currentFormations?: [string, FormationId][];
  currentOrders?: [string, OrderId][];
};

export type SerializedSimulatorResult = {
  composition: [string, number][];
  totalComposition: [string, SerializedExpNumber][];
  military: SerializedExpNumber;
  totalCost: { resource: string; base: SerializedExpNumber }[];
  research: { ids: string[]; costs: { resource: string; base: SerializedExpNumber }[] };
  formations: [string, FormationId][];
  orders: [string, OrderId][];
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
): SerializedSimulatorResult => ({
  composition: [...composition.entries()],
  totalComposition: [...totalComposition.entries()].map(([id, n]) => [id, serExp(n)]),
  military: serExp(military),
  totalCost: totalCost.map(({ resource, base }) => ({ resource, base: serExp(base) })),
  research: { ids: [], costs: [] }, // filled in on the main thread from the result
  formations: [...formations.entries()],
  orders: [...orders.entries()],
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
    ownedArmy: rawOwned,
    enemyStacks: rawEnemy,
    availableFormations,
    availableOrders,
    requireMixed,
    currentFormations,
    currentOrders,
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
    const costTable = new Map<string, Array<{ resource: ResourceKey; base: ExpNumber }>>();
    for (const [unitId, pairs] of candidateCosts) {
      costTable.set(
        unitId,
        pairs.map(([res, n]) => ({ resource: res as ResourceKey, base: deserExp(n) })),
      );
    }

    // Build the context the solver uses -----------------------------------
    const wins = (total: SimulatorTotalArmy): boolean => {
      const playerStacks: ArmyStack[] = buildStacks(total, allStats, undefined, undefined);
      if (playerStacks.length === 0 || enemyStacks.length === 0) return false;
      return simulateBattleOutcome(playerStacks, enemyStacks) === "player";
    };

    const winsWithFormations = (
      total: SimulatorTotalArmy,
      formations: ReadonlyMap<string, FormationId>,
      _battleId: string,
    ): boolean => {
      const playerStacks: ArmyStack[] = buildStacks(total, allStats, formations, undefined);
      if (playerStacks.length === 0 || enemyStacks.length === 0) return false;
      return simulateBattleOutcome(playerStacks, enemyStacks) === "player";
    };

    const winsWithFormationsAndOrders = (
      total: SimulatorTotalArmy,
      formations: ReadonlyMap<string, FormationId>,
      orders: ReadonlyMap<string, OrderId>,
      _battleId: string,
    ): boolean => {
      const playerStacks: ArmyStack[] = buildStacks(total, allStats, formations, orders);
      if (playerStacks.length === 0 || enemyStacks.length === 0) return false;
      return simulateBattleOutcome(playerStacks, enemyStacks) === "player";
    };

    const context: BattleSimulatorContext = {
      getCost: (unitId, count) => {
        const rows = costTable.get(unitId) ?? [];
        // Scale each base cost by count; factor:1 satisfies BuildingCost shape
        return rows.map(({ resource, base }) => ({
          resource,
          base: base.mul(ExpNumber.fromNumber(count)),
          factor: 1,
        }));
      },
      // The solver already merges owned+additional before calling context.wins,
      // so `composition` here is a SimulatorTotalArmy — pass it directly.
      wins: (composition, _bid) => wins(composition),
      winsWithFormations: (composition, formations, _bid) =>
        winsWithFormations(composition, formations, battleId),
      winsWithFormationsAndOrders: (composition, formations, orders, _bid) =>
        winsWithFormationsAndOrders(composition, formations, orders, battleId),
      getResearch: () => ({ ids: [], costs: [] }),
    };

    // Fake unit definitions for solveMinimumArmy (it only reads .key)
    const candidateDefs = candidateIds.map((key) => ({
      key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any[];

    // Step 0: Check if the player's current army with their CURRENT formations & orders already wins
    const currentFormationsMap = new Map<string, FormationId>(currentFormations ?? []);
    const currentOrdersMap = new Map<string, OrderId>(currentOrders ?? []);
    if (
      ownedArmy.size > 0 &&
      winsWithFormationsAndOrders(
        ownedArmy,
        currentFormationsMap,
        currentOrdersMap,
        battleId,
      )
    ) {
      post({
        type: "done",
        result: serializeResult(
          new Map(),
          ownedArmy,
          ExpNumber.ZERO,
          [],
          currentFormationsMap,
          currentOrdersMap,
        ),
      });
      return;
    }

    // Phase 1: solve minimum army ----------------------------------------
    post({ type: "progress", phase: "Solving minimum army…" });
    await tick();

    const solve = solveMinimumArmy(
      battleId,
      candidateDefs,
      context,
      requireMixed,
      ownedArmy,
    );

    if (!solve) {
      post({ type: "done", result: null });
      return;
    }

    // Post initial (unoptimised) result
    post({
      type: "progress",
      phase: "Optimising formations and orders…",
      result: serializeResult(
        solve.composition,
        solve.totalComposition,
        solve.military,
        solve.totalCost,
        solve.formations,
        solve.orders,
      ),
    });
    await tick();

    // Phase 2: iterative tactic/trim convergence -------------------------
    const maximumPasses = 3;
    let composition = solve.composition;
    let bestCost = compositionCost(composition, context);
    let accepted = 0;

    for (let iteration = 1; ; iteration += 1) {
      const total = mergeSimulatorArmy(ownedArmy, composition);

      const formations = findOptimalFormations(
        total,
        availableFormations,
        context,
        battleId,
      );
      await tick();

      const orders = findOptimalOrders(
        total,
        availableOrders,
        context,
        battleId,
        formations,
      );
      await tick();

      const nextComposition = trimUnderTactics(
        composition,
        ownedArmy,
        formations,
        orders,
        battleId,
        context,
      );
      await tick();

      const changed =
        composition.size !== nextComposition.size ||
        [...composition.entries()].some(
          ([unitId, count]) => nextComposition.get(unitId) !== count,
        );

      if (!changed) {
        // Converged — emit final result
        const nextTotal = mergeSimulatorArmy(ownedArmy, nextComposition);
        post({
          type: "done",
          result: serializeResult(
            nextComposition,
            nextTotal,
            bestCost,
            [],
            formations,
            orders,
          ),
        });
        return;
      }

      const nextCost = compositionCost(nextComposition, context);
      composition = nextComposition;
      bestCost = nextCost;
      accepted += 1;

      // Post intermediate result after each accepted trim
      const currentTotal = mergeSimulatorArmy(ownedArmy, composition);
      post({
        type: "progress",
        phase: `Pass ${iteration} — trimming army…`,
        result: serializeResult(
          composition,
          currentTotal,
          bestCost,
          [],
          formations,
          orders,
        ),
      });
      await tick();

      if (accepted > maximumPasses) {
        const finalTotal = mergeSimulatorArmy(ownedArmy, composition);
        const finalFormations = findOptimalFormations(
          finalTotal,
          availableFormations,
          context,
          battleId,
        );
        const finalOrders = findOptimalOrders(
          finalTotal,
          availableOrders,
          context,
          battleId,
          finalFormations,
        );
        post({
          type: "done",
          result: serializeResult(
            composition,
            finalTotal,
            bestCost,
            [],
            finalFormations,
            finalOrders,
          ),
        });
        return;
      }
    }
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

// Suppress unused-import lint — the BattleOutcome type is used in the
// simulateBattleOutcome return-value comparison above.
const _unused: BattleOutcome = "player";
void _unused;
