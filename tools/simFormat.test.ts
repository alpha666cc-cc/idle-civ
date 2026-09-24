import { describe, expect, it } from "vitest";
import { formatExpoNumber } from "./simFormat";

describe("formatExpoNumber", () => {
  it("rounds readable values to two decimals and trims trailing zeros", () => {
    expect(formatExpoNumber(2.354)).toBe("2.35");
    expect(formatExpoNumber(113.9999999999995)).toBe("114");
    expect(formatExpoNumber(20)).toBe("20");
    expect(formatExpoNumber(2.5)).toBe("2.5");
    expect(formatExpoNumber(0)).toBe("0");
  });

  it("keeps two decimals down to 10^-2", () => {
    expect(formatExpoNumber(0.01)).toBe("0.01");
    // toFixed rounds half to even, so 0.015 -> 0.01 rather than 0.02.
    expect(formatExpoNumber(1.5e-2)).toBe("0.01");
    expect(formatExpoNumber(0.016)).toBe("0.02");
  });

  it("switches to three-decimal scientific notation from a million up", () => {
    expect(formatExpoNumber(999999)).toBe("999999");
    expect(formatExpoNumber(1e6)).toBe("1.000e+6");
    expect(formatExpoNumber(9999999)).toBe("1.000e+7");
    expect(formatExpoNumber(1234567)).toBe("1.235e+6");
    expect(formatExpoNumber(2.354e256)).toBe("2.354e+256");
    expect(formatExpoNumber(-4.2e18)).toBe("-4.200e+18");
    expect(formatExpoNumber(0.001)).toBe("1.000e-3");
    expect(formatExpoNumber(-0.0004)).toBe("-4.000e-4");
  });

  it("renormalises when fixed rounding crosses the threshold", () => {
    // 999999.996 rounds up to a million under toFixed(2), so it must print
    // in scientific notation rather than as a seven-digit fixed number.
    expect(formatExpoNumber(999999.996)).toBe("1.000e+6");
  });

  it("accepts numeric strings and passes non-finite input through", () => {
    expect(formatExpoNumber("6.199999999999997e1")).toBe("62");
    expect(formatExpoNumber("2.5999999999999996e0")).toBe("2.6");
    expect(formatExpoNumber("1.23456e7")).toBe("1.235e+7");
    expect(formatExpoNumber("Infinity")).toBe("Infinity");
    expect(formatExpoNumber(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(formatExpoNumber(Number.NaN)).toBe("NaN");
  });
});