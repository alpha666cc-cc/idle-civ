import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "../attributes";
import { CivilizationState } from "../civilizationState";
import { ExpNumber } from "../expNumber";
import { emptyStatistics } from "../statistics";
import { researchDefinitions } from "../research";
import { findAgeDefinition } from "../ages";
import { upgradeDefinitions } from "../upgrades";
import { deserializeStatistics, serializeStatistics } from "../saveSystem";


/** A fresh age0 state with the same pile of food and wood. */
const stateWith = (
  stock = 1e12,
  enteredAges: string[] = [],
): CivilizationState =>
  new CivilizationState(
    {
      ...emptyResourceAmounts(),
      food: ExpNumber.fromNumber(stock),
      wood: ExpNumber.fromNumber(stock),
    },
    emptyWorkerAssignments(),
    {},
    emptyResourceFactors(),
    {},
    0,
    [],
    [],
    enteredAges,
    [],
    emptyStatistics(),
    {},
    ExpNumber.ONE,
    false,
    false,
    false,
    [],
  );

const costOf = (
  state: CivilizationState,
  key: string,
  owned: number,
  count = 1,
): number => state.getBuildingCost(key, owned, count)[0].base.toNumber();

const farmCost = (state: CivilizationState, owned: number, count = 1): number =>
  costOf(state, "farm", owned, count);

const citizenCost = (
  state: CivilizationState,
  owned: number,
  count = 1,
): number => costOf(state, "people", owned, count);

/**
 * The cost curve is a linear floor then C(N) = base x factor^(sqrt(N) - 1):
 * the -1 sits in the exponent, so the first unit costs exactly `base`. One unit
 * costs the difference of two consecutive C values (AGENTS.md 4.4).
 */
describe("the parameterized building cost curve", () => {
  it("charges nothing for zero units", () => {
    expect(farmCost(stateWith(), 0, 0)).toBe(0);
  });

  it("totals base x factor^(sqrt(n) - 1)", () => {
    // Farm: base 10, factor 8, so T(4) = 10 x 8^(2 - 1) = 80.
    expect(farmCost(stateWith(), 0, 4)).toBe(80);
  });

  it("prices the first unit at exactly the base cost", () => {
    const state = stateWith();
    expect(farmCost(state, 0)).toBe(10);
    expect(citizenCost(state, 0)).toBe(10);
  });

  it("never lets a later unit cost less than the first", () => {
    const state = stateWith();
    // Farm (factor 8) rises from the first unit.
    expect(farmCost(state, 1)).toBeGreaterThan(farmCost(state, 0));
    // Citizen (factor 8) sits on the linear floor, rising from base.
    const first = citizenCost(state, 0);
    expect(citizenCost(state, 1)).toBeGreaterThanOrEqual(first);
    expect(citizenCost(state, 3)).toBeGreaterThanOrEqual(first);
    expect(citizenCost(state, 5)).toBeGreaterThan(citizenCost(state, 4));
  });

  it("grows with the count", () => {
    const state = stateWith();
    const one = farmCost(state, 0, 1);
    const ten = farmCost(state, 0, 10);
    const thousand = farmCost(state, 0, 1_000);
    expect(one).toBeLessThan(ten);
    expect(ten).toBeLessThan(thousand);
  });

  it("never charges more for one bulk purchase than for separate ones", () => {
    const state = stateWith();
    const bulk = farmCost(state, 0, 5);
    const singles = [0, 1, 2, 3, 4].reduce(
      (total, owned) => total + farmCost(state, owned, 1),
      0,
    );
    expect(bulk).toBeLessThanOrEqual(singles);
  });

  it("agrees with the max-affordable search", () => {
    const state = stateWith(1e6).upgradeBuildingLimit("farm", 1_000_000);
    const max = state.getMaxAffordableBuildings("farm");
    expect(max).toBeGreaterThan(1);
    expect(farmCost(state, 0, max)).toBeLessThanOrEqual(1e6);
    expect(farmCost(state, 0, max + 1)).toBeGreaterThan(1e6);
  });

  it("turns a zero-cost override into a free building", () => {
    const state = stateWith().upgradeBuildingCosts("farm", [
      {
        resource: "food",
        base: ExpNumber.ZERO,
        factor: 2.5,
        exponent: 0.5,
      },
    ]);
    expect(farmCost(state, 0, 3)).toBe(0);
  });

  it("uses a cost-specific exponent and defaults older cost data to sqrt", () => {
    const defaultCurve = stateWith();
    const customCurve = defaultCurve.upgradeBuildingCosts("farm", [
      {
        resource: "food",
        base: ExpNumber.fromNumber(10),
        factor: 8,
        exponent: 1,
      },
    ]);

    expect(
      defaultCurve.getBuildingCostParameters("farm")[0].cost.exponent,
    ).toBe(0.5);
    expect(
      customCurve.getBuildingCostParameters("farm")[0].cost.exponent,
    ).toBe(1);
    expect(farmCost(customCurve, 0, 10)).toBeGreaterThan(
      farmCost(defaultCurve, 0, 10),
    );
  });

  it("keeps the house stone cost disabled until its age bonus raises the factor", () => {
    const inactive = stateWith();
    const inactiveStone = inactive
      .getBuildingCostParameters("house")
      .find(({ cost }) => cost.resource === "stone");

    expect(inactiveStone?.cost.base.toNumber()).toBe(100);
    expect(inactiveStone?.cost.factor).toBe(0);
    expect(
      inactive.getBuildingCost("house", 0)[1].base.toNumber(),
    ).toBe(0);

    const active = stateWith(1e12, ["age0", "age1", "age2", "age3"]);
    const activeStone = active
      .getBuildingCostParameters("house")
      .find(({ cost }) => cost.resource === "stone");

    expect(activeStone?.cost.factor).toBe(12);
    expect(
      active.getBuildingCost("house", 0).find(({ resource }) => resource === "stone")
        ?.base.toNumber(),
    ).toBe(100);
  });
});

/**
 * `resourcesSpent` is the lifetime "what did this run cost" tally. Every purchase
 * path that actually pays must land in it, and a dev-free purchase must not.
 */
describe("resources spent", () => {
  const spent = (state: CivilizationState, resource: string): number =>
    (state.statistics.resourcesSpent[resource] ?? ExpNumber.ZERO).toNumber();

  /** A state with every resource stocked, optionally with buildings already up. */
  const rich = (built: Record<string, number> = {}): CivilizationState =>
    new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e12),
        wood: ExpNumber.fromNumber(1e12),
        stone: ExpNumber.fromNumber(1e12),
        gold: ExpNumber.fromNumber(1e12),
        science: ExpNumber.fromNumber(1e12),
        military: ExpNumber.fromNumber(1e12),
      },
      emptyWorkerAssignments(),
      built,
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      [],
      [],
      emptyStatistics(),
      {},
      ExpNumber.ONE,
      false,
      false,
      false,
      [],
    );

  const richBuildings = {
    "townHall": 1,
    house: 10,
    farm: 10,
    "lumberYard": 10,
    quarry: 10,
    "goldMine": 10,
  };

  it("starts empty", () => {
    expect(stateWith().statistics.resourcesSpent).toEqual({});
  });

  it("records what a building purchase paid", () => {
    // Farm: base 10, factor 8, so T(3) = 10 x (8^1.732 - 1) = 46 food.
    const state = rich().build("farm", 3);
    expect(spent(state, "food")).toBeCloseTo(46, 6);
  });

  it("matches the resources actually deducted", () => {
    const before = rich();
    const after = before.build("farm", 4);
    const dropped = before.resources.food.toNumber() - after.resources.food.toNumber();
    expect(spent(after, "food")).toBeCloseTo(dropped, 4);
  });

  it("accumulates across separate purchases", () => {
    // The first farm costs 10; the next one costs 14, so the tally reaches 24.
    const once = rich().build("farm", 1);
    const twice = once.build("farm", 1);
    expect(spent(once, "food")).toBeCloseTo(10, 6);
    expect(spent(twice, "food")).toBeCloseTo(24, 6);
  });

  it("sums both resources of a multi-resource cost", () => {
    const state = rich().build("farm", 3);
    // Farm also costs wood over the series, so both keys are present.
    expect(Object.keys(state.statistics.resourcesSpent).sort()).toEqual([
      "food",
      "wood",
    ]);
  });

  it("records a research purchase", () => {
    const start = rich();
    const target = researchDefinitions.find((r) => start.isResearchUnlocked(r.key))!;
    const next = start.buyResearch(target.key);
    expect(next.isResearchBought(target.key)).toBe(true);
    // The first tech of the current age costs that age's research base; read it
    // from ages.json so rebalancing the schedule does not stale the assertion.
    expect(spent(next, "science")).toBeCloseTo(
      findAgeDefinition(start.getCurrentAge()!.key)!.research.base.toNumber(),
      6,
    );
  });

  it("records an upgrade purchase", () => {
    const start = rich(richBuildings);
    const target = upgradeDefinitions.find(
      (u) => start.getUpgradeFailureReason(u.key) === null,
    )!;
    const next = start.buyUpgrade(target.key);
    expect(next.boughtUpgrades).toContain(target.key);
    for (const { resource, base } of target.costs) {
      expect(spent(next, resource)).toBeCloseTo(base.toNumber(), 4);
    }
  });

  it("counts nothing for a dev-free building purchase", () => {
    const free = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e12),
        wood: ExpNumber.fromNumber(1e12),
      },
      emptyWorkerAssignments(),
      {},
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      [],
      [],
      emptyStatistics(),
      {},
      ExpNumber.ONE,
      true, // freeBuildings
      false,
      false,
      [],
    );
    const built = free.build("farm", 2);
    expect(built.getBuildingCount("farm")).toBe(2);
    expect(built.statistics.resourcesSpent).toEqual({});
  });

  it("survives a save round trip", () => {
    const state = rich().build("farm", 3);
    const restored = deserializeStatistics(serializeStatistics(state.statistics));
    const food = restored.resourcesSpent.food ?? ExpNumber.ZERO;
    expect(food.toNumber()).toBeCloseTo(46, 6);
  });

  it("defaults to empty for a save written before the field existed", () => {
    // `resourcesSpent` is absent from every save written before this field
    // landed, so the reader has to tolerate it being missing entirely.
    const { resourcesSpent: _absent, ...legacy } = serializeStatistics(
      emptyStatistics(),
    );
    expect(deserializeStatistics(legacy).resourcesSpent).toEqual({});
  });
});

describe("the building cost multiplier attribution", () => {
  // The Master Builder chain targets the derived `buildingCostMultiplier` stat
  // rather than a buyable directly, so its bonuses fold into every base cost
  // through `globalMultiplier` and never enter the per-buyable `sources` list.
  // `multiplierSources` exists so the Gamepedia can still attribute the
  // aggregate to its sources (Master Builder I, IV, ...).
  const withMasterBuilders = (tiers: string[]): CivilizationState =>
    new CivilizationState(
      { ...emptyResourceAmounts() },
      emptyWorkerAssignments(),
      {},
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      [],
      tiers,
      emptyStatistics(),
      {},
      ExpNumber.ONE,
      false,
      false,
      false,
      [],
    );

  it("attributes the global multiplier to its sources", () => {
    const state = withMasterBuilders(["masterBuilder1", "masterBuilder4"]);
    const { sources, multiplierSources, globalMultiplier } =
      state.getBuildingCostModifiers("farm");
    expect(multiplierSources.map(([id]) => id)).toEqual([
      "masterBuilder1",
      "masterBuilder4",
    ]);
    expect(multiplierSources.map(([, bonus]) => bonus.value.toNumber())).toEqual(
      [0.5, 0.3],
    );
    // ×0.5 (tier 1) and ×0.3 (tier 4) compound to ×0.15.
    expect(globalMultiplier.toNumber()).toBeCloseTo(0.15, 10);
    // The attribution rows are stat bonuses, not cost-reduction rows: the
    // folded `sources` list stays free of them.
    expect(
      sources.every(([, bonus]) => bonus.type.startsWith("costReduction")),
    ).toBe(true);
  });

  it("never reaches research", () => {
    const state = withMasterBuilders(["masterBuilder1"]);
    expect(state.getResearchCostModifiers().globalMultiplier.toNumber()).toBe(
      1,
    );
    expect(
      state.getResearchCostModifiers().sources.every(
        ([id]) => !id.startsWith("masterBuilder"),
      ),
    ).toBe(true);
  });
});
