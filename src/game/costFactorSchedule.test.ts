import { describe, expect, it } from "vitest";
import {
  buildingFactorSchedule,
  citizenFactorSchedule,
  costFactorAt,
  costFactorSteps,
  productionStepFromCount,
} from "./costFactorSchedule";

/**
 * The schedule is a design artifact walking k from its shipped start to the
 * age-7 endgame target over ten production-building decades. These tests pin
 * the endpoints, the flat-then-cliff-then-decay shape, and the trigger's
 * decade mapping so the eventual costSeries wiring has a checked contract.
 */
describe("the progressive cost-factor reduction schedule", () => {
  it("has one step per production-building decade", () => {
    expect(buildingFactorSchedule).toHaveLength(10);
    expect(citizenFactorSchedule).toHaveLength(10);
    expect(costFactorSteps).toBe(10);
  });

  it("walks buildings from the shipped 25 to the age-7 target", () => {
    expect(costFactorAt(buildingFactorSchedule, 0)).toBe(25);
    expect(costFactorAt(buildingFactorSchedule, 9)).toBeCloseTo(1.07, 2);
    expect(costFactorAt(buildingFactorSchedule, 9)).toBeCloseTo(1.0746, 3);
  });

  it("holds buildings flat at 25 through age 2, then cliffs at age 3", () => {
    for (let step = 0; step <= 3; step += 1) {
      expect(buildingFactorSchedule[step]).toBe(25);
    }
    expect(buildingFactorSchedule[4]).toBeCloseTo(8.13, 2);
    const cliff = buildingFactorSchedule[3] - buildingFactorSchedule[4];
    expect(cliff).toBeGreaterThan(15);
  });

  it("decays monotonically after the cliff, staying above the 1.01 clamp", () => {
    for (let step = 5; step < buildingFactorSchedule.length; step += 1) {
      expect(buildingFactorSchedule[step]).toBeLessThan(
        buildingFactorSchedule[step - 1],
      );
      expect(buildingFactorSchedule[step]).toBeGreaterThan(1.01);
    }
  });

  it("walks citizens from 2.5 down to 1.02 monotonically", () => {
    const last = citizenFactorSchedule.length - 1;
    expect(citizenFactorSchedule[0]).toBe(2.5);
    expect(citizenFactorSchedule[last]).toBeCloseTo(1.02, 2);
    for (let step = 1; step <= last; step += 1) {
      expect(citizenFactorSchedule[step]).toBeLessThan(
        citizenFactorSchedule[step - 1],
      );
      expect(citizenFactorSchedule[step]).toBeGreaterThan(1.01);
    }
  });

  it("clamps factor lookups to the schedule ends", () => {
    expect(costFactorAt(buildingFactorSchedule, -5)).toBe(25);
    expect(costFactorAt(buildingFactorSchedule, 99)).toBeCloseTo(1.0746, 3);
  });

  it("maps production-building counts to their decade step", () => {
    expect(productionStepFromCount(0)).toBe(0);
    expect(productionStepFromCount(1)).toBe(0);
    expect(productionStepFromCount(9)).toBe(0);
    expect(productionStepFromCount(10)).toBe(1);
    expect(productionStepFromCount(9_999)).toBe(3);
    expect(productionStepFromCount(10_000)).toBe(4);
    expect(productionStepFromCount(1_000_000_000)).toBe(9);
    expect(productionStepFromCount(5_000_000_000)).toBe(9);
  });
});
