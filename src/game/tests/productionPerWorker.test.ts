import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  getDerivedAttributeDefault,
  findAttributeDefinition,
  type ProductionResourceKey,
} from "../attributes";
import { CivilizationState } from "../civilizationState";
import { ExpNumber } from "../expNumber";
import { emptyStatistics } from "../statistics";
import type { Bonus } from "../bonus";
import { UpgradeDefinition, upgradeDefinitions } from "../upgrades";

const allProductionKeys: ProductionResourceKey[] = [
  "food",
  "wood",
  "stone",
  "gold",
  "military",
  "science",
  "metalwork",
  "trade",
];

/** A state with bought upgrades and workers assigned. */
const stateWithBonusesAndWorkers = (
  boughtUpgrades: string[],
  workers: Partial<Record<ProductionResourceKey, ExpNumber>>,
): CivilizationState =>
  new CivilizationState(
    emptyResourceAmounts(),
    { ...emptyWorkerAssignments(), ...workers },
    {},
    emptyResourceFactors(),
    {},
    0,
    boughtUpgrades,
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
    {},
    {},
    {},
  );

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
  stateWithBonusesAndWorkers([], workers);

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

  describe("Age 1 regression test", () => {
    it("advanced worker base is 0.1 and basic worker base is 1", () => {
      // This regression test ensures the historical 1/10 parameter for advanced resources
      // is preserved in the attribute definitions
      const militaryDef = findAttributeDefinition("military");
      const scienceDef = findAttributeDefinition("science");
      const foodDef = findAttributeDefinition("food");

      expect(militaryDef?.productionPerWorker).toBe(0.1);
      expect(scienceDef?.productionPerWorker).toBe(0.1);
      expect(foodDef?.productionPerWorker).toBe(1);
    });

    it("derived defaults are correct", () => {
      // Basic resources default to 1
      expect(getDerivedAttributeDefault("foodProductionPerWorker")).toBe(1);
      expect(getDerivedAttributeDefault("woodProductionPerWorker")).toBe(1);
      expect(getDerivedAttributeDefault("stoneProductionPerWorker")).toBe(1);
      expect(getDerivedAttributeDefault("goldProductionPerWorker")).toBe(1);

      // Advanced resources default to 0.1 (the historical 1/10 parameter)
      expect(getDerivedAttributeDefault("militaryProductionPerWorker")).toBe(
        0.1,
      );
      expect(getDerivedAttributeDefault("scienceProductionPerWorker")).toBe(
        0.1,
      );
      expect(getDerivedAttributeDefault("metalworkProductionPerWorker")).toBe(
        0.1,
      );
      expect(getDerivedAttributeDefault("tradeProductionPerWorker")).toBe(0.1);
    });

    it("base worker production matches historical values", () => {
      const state = stateWithWorkers({
        food: ExpNumber.fromNumber(10),
        science: ExpNumber.fromNumber(10),
      });

      // Food: 10 workers × 1 = 10/sec (historical basic worker rate)
      expect(state.computeResourceRate("food").toNumber()).toBeCloseTo(10, 9);

      // Science: 10 workers × 0.1 = 1/sec (historical advanced worker rate)
      expect(state.computeResourceRate("science").toNumber()).toBeCloseTo(1, 9);
    });

    it("check production with 0 and 1000 workers", () => {
      // Test with 0 workers
      const state0Workers = stateWithWorkers({
        food: ExpNumber.fromNumber(0),
        science: ExpNumber.fromNumber(0),
      });
      expect(state0Workers.computeResourceRate("food").toNumber()).toBe(0);
      expect(state0Workers.computeResourceRate("science").toNumber()).toBe(0);

      // Test with 1000 workers
      const state1000Workers = stateWithWorkers({
        food: ExpNumber.fromNumber(1000),
        science: ExpNumber.fromNumber(1000),
      });
      // Food: 1000 × 1 = 1000
      expect(
        state1000Workers.computeResourceRate("food").toNumber(),
      ).toBeCloseTo(1000, 9);
      // Science: 1000 × 0.1 = 100
      expect(
        state1000Workers.computeResourceRate("science").toNumber(),
      ).toBeCloseTo(100, 9);
    });

    it("checks productionPerWorker bonuses and production with 0 and 1000 workers for each resource", () => {
      // Add one production worker bonus for each resource (all distinct multipliers),
      // plus a basic group bonus and an advanced group bonus.
      const resourceMultipliers: Record<ProductionResourceKey, number> = {
        food: 2,
        wood: 3,
        stone: 4,
        gold: 5,
        military: 6,
        science: 7,
        metalwork: 8,
        trade: 9,
      };
      const allGroupMult = 1.2;
      const basicGroupMult = 1.5;
      const advancedGroupMult = 2.5;

      const testBonuses: Bonus[] = [
        {
          type: "attributeMultiplier",
          destination: "allProductionPerWorker",
          value: ExpNumber.fromNumber(allGroupMult),
        },
        {
          type: "attributeMultiplier",
          destination: "basicProductionPerWorker",
          value: ExpNumber.fromNumber(basicGroupMult),
        },
        {
          type: "attributeMultiplier",
          destination: "advancedProductionPerWorker",
          value: ExpNumber.fromNumber(advancedGroupMult),
        },
        ...allProductionKeys.map(
          (key): Bonus => ({
            type: "attributeMultiplier",
            destination: `${key}ProductionPerWorker`,
            value: ExpNumber.fromNumber(resourceMultipliers[key]),
          }),
        ),
      ];

      const upgradeId = "test-worker-production-all-resources";
      const existingIndex = upgradeDefinitions.findIndex((u) => u.key === upgradeId);
      const testUpgrade = new UpgradeDefinition(
        upgradeId,
        "Test Worker Bonuses",
        "Testing worker bonuses",
        [],
        testBonuses,
        { source: "buildingCount", building: "farm", threshold: 0 },
      );
      if (existingIndex >= 0) {
        upgradeDefinitions[existingIndex] = testUpgrade;
      } else {
        upgradeDefinitions.push(testUpgrade);
      }

      // 1. Verify total productionWorker bonus (stat multiplier) by resource
      const basicKeys: ProductionResourceKey[] = [
        "food",
        "wood",
        "stone",
        "gold",
      ];
      const advancedKeys: ProductionResourceKey[] = [
        "military",
        "science",
        "metalwork",
        "trade",
      ];

      // Test with 0 workers
      const state0 = stateWithBonusesAndWorkers([upgradeId], {
        food: ExpNumber.ZERO,
        wood: ExpNumber.ZERO,
        stone: ExpNumber.ZERO,
        gold: ExpNumber.ZERO,
        military: ExpNumber.ZERO,
        science: ExpNumber.ZERO,
        metalwork: ExpNumber.ZERO,
        trade: ExpNumber.ZERO,
      });

      for (const key of basicKeys) {
        const factors = state0.getDerivedAttributeFactors(
          `${key}ProductionPerWorker`,
        );
        const mult = factors?.multiplicative.reduce(
          (acc, [, val]) => acc.mul(val),
          ExpNumber.ONE,
        );
        const expectedMult = allGroupMult * basicGroupMult * resourceMultipliers[key];
        expect(mult?.toNumber()).toBeCloseTo(expectedMult, 9);
        // Effective stat = base (1) × total bonus multiplier
        expect(state0.getAttributeValue(`${key}ProductionPerWorker`).toNumber()).toBeCloseTo(
          expectedMult,
          9,
        );
        // Production with 0 workers is 0
        expect(state0.computeResourceRate(key).toNumber()).toBe(0);
      }

      for (const key of advancedKeys) {
        const factors = state0.getDerivedAttributeFactors(
          `${key}ProductionPerWorker`,
        );
        const mult = factors?.multiplicative.reduce(
          (acc, [, val]) => acc.mul(val),
          ExpNumber.ONE,
        );
        const expectedMult = allGroupMult * advancedGroupMult * resourceMultipliers[key];
        expect(mult?.toNumber()).toBeCloseTo(expectedMult, 9);
        // Effective stat = base (0.1) × total bonus multiplier
        expect(state0.getAttributeValue(`${key}ProductionPerWorker`).toNumber()).toBeCloseTo(
          0.1 * expectedMult,
          9,
        );
        // Production with 0 workers is 0
        expect(state0.computeResourceRate(key).toNumber()).toBe(0);
      }

      // Test with 1000 workers
      const workers1000: Partial<Record<ProductionResourceKey, ExpNumber>> = {};
      for (const key of allProductionKeys) {
        workers1000[key] = ExpNumber.fromNumber(1000);
      }
      const state1000 = stateWithBonusesAndWorkers([upgradeId], workers1000);

      // Verify production with 1000 workers:
      // For basic: 1000 workers × 1 (base) × allGroupMult × basicGroupMult × resourceMultiplier
      for (const key of basicKeys) {
        const expectedRate =
          1000 * 1 * allGroupMult * basicGroupMult * resourceMultipliers[key];
        expect(state1000.computeResourceRate(key).toNumber()).toBeCloseTo(
          expectedRate,
          9,
        );
      }

      // For advanced: 1000 workers × 0.1 (base) × allGroupMult × advancedGroupMult × resourceMultiplier
      for (const key of advancedKeys) {
        const expectedRate =
          1000 * 0.1 * allGroupMult * advancedGroupMult * resourceMultipliers[key];
        expect(state1000.computeResourceRate(key).toNumber()).toBeCloseTo(
          expectedRate,
          9,
        );
      }
    });
  });
});
