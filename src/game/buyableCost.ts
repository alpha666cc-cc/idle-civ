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

const exponentCurve = (
  unitBase: ExpNumber,
  unitFactor: ExpNumber,
  n: number | ExpNumber,
  exponent: number,
): ExpNumber => {
  const factorPower =
    typeof n === "number"
      ? ExpNumber.fromNumber(Math.pow(n, exponent) - 1)
      : n.pow(exponent).sub(ExpNumber.ONE);
  return unitBase.mul(unitFactor.pow(factorPower));
};

const crossoverToExponentCurve = (
  unitBase: ExpNumber,
  unitFactor: ExpNumber,
  exponent: number,
): number => {
  const slope = linearSlope(unitBase, unitFactor);
  const linear = (k: number): ExpNumber =>
    unitBase.add(slope.mul(ExpNumber.fromNumber(k - 1)));
  const curvePrice = (k: number): ExpNumber =>
    exponentCurve(unitBase, unitFactor, k, exponent).sub(
      exponentCurve(unitBase, unitFactor, k - 1, exponent),
    );
  const staysOnLinearFloor = (k: number): boolean =>
    curvePrice(k).lte(linear(k));

  let low = 0;
  let high = 1;
  // The marginal curve crosses the linear floor once; bracket it before
  // binary-searching rather than rescanning the prefix for every price probe.
  while (high < maximumUnitPurchase && staysOnLinearFloor(high)) {
    low = high;
    high = Math.min(high * 2, maximumUnitPurchase);
  }
  if (high === maximumUnitPurchase && staysOnLinearFloor(high)) {
    return maximumUnitPurchase - 1;
  }

  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (staysOnLinearFloor(middle)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
};

/**
 * Cumulative cost of count units starting at alreadyBuilt, with the same
 * per-unit reductions and piecewise curve used by CivilizationState.
 */
export const calculateCostSeries = (
  parameters: readonly CostParameters[],
  alreadyBuilt: ExpNumber,
  count: number | ExpNumber,
): BuildingCost[] => {
  const owned = alreadyBuilt;
  const requested = ExpNumber.max(
    ExpNumber.ZERO,
    count instanceof ExpNumber ? count : ExpNumber.fromNumber(count),
  );
  const one = ExpNumber.ONE;
  return parameters.map(({ cost, unitBase, unitFactor, reductions }) => {
    const exponent = cost.exponent;
    if (!requested.gt(ExpNumber.ZERO)) {
      return { ...cost, base: ExpNumber.ZERO };
    }
    const crossover = crossoverToExponentCurve(
      unitBase,
      unitFactor,
      exponent,
    );
    const crossoverNumber = ExpNumber.fromNumber(crossover);
    const slope = linearSlope(unitBase, unitFactor);
    const linearSum = (n: number): ExpNumber =>
      unitBase
        .mul(ExpNumber.fromNumber(n))
        .add(slope.mul(ExpNumber.fromNumber((n * (n - 1)) / 2)));
    const cumulative = (n: ExpNumber): ExpNumber =>
      n.lte(crossoverNumber)
        ? linearSum(n.toNumber())
        : linearSum(crossover).add(
            exponentCurve(unitBase, unitFactor, n, exponent).sub(
              exponentCurve(unitBase, unitFactor, crossoverNumber, exponent),
            ),
          );
    const unitPrice = (n: ExpNumber): ExpNumber =>
      cumulative(n)
        .sub(cumulative(n.sub(one)))
        .mul(reductions.percent);
    let clamped = 0;
    if (reductions.flat.gt(ExpNumber.ZERO)) {
      while (
        clamped < flatClampWindow &&
        ExpNumber.fromNumber(clamped).lt(requested)
      ) {
        if (
          unitPrice(owned.add(ExpNumber.fromNumber(clamped + 1))).gt(
            reductions.flat,
          )
        ) {
          break;
        }
        clamped += 1;
      }
    }
    const clampedCount = ExpNumber.fromNumber(clamped);
    const remaining = requested.sub(clampedCount);
    const gross = cumulative(owned.add(requested))
      .sub(cumulative(owned.add(clampedCount)))
      .mul(reductions.percent);
    const payable = ExpNumber.max(
      ExpNumber.ZERO,
      gross.sub(reductions.flat.mul(remaining)),
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
