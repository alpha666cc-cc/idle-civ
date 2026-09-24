import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "./attributes";
import { CivilizationState } from "./civilizationState";
import { ExpNumber } from "./expNumber";
import { emptyStatistics } from "./statistics";

/** A fresh age-0 state with the same pile of food and wood. */
const stateWith = (stock = 1e12): CivilizationState =>
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
describe("the square-root building cost curve", () => {
  it("charges nothing for zero units", () => {
    expect(farmCost(stateWith(), 0, 0)).toBe(0);
  });

  it("totals base x factor^(sqrt(n) - 1)", () => {
    // Farm: base 10, factor 25, so T(4) = 10 x 25^(2 - 1) = 250.
    expect(farmCost(stateWith(), 0, 4)).toBe(250);
  });

  it("prices the first unit at exactly the base cost", () => {
    const state = stateWith();
    expect(farmCost(state, 0)).toBe(10);
    expect(citizenCost(state, 0)).toBe(10);
  });

  it("never lets a later unit cost less than the first", () => {
    const state = stateWith();
    // Farm (factor 25) rises from the first unit.
    expect(farmCost(state, 1)).toBeGreaterThan(farmCost(state, 0));
    // Citizen (factor 2.5) sits on the linear floor, rising from base.
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
      { resource: "food", base: ExpNumber.ZERO, factor: 2.5 },
    ]);
    expect(farmCost(state, 0, 3)).toBe(0);
  });
});
