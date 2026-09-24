import { describe, expect, it } from "vitest";
import {
  buildingPowerAttributeDefinitions,
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  findAttributeDefinition,
  summarizeResourceFactors,
  type WorkerAssignments,
} from "./attributes";
import { buildingDefinitions, type BuildingKey } from "./buildings";
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

/** Like stateWith, but stocked with resources so upgrades are purchasable. */
const richState = (
  builtBuildings: Partial<Record<BuildingKey, number>> = {},
): CivilizationState =>
  new CivilizationState(
    {
      ...emptyResourceAmounts(),
      food: ExpNumber.fromNumber(1e12),
      wood: ExpNumber.fromNumber(1e12),
      stone: ExpNumber.fromNumber(1e12),
      gold: ExpNumber.fromNumber(1e12),
    },
    emptyWorkerAssignments(),
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

/**
 * Building resource bonuses scale as (perBuilding x count)^power: additive
 * percentages that sum, not compounding factors. So 10 farms at power 1 give
 * +100% (not 1.1^10 = 2.59), while a farm power of 2 on 20 farms gives
 * (0.1 x 20)^2 = 4.0. See getBuildingEffects() in civilizationState.ts.
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

  it("raises the total as power, with the pivot at 10 buildings", () => {
    // farmPower is a derived stat (base 1). The wolf-pack encounter grants farmPower x4.
    const boosted = stateWith({ farm: 20 }).defeatEncounter("age0_2_wolf_pack");
    expect(boosted.buildingPower("farm").toNumber()).toBeCloseTo(4, 9);
    // A bare farm (no power bonus) reads 1.
    expect(stateWith({ farm: 20 }).buildingPower("farm").toNumber()).toBe(1);
    // With power 1 the additive bonus is unchanged: (0.1 x 20) = 2.0.
    expect(foodSummary(stateWith({ farm: 20 })).additiveMultiplier.toNumber()).toBeCloseTo(2, 9);
    // With power 4 (the encounter), the bonus becomes (0.1 x 20)^4 = 16.0.
    // The exponent pivots at 10 buildings: below that it scales the bonus down
    // (5 farms ^ 2 = 0.25), above it up (20 farms ^ 4 = 16).
    expect(
      foodSummary(boosted).additiveMultiplier.toNumber(),
    ).toBeCloseTo(16, 9);
  });

  it("gives power only to production buildings, never house or town-hall", () => {
    const state = stateWith({ farm: 5, house: 5, "town-hall": 5 });
    // Production buildings carry a farmPower attribute and read it.
    expect(findAttributeDefinition("farmPower")).toBeDefined();
    // Capacity-only and drain-only buildings have no power attribute at all.
    for (const key of ["house", "town-hall", "people"]) {
      expect(findAttributeDefinition(`${key}Power`)).toBeUndefined();
      // buildingPower falls back to 1 so the exponent is a no-op for them.
      expect(state.buildingPower(key as BuildingKey).toNumber()).toBe(1);
    }
  });

  it("keeps the capacity base stored but reports effective capacity", () => {
    const bought = richState({ farm: 9 }).buyUpgrade("farm-enhancer-9");

    // The upgrade does not rewrite the saved/base resource. It is resolved on read.
    expect(bought.resources.farmCapacity.toNumber()).toBe(10);
    expect(bought.getBuildingMax("farm").toNumber()).toBe(100);
    // getAttributeValue intentionally exposes the stored/base capacity.
    expect(bought.getAttributeValue("farmCapacity").toNumber()).toBe(10);
  });

  it("raises power by +1 per enhancer upgrade and x2 when the first age ends", () => {
    // Each farm-enhancer-N upgrade grants +1 farmPower (a flat on the power
    // stat); the age-1 transition grants a global buildingPower x2 that folds
    // into every production building's power.
    // farm-enhancer-9 unlocks at 9 farms; buy it and power goes 1 -> 2.
    const base = richState({ farm: 9 });
    expect(base.buildingPower("farm").toNumber()).toBe(1);

    // Buy the first farm enhancer: +1 farmPower.
    const oneTier = base.buyUpgrade("farm-enhancer-9");
    expect(oneTier.isUpgradeBought("farm-enhancer-9")).toBe(true);
    expect(oneTier.buildingPower("farm").toNumber()).toBe(2);

    // Entering age-1 (end of the first age) doubles the global power, so the
    // farm's effective power goes from 2 to 2 x 2 = 4.
    const aged = oneTier.enterAge("age-1");
    expect(aged.getAttributeValue("buildingPower").toNumber()).toBe(2);
    expect(aged.buildingPower("farm").toNumber()).toBe(4);
  });

  it("takes its base power from the building definition, not a hardcoded 1", () => {
    // `power` lives on the definition, so a building may start above or below 1.
    for (const key of buildingPowerAttributeDefinitions.map(({ key }) => key)) {
      const building = buildingDefinitions.find(
        (b) => `${b.key}Power` === key,
      );
      expect(building).toBeDefined();
      expect(building?.power).toBeDefined();
      // The stat's bonus-free base must read that value.
      const state = stateWith();
      expect(state.getDerivedAttributeFactors(key)?.base).toEqual(building?.power);
    }
    // The shipped data bases all eight production buildings at 1.
    for (const key of [
      "farm",
      "lumber-yard",
      "quarry",
      "gold-mine",
      "barracks",
      "university",
      "smithy",
      "market",
    ]) {
      const building = buildingDefinitions.find((b) => b.key === key);
      expect(building?.power?.toNumber()).toBe(1);
      expect(stateWith().buildingPower(key as BuildingKey).toNumber()).toBe(1);
    }
    // Non-producers carry no power at all.
    for (const key of ["house", "town-hall", "people"] as const) {
      const building = buildingDefinitions.find((b) => b.key === key);
      expect(building?.power).toBeUndefined();
    }
  });
});
