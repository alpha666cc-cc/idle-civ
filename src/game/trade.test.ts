import { describe, expect, it } from "vitest";
import { ExpNumber } from "./expNumber";
import { formatNumber } from "./numberFormat";
import { calculateTradeMultiplier } from "./trade";

describe("trade multiplier arithmetic", () => {
  it("keeps a finite trade power beyond the JavaScript number range", () => {
    const tradePower = ExpNumber.from("1e400");

    expect(tradePower.isFinite).toBe(true);
    expect(tradePower.toNumber()).toBe(Infinity);

    const multiplier = calculateTradeMultiplier(tradePower);
    expect(multiplier.isFinite).toBe(true);
    expect(multiplier.toNumber()).toBe(401);
    expect(formatNumber(multiplier, "named")).toBe("401");
  });

  it("keeps the zero-trade multiplier at one", () => {
    expect(calculateTradeMultiplier(ExpNumber.ZERO).toNumber()).toBe(1);
  });
});
