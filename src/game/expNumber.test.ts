import { describe, expect, it } from "vitest";
import { ExpNumber } from "./expNumber";

describe("ExpNumber cancellation", () => {
  it("returns exact whole numbers after a cancelling subtraction", () => {
    // 25 - 24 runs as 2.5 - 2.4 in mantissa space, and that subtraction is
    // 0.10000000000000009, so the raw result would be 1.0000000000000009.
    expect(ExpNumber.fromNumber(25).sub(ExpNumber.fromNumber(24)).toNumber()).toBe(1);
    expect(
      ExpNumber.fromNumber(100).sub(ExpNumber.fromNumber(99)).toNumber(),
    ).toBe(1);
    expect(
      ExpNumber.fromNumber(1e6).sub(ExpNumber.fromNumber(999999)).toNumber(),
    ).toBe(1);
    // Exactness has to survive the ExpNumber ops, not just the final read.
    expect(ExpNumber.fromNumber(25).sub(ExpNumber.fromNumber(24)).eq(ExpNumber.ONE)).toBe(
      true,
    );
  });

  it("keeps fractional precision when the result is not a whole number", () => {
    const difference = ExpNumber.fromNumber(10.5).sub(ExpNumber.fromNumber(0.25));
    expect(difference.toNumber()).toBeCloseTo(10.25, 12);
    const fractional = ExpNumber.fromNumber(1).sub(ExpNumber.fromNumber(0.1));
    expect(fractional.toNumber()).toBeCloseTo(0.9, 12);
    // Beyond a double's reach the mantissa is the only carrier left.
    const huge = ExpNumber.from("1e400").sub(ExpNumber.ONE);
    expect(huge.toNumber()).toBe(Infinity);
  });

  it("rounds to the nearest whole number", () => {
    expect(ExpNumber.fromNumber(10.4).round().toNumber()).toBe(10);
    expect(ExpNumber.fromNumber(10.6).round().toNumber()).toBe(11);
    expect(ExpNumber.fromNumber(240.0000000009).round().toNumber()).toBe(240);
  });

  it("never turns a non-zero result into zero", () => {
    const tiny = ExpNumber.from("1e-30").sub(ExpNumber.from("9e-31"));
    expect(tiny.gt(ExpNumber.ZERO)).toBe(true);
  });
});
