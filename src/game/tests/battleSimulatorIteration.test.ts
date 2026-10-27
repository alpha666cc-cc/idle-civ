import { describe, expect, it } from "vitest";
import {
  mergeSimulatorArmy,
  optimizeBattleTactics,
  solveMinimumArmy,
  type BattleSimulatorContext,
  type SimulatorOwnedArmy,
  type SimulatorCandidate,
  type SimulatorTotalArmy,
} from "../battleSimulator";
import { ExpNumber } from "../expNumber";
import { formationIds, type FormationId } from "../formations";
import { orderIds, type OrderId } from "../orders";
import { CivilizationState } from "../civilizationState";
import { calculateCostSeries } from "../buyableCost";
import { encounterDefinitions } from "../encounters";
import { researchIdsForBattle } from "../research";
import { unitDefinitions } from "../units";
import type { ArmyStack } from "../battle";

/**
 * Alternating-optimization contract (roadmap Milestone 8 extension).
 *
 * `optimizeBattleTactics` iterates: best army → best tactics for that army →
 * trim the army under those tactics → repeat. The invariants it promises are
 * pinned here so a regression fails loudly rather than silently returning a
 * worse army:
 *   1. feasibility — the returned triple always wins,
 *   2. non-regression — the iterated army is never dearer than the one-shot
 *      army,
 *   3. fixpoint — feeding the result back in changes nothing,
 *   4. determinism — identical inputs produce an identical triple,
 *   5. bounded — the loop always terminates.
 */

const firstFire = "age0_1_first_fire";
const marathon = "age2_1_marathon";
/** Every buyable Age 1/2 unit except Hoplite, for the monotonicity regression. */
const ageTwoUnits = [
  "spearman_iron",
  "swordsman_iron",
  "chariot_iron",
  "cavalry_iron",
  "war_galley_iron",
  "elephant_iron",
  "ballista",
  "quinquereme",
  "berserker",
  "legionary",
  "companion",
  "archer_classical",
];

const state = new CivilizationState();

const simulate = (
  composition: SimulatorTotalArmy,
  formations: ReadonlyMap<string, FormationId>,
  orders: ReadonlyMap<string, OrderId>,
  battleId: string,
): boolean => {
  const encounter = encounterDefinitions.find(({ key }) => key === battleId);
  if (!encounter) return false;
  const researchIds = researchIdsForBattle(encounter.age, [
    ...composition.keys(),
  ]);
  const stacks: ArmyStack[] = [];
  for (const [unitId, count] of composition) {
    const stats = state.getUnitStatsWithResearch(unitId, [
      ...new Set([...state.boughtResearch, ...researchIds]),
    ]);
    if (!stats) continue;
    stacks.push({
      unitId,
      count,
      stats,
      formation: formations.get(unitId),
      order: orders.get(unitId),
    });
  }
  if (stacks.length === 0) return false;
  return (
    state.simulateWithStacksOutcome(stacks, state.getEnemyStacks(battleId)) ===
    "player"
  );
};

/** Buyable units of the battle's age and the previous age, unlocked only. */
const simulatorCandidatesFor = (battleAge: number) =>
  state
    .getRosterUnits()
    .filter(
      (unit) =>
        unit.costs.length > 0 &&
        state.isUnitAvailable(unit.key) &&
        unit.age >= battleAge - 1 &&
        unit.age <= battleAge,
    );

/**
 * Buyable units of the battle's age and the previous age, ignoring unlocks.
 * The monotonicity regression needs a fixed candidate set that does not depend
 * on how far a fresh state has progressed, so it names its units directly.
 */
const candidatesFor = (battleAge: number) =>
  unitDefinitions.filter(
    (unit) =>
      unit.costs.length > 0 &&
      unit.age >= battleAge - 1 &&
      unit.age <= battleAge,
  );

/** Cost of the additional recruits only, the number the iteration minimises. */
const recruitMilitary = (
  composition: ReadonlyMap<string, number>,
): number =>
  [...composition.entries()].reduce(
    (total, [unitId, count]) =>
      total +
      state
        .getUnitCost(unitId, count)
        .filter((cost) => cost.resource === "military")
        .reduce((sum, cost) => sum.add(cost.base), ExpNumber.ZERO)
        .toNumber(),
    0,
  );

const contextFor = (battleId: string) => {
  const wins = (composition: SimulatorTotalArmy): boolean =>
    simulate(composition, new Map(), new Map(), battleId);
  return {
    getCost: (unitId: string, count: number) =>
      state.getUnitCost(unitId, count),
    getResearch: (ids: readonly string[]) =>
      state.getResearchForUnitTypes(ids),
    wins,
    winsWithFormations: (
      composition: SimulatorTotalArmy,
      formations: ReadonlyMap<string, FormationId>,
    ) => simulate(composition, formations, new Map(), battleId),
    winsWithFormationsAndOrders: (
      composition: SimulatorTotalArmy,
      formations: ReadonlyMap<string, FormationId>,
      orders: ReadonlyMap<string, OrderId>,
    ) => simulate(composition, formations, orders, battleId),
  };
};

const runSolver = (
  battleId: string,
  unitIds: readonly string[],
  owned: SimulatorOwnedArmy = new Map(),
): ReturnType<typeof optimizeBattleTactics> => {
  const encounter = encounterDefinitions.find(({ key }) => key === battleId);
  if (!encounter) throw new Error(`Missing encounter: ${battleId}`);
  const candidates = simulatorCandidatesFor(encounter.age).filter(({ key }) =>
    unitIds.includes(key),
  );
  return optimizeBattleTactics(
    battleId,
    candidates,
    contextFor(battleId),
    true,
    owned,
  );
};

/** Like `runSolver`, but over an explicit candidate set ignoring unlocks. */
const runSolverOver = (
  battleId: string,
  unitIds: readonly string[],
): ReturnType<typeof optimizeBattleTactics> => {
  const encounter = encounterDefinitions.find(({ key }) => key === battleId);
  if (!encounter) throw new Error(`Missing encounter: ${battleId}`);
  const candidates = candidatesFor(encounter.age).filter(({ key }) =>
    unitIds.includes(key),
  );
  return optimizeBattleTactics(
    battleId,
    candidates,
    contextFor(battleId),
    true,
  );
};

describe("optimizeBattleTactics iteration", () => {
  it("re-solves under cheaper tactics and publishes intermediate armies", () => {
    const candidate: SimulatorCandidate = { key: "warrior" };
    const context: BattleSimulatorContext = {
      getCost: (_unitId, count) => [
        {
          resource: "military",
          base: ExpNumber.fromNumber(count),
          factor: 1,
          exponent: 0.5,
        },
      ],
      getResearch: () => ({ ids: [], costs: [] }),
      wins: () => false,
      winsWithFormations: () => false,
      winsWithFormationsAndOrders: (army, formations) => {
        const count = army.get("warrior") ?? ExpNumber.ZERO;
        return formations.get("warrior") === "frontline"
          ? count.gte(ExpNumber.ONE)
          : count.gte(ExpNumber.fromNumber(2));
      },
    };
    const progress: number[] = [];
    const result = optimizeBattleTactics(
      "age2_1_marathon",
      [candidate],
      context,
      false,
      new Map(),
      new Map(),
      new Map(),
      ["standard", "frontline", "backline"],
      ["standard"],
      (intermediate) => {
        progress.push(intermediate.composition.get("warrior") ?? 0);
      },
    );

    expect(result?.composition.get("warrior")).toBe(1);
    expect(result?.formations.get("warrior")).toBe("frontline");
    expect(progress).toContain(2);
    expect(progress).toContain(1);
  });

  it("prices recruited units with the same cumulative cost curve as the engine", () => {
    const unitId = "chariot_iron";
    const count = 1_000;
    const parameters = state.getUnitCostParameters(unitId);
    const exact = calculateCostSeries(parameters, ExpNumber.ZERO, count);
    expect(exact).toEqual(state.getUnitCost(unitId, count));
    expect(
      exact.find(({ resource }) => resource === "military")?.base.gt(
        state
          .getUnitCost(unitId, 1)
          .find(({ resource }) => resource === "military")!
          .base.mul(ExpNumber.fromNumber(count)),
      ),
    ).toBe(true);
  });

  it("keeps Age 0/1 results identical to the one-shot solver", () => {
    // Formations and orders only unlock at Age 2/3, so for the opening battle
    // the iteration must reduce to the old solver exactly.
    const encounter = encounterDefinitions.find(({ key }) => key === firstFire);
    if (!encounter) throw new Error("The First Fire encounter is missing.");
    const candidates = simulatorCandidatesFor(encounter.age);
    const context = contextFor(firstFire);
    const oneShot = solveMinimumArmy(firstFire, candidates, context, true);
    const iterated = optimizeBattleTactics(firstFire, candidates, context, true);
    expect(iterated).not.toBeNull();
    expect(iterated?.composition).toEqual(oneShot?.composition);
    expect(iterated?.totalComposition).toEqual(oneShot?.totalComposition);
    expect(iterated?.formations).toEqual(oneShot?.formations);
    expect(iterated?.orders).toEqual(oneShot?.orders);
  });

  it("returns a triple that always wins the battle", () => {
    const result = runSolver(firstFire, ["warrior", "slinger"]);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(
      simulate(
        result.totalComposition,
        result.formations,
        result.orders,
        firstFire,
      ),
    ).toBe(true);
  });

  it("never costs more than the one-shot army", () => {
    const result = runSolver(firstFire, ["warrior", "slinger"]);
    expect(result).not.toBeNull();
    if (!result) return;
    const encounter = encounterDefinitions.find(({ key }) => key === firstFire);
    const candidates = encounter ? simulatorCandidatesFor(encounter.age) : [];
    const oneShot = solveMinimumArmy(
      firstFire,
      candidates,
      contextFor(firstFire),
      true,
    );
    expect(recruitMilitary(result.composition)).toBeLessThanOrEqual(
      recruitMilitary(oneShot?.composition ?? new Map()),
    );
  });

  it("is a fixpoint: re-running on its own output changes nothing", () => {
    const first = runSolver(firstFire, ["warrior", "slinger"]);
    expect(first).not.toBeNull();
    if (!first) return;
    const owned = first.totalComposition;
    const encounter = encounterDefinitions.find(({ key }) => key === firstFire);
    const candidates = encounter ? simulatorCandidatesFor(encounter.age) : [];
    const second = optimizeBattleTactics(
      firstFire,
      candidates,
      contextFor(firstFire),
      true,
      owned,
    );
    expect(second).not.toBeNull();
    if (!second) return;
    expect(second.composition.size).toBe(0);
    expect(second.totalComposition).toEqual(owned);
  });

  it("never costs more when a unit is added to the candidate set", () => {
    // Regression: the climb used to be seeded from the single cheapest solo
    // winner, and which unit that was depended on the candidate list. Ticking
    // one more box could therefore strand the search in a local optimum and
    // report a far dearer army — on Marathon, adding Hoplite turned a 1.87e30
    // answer into 17.56e33. Every unit must instead get its own seed, so an
    // extra candidate can only help. The solver is allowed to ignore the new
    // unit entirely, which is what "at worst it is unused" means here.
    const encounter = encounterDefinitions.find(({ key }) => key === marathon);
    if (!encounter) throw new Error("The Marathon encounter is missing.");
    const withoutHoplite = runSolverOver(marathon, ageTwoUnits);
    const withHoplite = runSolverOver(marathon, [...ageTwoUnits, "hoplite"]);

    expect(withoutHoplite).not.toBeNull();
    expect(withHoplite).not.toBeNull();
    expect(withHoplite?.military.lte(withoutHoplite?.military ?? ExpNumber.ZERO)).toBe(
      true,
    );
  }, 120_000);

  it("is deterministic for identical inputs", () => {
    const first = runSolver(firstFire, ["warrior", "slinger"]);
    const second = runSolver(firstFire, ["warrior", "slinger"]);
    expect(first?.composition).toEqual(second?.composition);
    expect(first?.formations).toEqual(second?.formations);
    expect(first?.orders).toEqual(second?.orders);
  });

  it("only ever assigns available formations and orders", () => {
    const result = runSolver(firstFire, ["warrior", "slinger"]);
    expect(result).not.toBeNull();
    if (!result) return;
    for (const formation of result.formations.values()) {
      expect(formationIds).toContain(formation);
    }
    for (const order of result.orders.values()) {
      expect(orderIds).toContain(order);
    }
  });

  it("charges only the additional recruits, never the owned army", () => {
    const owned: SimulatorOwnedArmy = new Map([
      ["warrior", ExpNumber.fromNumber(3)],
    ]);
    const result = runSolver(firstFire, ["warrior", "slinger"], owned);
    expect(result).not.toBeNull();
    if (!result) return;
    // The merge is additive: owned warriors still stand in the total army.
    expect(mergeSimulatorArmy(owned, result.composition)).toEqual(
      result.totalComposition,
    );
    expect(
      result.totalComposition.get("warrior")?.gte(ExpNumber.fromNumber(3)),
    ).toBe(true);
  });
});
