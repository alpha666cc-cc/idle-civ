import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  summarizeResourceFactors,
  type WorkerAssignments,
} from "./attributes";
import type { BuildingKey } from "./buildings";
import { CivilizationState } from "./civilizationState";
import { ExpNumber } from "./expNumber";
import { emptyStatistics } from "./statistics";

/** An age-0 state with the given building counts and worker split. */
const stateWith = (
  builtBuildings: Partial<Record<BuildingKey, number>> = {},
  workers: WorkerAssignments = emptyWorkerAssignments(),
): CivilizationState =>
  new CivilizationState(
    emptyResourceAmounts(),
    workers,
    builtBuildings,
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

const foodSummary = (state: CivilizationState) =>
  summarizeResourceFactors(state.getProductionFactors("food"));

/**
 * Building resource bonuses are additive percentages (per building x power),
 * not compounding factors: 10 farms give +100%, not 1.1^10 = 2.59.
 */
describe("building resource bonuses", () => {
  it("adds one per-building bonus per copy", () => {
    const three = foodSummary(stateWith({ farm: 3 })).additiveMultiplier;
    const ten = foodSummary(stateWith({ farm: 10 })).additiveMultiplier;
    expect(three.toNumber()).toBeCloseTo(0.3, 9);
    expect(ten.toNumber()).toBeCloseTo(1, 9);
  });

  it("scales production by 1 + the summed bonus", () => {
    const summary = foodSummary(stateWith({ farm: 10 }));
    expect(summary.totalMultiplier.toNumber()).toBeCloseTo(2, 9);
  });

  it("sums bonuses from every source aimed at the resource", () => {
    const state = stateWith({ farm: 1 }).addFactor(
      "food",
      "additiveMultiplier",
      ["test bonus", ExpNumber.fromNumber(0.4)],
    );
    expect(foodSummary(state).additiveMultiplier.toNumber()).toBeCloseTo(0.5, 9);
  });

  it("keeps compounding multipliers compounding beside the sum", () => {
    const state = stateWith({ farm: 10 }).addFactor("food", "multiplicative", [
      "test multiplier",
      ExpNumber.fromNumber(2),
    ]);
    expect(foodSummary(state).totalMultiplier.toNumber()).toBeCloseTo(4, 9);
  });

  it("floors the sum so the multiplier never goes negative", () => {
    const state = stateWith().addFactor("food", "additiveMultiplier", [
      "test penalty",
      ExpNumber.fromNumber(-5),
    ]);
    expect(foodSummary(state).additiveMultiplier.toNumber()).toBe(-1);
    expect(foodSummary(state).totalMultiplier.toNumber()).toBe(0);
  });

  it("feeds the per-second rate", () => {
    const state = stateWith(
      { farm: 10 },
      { ...emptyWorkerAssignments(), food: ExpNumber.fromNumber(2) },
    );
    expect(state.computeResourceRate("food").toNumber()).toBeCloseTo(4, 9);
  });

  it("feeds the click path", () => {
    const gain = stateWith({ farm: 10 }).computeClickGain("food");
    expect(gain.toNumber()).toBeCloseTo(2, 9);
  });
});
