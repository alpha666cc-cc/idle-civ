import { describe, expect, it } from "vitest";
import { ExpNumber } from "./expNumber";
import { formatNumber, formatWholeNumber } from "./numberFormat";

describe("player-facing number rounding", () => {
  it("hides floating-point noise in every number format", () => {
    const noisy = 240.0000000009;

    expect(formatNumber(noisy, "named")).toBe("240");
    expect(formatNumber(noisy, "compact")).toBe("240");
    expect(formatNumber(noisy, "scientific")).toBe("2.4e2");
    expect(formatNumber(noisy, "engineering")).toBe("240");
  });

  it("omits the e0 tier in engineering format", () => {
    expect(formatNumber(1, "engineering")).toBe("1");
    expect(formatNumber(999, "engineering")).toBe("999");
    expect(formatNumber(1000, "engineering")).toBe("1e3");
    expect(formatNumber(12_500, "engineering")).toBe("12.5e3");
    expect(formatNumber(-240, "engineering")).toBe("-240");
  });

  it("rounds an ExpNumber without changing its stored value", () => {
    const value = ExpNumber.fromNumber(240.0000000009);

    expect(formatNumber(value, "named")).toBe("240");
    expect(value.toNumber()).toBeCloseTo(240.0000000009, 12);
    expect(value.toNumber()).not.toBe(240);
  });

  it("formats count-like values as whole numbers", () => {
    expect(formatWholeNumber(10.6, "named")).toBe("11");
    expect(formatWholeNumber(10.4, "named")).toBe("10");
    expect(formatWholeNumber(240.0000000009, "named")).toBe("240");
  });
});
