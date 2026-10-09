import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  getDerivedAttributeDefault,
  findAttributeDefinition,
} from "./attributes";
import { CivilizationState } from "./civilizationState";
import { ExpNumber } from "./expNumber";
import { emptyStatistics } from "./statistics";

/** A minimal state with workers assigned. */
const stateWithWorkers = (
  workers: Partial<
    Record<
      | "food"
      | "wood"
      | "stone"
      | "gold"
      | "military"
      | "science"
      | "metalwork"
      | "trade",
      ExpNumber
    >
  >,
): CivilizationState =>
  new CivilizationState(
    emptyResourceAmounts(),
    { ...emptyWorkerAssignments(), ...workers },
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

describe("productionPerWorker attributes", () => {
  it("has default values from derivedDefaults.json", () => {
    // Basic resources default to 1
    expect(getDerivedAttributeDefault("foodProductionPerWorker")).toBe(1);
    expect(getDerivedAttributeDefault("woodProductionPerWorker")).toBe(1);
    expect(getDerivedAttributeDefault("stoneProductionPerWorker")).toBe(1);
    expect(getDerivedAttributeDefault("goldProductionPerWorker")).toBe(1);

    // Advanced resources default to 0.1
    expect(getDerivedAttributeDefault("militaryProductionPerWorker")).toBe(0.1);
    expect(getDerivedAttributeDefault("scienceProductionPerWorker")).toBe(0.1);
    expect(getDerivedAttributeDefault("metalworkProductionPerWorker")).toBe(
      0.1,
    );
    expect(getDerivedAttributeDefault("tradeProductionPerWorker")).toBe(0.1);
  });

  it("is registered as derived attributes", () => {
    expect(findAttributeDefinition("foodProductionPerWorker")).toBeDefined();
    expect(findAttributeDefinition("scienceProductionPerWorker")).toBeDefined();
    expect(
      findAttributeDefinition("militaryProductionPerWorker"),
    ).toBeDefined();
  });

  it("applies default worker efficiency to resource rates", () => {
    const state = stateWithWorkers({
      food: ExpNumber.fromNumber(10),
      science: ExpNumber.fromNumber(10),
    });

    // Food: 10 workers × 1 = 10/sec
    expect(state.computeResourceRate("food").toNumber()).toBeCloseTo(10, 9);

    // Science: 10 workers × 0.1 = 1/sec
    expect(state.computeResourceRate("science").toNumber()).toBeCloseTo(1, 9);
  });

  it("multiplies worker production with individual attributeMultiplier bonus", () => {
    const state = stateWithWorkers({
      science: ExpNumber.fromNumber(10),
    });
    const factors = state.getDerivedAttributeFactors(
      "scienceProductionPerWorker",
    );
    expect(factors).toBeDefined();
    expect(factors?.base.toNumber()).toBe(0.1);
  });

  it("advancedProductionPerWorker bonus targets advanced resources only", () => {
    const state = stateWithWorkers({
      science: ExpNumber.fromNumber(10),
      military: ExpNumber.fromNumber(10),
      food: ExpNumber.fromNumber(10),
    });

    // All defaults
    expect(state.computeResourceRate("science").toNumber()).toBeCloseTo(1, 9);
    expect(state.computeResourceRate("military").toNumber()).toBeCloseTo(1, 9);
    expect(state.computeResourceRate("food").toNumber()).toBeCloseTo(10, 9);
  });

  it("applies to click gains as well as tick rates", () => {
    const state = stateWithWorkers({
      science: ExpNumber.fromNumber(10),
    });

    // Click: 1 click × 0.1 = 0.1
    expect(state.computeClickGain("science").toNumber()).toBeCloseTo(0.1, 9);
  });

  it("stacks with other production multipliers", () => {
    const state = stateWithWorkers({
      science: ExpNumber.fromNumber(10),
    }).addFactor("science", "multiplicative", [
      "building bonus",
      ExpNumber.fromNumber(2),
    ]);

    // Science: 10 workers × 0.1 × 2 (production mult) = 2/sec
    expect(state.computeResourceRate("science").toNumber()).toBeCloseTo(2, 9);
  });
});
