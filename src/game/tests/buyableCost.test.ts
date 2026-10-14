import { describe, expect, it } from "vitest";
import type { CostReductions } from "../bonus";
import type { BuildingCost } from "../buildings";
import { calculateCostSeries, type CostParameters } from "../buyableCost";
import { ExpNumber } from "../expNumber";

const maximumUnitPurchase = 1_000_000;

const findLinearCrossoverByScan = (factor: number): number => {
  const curve = (count: number): number =>
    factor ** (Math.sqrt(count) - 1);
  const linear = (count: number): number =>
    1 + (factor * (count - 1)) / 25;
  let count = 1;
  while (
    count < maximumUnitPurchase &&
    curve(count) - curve(count - 1) <= linear(count)
  ) {
    count += 1;
  }
  return count - 1;
};

const reductions: CostReductions = {
  base: ExpNumber.ONE,
  factor: ExpNumber.ONE,
  percent: ExpNumber.ONE,
  flat: ExpNumber.ZERO,
};

const expectedCost = (
  unitBase: ExpNumber,
  unitFactor: ExpNumber,
  crossover: number,
  owned: number,
  count: number,
): ExpNumber => {
  const slope = unitBase.mul(unitFactor).div(ExpNumber.fromNumber(25));
  const linearSum = (n: number): ExpNumber =>
    unitBase
      .mul(ExpNumber.fromNumber(n))
      .add(slope.mul(ExpNumber.fromNumber((n * (n - 1)) / 2)));
  const sqrtCurve = (n: number): ExpNumber =>
    unitBase.mul(unitFactor.pow(Math.sqrt(n) - 1));
  const cumulative = (n: number): ExpNumber =>
    n <= crossover
      ? linearSum(n)
      : linearSum(crossover).add(
          sqrtCurve(n).sub(sqrtCurve(crossover)),
        );
  return cumulative(owned + count).sub(cumulative(owned)).ceil();
};

describe("buyable cost curve crossover", () => {
  it.each([1.01, 1.1, 1.6, 2, 2.5, 3, 5, 8, 15])(
    "matches a linear scan for growth factor %s",
    (factor) => {
      const unitBase = ExpNumber.fromNumber(100);
      const unitFactor = ExpNumber.fromNumber(factor);
      const crossover = findLinearCrossoverByScan(factor);
      const owned = Math.max(0, crossover - 1);
      const count = Math.min(2, maximumUnitPurchase - owned);
      const cost: BuildingCost = {
        resource: "food",
        base: unitBase,
        factor,
      };
      const parameters: CostParameters = {
        cost,
        unitBase,
        unitFactor,
        reductions,
      };

      const actual = calculateCostSeries(
        [parameters],
        ExpNumber.fromNumber(owned),
        count,
      )[0].base;

      expect(
        actual.eq(expectedCost(unitBase, unitFactor, crossover, owned, count)),
      ).toBe(true);
    },
  );
});
