import type { CostReductions } from "./bonus";
import type { BuildingCost } from "./buildings";
import { ExpNumber } from "./expNumber";

export type CostParameters = {
  readonly cost: BuildingCost;
  readonly unitBase: ExpNumber;
  readonly unitFactor: ExpNumber;
  readonly reductions: CostReductions;
};

const maximumUnitPurchase = 1_000_000;
const flatClampWindow = 256;

const linearSlope = (unitBase: ExpNumber, unitFactor: ExpNumber): ExpNumber =>
  unitBase.mul(unitFactor).div(ExpNumber.fromNumber(25));

const sqrtCurve = (
  unitBase: ExpNumber,
  unitFactor: ExpNumber,
  n: number,
): ExpNumber => unitBase.mul(unitFactor.pow(Math.sqrt(n) - 1));

const crossoverToSqrt = (
  unitBase: ExpNumber,
  unitFactor: ExpNumber,
): number => {
  const slope = linearSlope(unitBase, unitFactor);
  const linear = (k: number): ExpNumber =>
    unitBase.add(slope.mul(ExpNumber.fromNumber(k - 1)));
  const sqrtPrice = (k: number): ExpNumber =>
    sqrtCurve(unitBase, unitFactor, k).sub(
      sqrtCurve(unitBase, unitFactor, k - 1),
    );
  let k = 1;
  while (k < maximumUnitPurchase && sqrtPrice(k).lte(linear(k))) k += 1;
  return k - 1;
};

/**
 * Cumulative cost of count units starting at alreadyBuilt, with the same
 * per-unit reductions and piecewise curve used by CivilizationState.
 */
export const calculateCostSeries = (
  parameters: readonly CostParameters[],
  alreadyBuilt: ExpNumber,
  count: number,
): BuildingCost[] => {
  const owned = alreadyBuilt.toNumber();
  return parameters.map(({ cost, unitBase, unitFactor, reductions }) => {
    if (count <= 0) return { ...cost, base: ExpNumber.ZERO };
    const crossover = crossoverToSqrt(unitBase, unitFactor);
    const slope = linearSlope(unitBase, unitFactor);
    const linearSum = (n: number): ExpNumber =>
      unitBase
        .mul(ExpNumber.fromNumber(n))
        .add(slope.mul(ExpNumber.fromNumber((n * (n - 1)) / 2)));
    const cumulative = (n: number): ExpNumber =>
      n <= crossover
        ? linearSum(n)
        : linearSum(crossover).add(
            sqrtCurve(unitBase, unitFactor, n).sub(
              sqrtCurve(unitBase, unitFactor, crossover),
            ),
          );
    const unitPrice = (n: number): ExpNumber =>
      cumulative(n)
        .sub(cumulative(n - 1))
        .mul(reductions.percent);
    let clamped = 0;
    if (reductions.flat.gt(ExpNumber.ZERO)) {
      const window = Math.min(count, flatClampWindow);
      while (clamped < window) {
        if (unitPrice(owned + clamped + 1).gt(reductions.flat)) break;
        clamped += 1;
      }
    }
    const remaining = count - clamped;
    const gross = cumulative(owned + count)
      .sub(cumulative(owned + clamped))
      .mul(reductions.percent);
    const payable = ExpNumber.max(
      ExpNumber.ZERO,
      gross.sub(reductions.flat.mul(ExpNumber.fromNumber(remaining))),
    );
    const floored = payable.floor();
    const snapped = payable
      .sub(floored)
      .lte(
        ExpNumber.max(payable, ExpNumber.ONE).mul(ExpNumber.fromNumber(1e-9)),
      )
      ? floored
      : payable;
    return { ...cost, base: snapped.ceil() };
  });
};
