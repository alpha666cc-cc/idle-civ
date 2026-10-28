import { describe, expect, it } from "vitest";
import {
  mergeSimulatorArmy,
  optimizeBattleTactics,
  proveMinimumMilitaryWinner,
  solveMinimumArmy,
  type BattleSimulatorContext,
  type SimulatorOwnedArmy,
  type SimulatorCandidate,
  type SimulatorResult,
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

  it("keeps resource-cost trade-offs with internal casualty metrics", () => {
    const candidate: SimulatorCandidate = { key: "warrior" };
    const context: BattleSimulatorContext = {
      getCost: (_unitId, count) => [
        {
          resource: "military",
          base: ExpNumber.fromNumber(count),
          factor: 1,
          exponent: 0.5,
        },
        {
          resource: "wood",
          base: ExpNumber.fromNumber(
            count === 1 ? 5 : count === 2 ? 0 : count * 5,
          ),
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
      getBattleMetrics: (_army, formations) => ({
        playerCasualties: ExpNumber.fromNumber(
          formations.get("warrior") === "frontline" ? 0 : 1,
        ),
        enemyCasualties: ExpNumber.fromNumber(2),
        playerCasualtyRate:
          formations.get("warrior") === "frontline" ? 0 : 0.5,
        enemyCasualtyRate: 1,
      }),
    };

    const result = optimizeBattleTactics(
      marathon,
      [candidate],
      context,
      false,
      new Map(),
      new Map(),
      new Map(),
      ["standard", "frontline"],
      ["standard"],
    );

    if (!result) throw new Error("Expected winning plans to be found");
    expect(result.composition.get("warrior")).toBe(1);
    expect(result.battleMetrics?.playerCasualtyRate).toBe(0);
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives?.[0].composition.get("warrior")).toBe(2);
    expect(result.alternatives?.[0].totalCost).toEqual([
      { resource: "military", base: ExpNumber.fromNumber(2) },
      { resource: "wood", base: ExpNumber.ZERO },
    ]);
    for (const plan of [result, ...(result.alternatives ?? [])]) {
      expect(
        context.winsWithFormationsAndOrders(
          plan.totalComposition,
          plan.formations,
          plan.orders,
          marathon,
        ),
      ).toBe(true);
    }
  });

  it("uses casualty metrics internally for equal-cost formations", () => {
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
      winsWithFormationsAndOrders: (army) =>
        (army.get("warrior") ?? ExpNumber.ZERO).gte(ExpNumber.ONE),
      getBattleMetrics: (_army, formations) => ({
        playerCasualties: ExpNumber.fromNumber(
          formations.get("warrior") === "frontline" ? 0 : 1,
        ),
        enemyCasualties: ExpNumber.ONE,
        playerCasualtyRate:
          formations.get("warrior") === "frontline" ? 0 : 0.5,
        enemyCasualtyRate: 1,
      }),
    };

    const result = optimizeBattleTactics(
      marathon,
      [candidate],
      context,
      false,
      new Map(),
      new Map(),
      new Map(),
      ["standard", "frontline"],
      ["standard"],
    );

    if (!result) throw new Error("Expected a winning formation");
    expect(result.formations.get("warrior")).toBe("frontline");
    expect(result.alternatives).toHaveLength(0);
  });

  it("continues equal-cost formation improvements across multiple units", () => {
    const candidates: SimulatorCandidate[] = [
      { key: "warrior" },
      { key: "slinger" },
      { key: "spearman_bronze" },
    ];
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
      wins: () => true,
      winsWithFormations: () => true,
      winsWithFormationsAndOrders: () => true,
      getBattleMetrics: (_army, formations) => {
        const improved = [...formations.values()].filter(
          (formation) => formation === "frontline",
        ).length;
        return {
          playerCasualties: ExpNumber.ONE,
          enemyCasualties: ExpNumber.ONE,
          playerCasualtyRate: 0.8 - improved * 0.1,
          enemyCasualtyRate: 1,
        };
      },
    };
    const owned: SimulatorOwnedArmy = new Map(
      candidates.map(({ key }) => [key, ExpNumber.ONE]),
    );
    const formations = new Map(
      candidates.map(({ key }) => [key, "standard" as FormationId]),
    );
    const result = optimizeBattleTactics(
      marathon,
      candidates,
      context,
      false,
      owned,
      formations,
      new Map(),
      ["standard", "frontline"],
      ["standard"],
    );

    if (!result) throw new Error("Expected the owned army to win");
    expect(result.composition.size).toBe(0);
    for (const { key } of candidates) {
      expect(result.formations.get(key)).toBe("frontline");
    }
    expect(result.battleMetrics?.playerCasualtyRate).toBeCloseTo(0.5);
  });

  it("re-solves promising losing formations for a better mixed army", () => {
    const candidates: SimulatorCandidate[] = [
      { key: "warrior" },
      { key: "slinger" },
    ];
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
      wins: (army) =>
        (army.get("warrior") ?? ExpNumber.ZERO).gte(
          ExpNumber.fromNumber(10),
        ),
      winsWithFormations: (army, formations) =>
        formations.get("warrior") === "frontline"
          ? false
          : (army.get("warrior") ?? ExpNumber.ZERO).gte(
              ExpNumber.fromNumber(10),
            ),
      winsWithFormationsAndOrders: (army, formations) => {
        if (formations.get("warrior") === "frontline") {
          return (
            (army.get("warrior") ?? ExpNumber.ZERO).eq(ExpNumber.ONE) &&
            (army.get("slinger") ?? ExpNumber.ZERO).eq(ExpNumber.ONE)
          );
        }
        return (army.get("warrior") ?? ExpNumber.ZERO).gte(
          ExpNumber.fromNumber(10),
        );
      },
      getBattleMetrics: (_army, formations) => ({
        playerCasualties: ExpNumber.ONE,
        enemyCasualties: ExpNumber.ONE,
        playerCasualtyRate:
          formations.get("warrior") === "frontline" ? 0.2 : 0.8,
        enemyCasualtyRate:
          formations.get("warrior") === "frontline" ? 1 : 0.2,
      }),
    };

    const result = optimizeBattleTactics(
      marathon,
      candidates,
      context,
      true,
      new Map(),
      new Map(),
      new Map(),
      ["standard", "frontline"],
      ["standard"],
    );

    if (!result) throw new Error("Expected a winning formation and army");
    expect(result.composition).toEqual(
      new Map([
        ["warrior", 1],
        ["slinger", 1],
      ]),
    );
    expect(result.military.eq(ExpNumber.fromNumber(2))).toBe(true);
    expect(result.formations.get("warrior")).toBe("frontline");
    expect(
      context.winsWithFormationsAndOrders(
        result.totalComposition,
        result.formations,
        result.orders,
        marathon,
      ),
    ).toBe(true);
  });

  it("keeps resource-cost trade-offs without ranking by casualties", () => {
    const candidate: SimulatorCandidate = { key: "warrior" };
    const context: BattleSimulatorContext = {
      getCost: (_unitId, count) => [
        {
          resource: "military",
          base: ExpNumber.fromNumber(count),
          factor: 1,
          exponent: 0.5,
        },
        {
          resource: "wood",
          base: ExpNumber.fromNumber(10 - count),
          factor: 1,
          exponent: 0.5,
        },
      ],
      getResearch: () => ({ ids: [], costs: [] }),
      wins: () => false,
      winsWithFormations: () => false,
      winsWithFormationsAndOrders: (army) =>
        (army.get("warrior") ?? ExpNumber.ZERO).gte(ExpNumber.ONE),
      getBattleMetrics: (army) => {
        const count = army.get("warrior") ?? ExpNumber.ZERO;
        const casualtyRate = 1 / count.toNumber();
        return {
          playerCasualties: ExpNumber.ONE,
          enemyCasualties: ExpNumber.ONE,
          playerCasualtyRate: casualtyRate,
          enemyCasualtyRate: 1,
        };
      },
    };

    const result = optimizeBattleTactics(
      marathon,
      [candidate],
      context,
      false,
      new Map(),
      new Map(),
      new Map(),
      ["standard"],
      ["standard"],
    );

    if (!result) throw new Error("Expected winning configurations");
    const plans = [result, ...(result.alternatives ?? [])];
    expect(plans.map(({ composition }) => composition.get("warrior"))).toEqual([
      1, 2, 3, 4, 5, 9,
    ]);
    expect(
      plans.map(({ battleMetrics }) => battleMetrics?.playerCasualtyRate),
    ).toEqual([1, 0.5, 1 / 3, 0.25, 0.2, 1 / 9]);
  });

  it("does not recommend extra recruits when the owned army already wins", () => {
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
      wins: () => true,
      winsWithFormations: () => true,
      winsWithFormationsAndOrders: () => true,
      getBattleMetrics: (army) => {
        const total = [...army.values()].reduce(
          (sum, count) => sum.add(count),
          ExpNumber.ZERO,
        );
        return {
          playerCasualties: ExpNumber.ONE,
          enemyCasualties: ExpNumber.ONE,
          playerCasualtyRate: 1 / total.toNumber(),
          enemyCasualtyRate: 1,
        };
      },
    };

    const result = optimizeBattleTactics(
      marathon,
      [candidate],
      context,
      false,
      new Map([["warrior", ExpNumber.ONE]]),
      new Map(),
      new Map(),
      ["standard"],
      ["standard"],
    );

    if (!result) throw new Error("Expected the owned army to win");
    expect(result.composition.size).toBe(0);
    expect(result.alternatives).toHaveLength(0);
  });

  it("optimizes formations for owned units as well as recruits", () => {
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
      winsWithFormations: (army, formations) => {
        const recruits = army.get("legionary") ?? ExpNumber.ZERO;
        const ownedFormation = formations.get("hoplite");
        const required = ownedFormation === "turtle" ? 1 : 2;
        return recruits.gte(ExpNumber.fromNumber(required));
      },
      winsWithFormationsAndOrders: (army, formations) => {
        const recruits = army.get("legionary") ?? ExpNumber.ZERO;
        const ownedFormation = formations.get("hoplite");
        const required = ownedFormation === "turtle" ? 1 : 2;
        return recruits.gte(ExpNumber.fromNumber(required));
      },
    };
    const result = optimizeBattleTactics(
      marathon,
      [{ key: "legionary" }],
      context,
      false,
      new Map([["hoplite", ExpNumber.ONE]]),
      new Map([["hoplite", "standard"]]),
      new Map(),
      ["standard", "turtle"],
      ["standard"],
    );

    expect(result?.composition.get("legionary")).toBe(1);
    expect(result?.formations.get("hoplite")).toBe("turtle");
  });

  it("finds a cheaper army that needs two formation changes together", () => {
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
        const recruits = army.get("legionary") ?? ExpNumber.ZERO;
        const hasFormationSynergy =
          formations.get("warrior") === "frontline" &&
          formations.get("slinger") === "backline";
        const required = hasFormationSynergy ? 1 : 2;
        return recruits.gte(ExpNumber.fromNumber(required));
      },
    };
    const result = optimizeBattleTactics(
      marathon,
      [{ key: "legionary" }],
      context,
      false,
      new Map([
        ["warrior", ExpNumber.ONE],
        ["slinger", ExpNumber.ONE],
      ]),
      new Map(),
      new Map(),
      ["standard", "frontline", "backline"],
      ["standard"],
    );

    expect(result?.composition.get("legionary")).toBe(1);
    expect(result?.formations.get("warrior")).toBe("frontline");
    expect(result?.formations.get("slinger")).toBe("backline");
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

  it("proves the cheapest winning army within the selected roster", async () => {
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
        return formations.get("warrior") === "turtle"
          ? count.gte(ExpNumber.fromNumber(2))
          : count.gte(ExpNumber.fromNumber(3));
      },
    };
    const initial: SimulatorResult = {
      composition: new Map([["warrior", 4]]),
      totalComposition: new Map([["warrior", ExpNumber.fromNumber(4)]]),
      military: ExpNumber.fromNumber(4),
      totalCost: [
        { resource: "military", base: ExpNumber.fromNumber(4) },
      ],
      research: { ids: [], costs: [] },
      formations: new Map([["warrior", "standard"]]),
      orders: new Map([["warrior", "standard"]]),
    };
    const progress: number[] = [];

    const result = await proveMinimumMilitaryWinner(
      marathon,
      [candidate],
      context,
      new Map(),
      ["standard", "turtle"],
      initial,
      (plan: SimulatorResult) => progress.push(plan.composition.get("warrior") ?? 0),
      async () => {},
    );

    expect(result.composition.get("warrior")).toBe(2);
    expect(result.formations.get("warrior")).toBe("turtle");
    expect(result.searchStats?.proofStatus).toBe("proven");
    expect(result.searchStats?.armyCompositionsTested).toBe(3);
    // Sieve approach per composition (dedup via tryIfNew):
    //   Seed1 (standard): test itself, + perturb warrior->turtle.
    //   Doctrine 'standard' deduped. Doctrine 'turtle' also deduped after sieve.
    //   (The sieve step on seed1 already generated warrior:turtle)
    //   so seed 'turtle' doctrine finds all its tests deduped.
    // Sieve: 2 distinct tactics per composition * 3 compositions = 6.
    expect(result.searchStats?.tacticalSetupsTested).toBe(6);
    expect(progress).toContain(2);
  });
});
