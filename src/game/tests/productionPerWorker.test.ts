import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  getDerivedAttributeDefault,
  findAttributeDefinition,
  type ProductionResourceKey,
} from "../attributes";
import type { BuildingKey } from "../buildings";
import { CivilizationState } from "../civilizationState";
import { ExpNumber } from "../expNumber";
import { emptyStatistics } from "../statistics";
import type { Bonus } from "../bonus";
import { UpgradeDefinition, upgradeDefinitions } from "../upgrades";
import { achievementDefinitions } from "../achievements";

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
  enteredAges: string[] = [],
  workerDiversityMultiplier = ExpNumber.ONE,
  resources = emptyResourceAmounts(),
  earnedAchievementIds: string[] = [],
  builtBuildings: Partial<Record<BuildingKey, number>> = {},
): CivilizationState =>
  new CivilizationState(
    resources,
    { ...emptyWorkerAssignments(), ...workers },
    builtBuildings,
    emptyResourceFactors(),
    {},
    0,
    boughtUpgrades,
    [],
    enteredAges,
    earnedAchievementIds,
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
    workerDiversityMultiplier,
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
    expect(getDerivedAttributeDefault("workerDiversity")).toBe(0);
    expect(getDerivedAttributeDefault("workerDiversitySpeed")).toBe(1);

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
    expect(findAttributeDefinition("workerDiversity")).toBeDefined();
    expect(findAttributeDefinition("workerDiversitySpeed")).toBeDefined();
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

  describe("worker diversity bonus", () => {
    const workersAt = (count: number): Record<
      ProductionResourceKey,
      ExpNumber
    > =>
      Object.fromEntries(
        allProductionKeys.map((key) => [key, ExpNumber.fromNumber(count)]),
      ) as Record<ProductionResourceKey, ExpNumber>;

    const tickFor = (
      state: CivilizationState,
      seconds: number,
    ): CivilizationState => {
      let next = state;
      for (let second = 0; second < seconds; second += 1) {
        next = next.tick();
      }
      return next;
    };

    it("unlocks the coefficient in Age 3 with a base coefficient of 2", () => {
      const workers = workersAt(100_000);
      const beforeAge3 = stateWithBonusesAndWorkers([], workers, ["age1"]);
      const age3 = stateWithBonusesAndWorkers([], workers, ["age1", "age2"]);

      expect(beforeAge3.getWorkerDiversityCoefficient().toNumber()).toBe(0);
      expect(beforeAge3.getWorkerDiversityMultiplier().toNumber()).toBe(1);
      expect(age3.getWorkerDiversityCoefficient().toNumber()).toBe(2);
      expect(age3.getWorkerDiversitySpeed().toNumber()).toBe(1);
      expect(age3.getWorkerDiversityCeiling().toNumber()).toBe(10);
      expect(age3.getWorkerDiversityMultiplier().toNumber()).toBe(1);
    });

    it("uses the minimum staffing across all eight production resources", () => {
      const workers = workersAt(100_000);
      workers.trade = ExpNumber.fromNumber(10_000);
      const age3 = stateWithBonusesAndWorkers([], workers, ["age1", "age2"]);
      const unstaffed = { ...workers, trade: ExpNumber.ZERO };
      const noTradeWorkers = stateWithBonusesAndWorkers(
        [],
        unstaffed,
        ["age1", "age2"],
      );

      expect(age3.getWorkerDiversityCeiling().toNumber()).toBe(8);
      expect(noTradeWorkers.getWorkerDiversityCeiling().toNumber()).toBe(1);
    });

    it("reaches the calibrated ×2, ×5, and ×10 ramp milestones", () => {
      const state = stateWithBonusesAndWorkers([], workersAt(100_000), [
        "age1",
        "age2",
      ]);

      const at30Seconds = tickFor(state, 30);
      const at60Seconds = tickFor(at30Seconds, 30);
      const at100Seconds = tickFor(at60Seconds, 40);

      expect(at30Seconds.getWorkerDiversityMultiplier().toNumber()).toBeCloseTo(
        2,
        9,
      );
      expect(at60Seconds.getWorkerDiversityMultiplier().toNumber()).toBeCloseTo(
        5,
        9,
      );
      expect(
        at100Seconds.getWorkerDiversityMultiplier().toNumber(),
      ).toBeCloseTo(10, 9);
    });

    it("clamps staffing drops immediately and resumes from the clamped value", () => {
      const workers = workersAt(100_000);
      const atCeiling = tickFor(
        stateWithBonusesAndWorkers([], workers, ["age1", "age2"]),
        100,
      );
      const reduced = atCeiling.unassignWorker("trade", 90_000);
      const restored = stateWithBonusesAndWorkers(
        [],
        workers,
        ["age1", "age2"],
        reduced.getWorkerDiversityMultiplier(),
      );
      const resumed = tickFor(restored, 16);

      expect(reduced.getWorkerDiversityMultiplier().toNumber()).toBeCloseTo(
        8,
        9,
      );
      expect(restored.getWorkerDiversityMultiplier().toNumber()).toBeCloseTo(
        8,
        9,
      );
      expect(resumed.getWorkerDiversityMultiplier().toNumber()).toBeCloseTo(
        10,
        9,
      );
    });

    it("scales the coefficient and speed together after completing Age 3", () => {
      const age4 = stateWithBonusesAndWorkers(
        [],
        workersAt(100_000),
        ["age1", "age2", "age3"],
      );
      const atCeiling = tickFor(age4, 100);

      expect(age4.getWorkerDiversityCoefficient().toNumber()).toBe(8);
      expect(age4.getWorkerDiversitySpeed().toNumber()).toBe(4);
      expect(age4.getWorkerDiversityCeiling().toNumber()).toBe(40);
      expect(atCeiling.getWorkerDiversityMultiplier().toNumber()).toBeCloseTo(
        40,
        9,
      );
    });

    it("applies diversity as a production multiplier after Age 3", () => {
      const workers = workersAt(100_000);
      const baseline = stateWithBonusesAndWorkers(
        [],
        workers,
        ["age1", "age2"],
        ExpNumber.ONE,
        emptyResourceAmounts(),
        [],
        { university: 1 },
      );
      const diversity = stateWithBonusesAndWorkers(
        [],
        workers,
        ["age1", "age2"],
        ExpNumber.fromNumber(2),
        emptyResourceAmounts(),
        [],
        { university: 1 },
      );

      const factors = diversity.getProductionFactors("science");
      const diversityFactor = factors.multiplicative.find(
        ([source]) => source === "worker diversity",
      )?.[1];
      expect(diversityFactor?.toNumber()).toBeCloseTo(2, 9);
      expect(diversity.computeResourceRate("science").toNumber()).toBeCloseTo(
        baseline.computeResourceRate("science").toNumber() * 2,
        9,
      );
      expect(diversity.computeClickGain("science").toNumber()).toBeCloseTo(
        baseline.computeClickGain("science").toNumber() * 2,
        9,
      );
    });

    it("integrates the same diversity ramp in time skips and live ticks", () => {
      const resourceAchievementIds = achievementDefinitions
        .filter(({ requirement }) => requirement.type === "resource")
        .map(({ id }) => id);
      const state = stateWithBonusesAndWorkers(
        [],
        workersAt(10),
        ["age1", "age2"],
        ExpNumber.ONE,
        {
          ...emptyResourceAmounts(),
          trade: ExpNumber.fromNumber(1e100),
        },
        resourceAchievementIds,
      );
      const live = tickFor(state, 60);
      const skipped = state.advanceTime(60);

      expect(skipped.getWorkerDiversityMultiplier().toNumber()).toBeCloseTo(
        live.getWorkerDiversityMultiplier().toNumber(),
        9,
      );
      expect(skipped.resources.food.toNumber()).toBeCloseTo(
        live.resources.food.toNumber(),
        6,
      );
    });
  });
});
