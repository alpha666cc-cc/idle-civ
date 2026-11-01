import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CivilizationState } from "../civilizationState";
import { ExpNumber } from "../expNumber";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "../attributes";
import { emptyStatistics } from "../statistics";
import { UpgradeDefinition } from "../upgrades";
import { upgradeDefinitions } from "../upgrades";

/** Build a state with N wood workers, optional houses, and optional bought upgrades. */
const makeState = (
  woodWorkers: number,
  houseCount: number = 0,
  boughtUpgrades: readonly string[] = [],
): CivilizationState =>
  new CivilizationState(
    emptyResourceAmounts(),
    { ...emptyWorkerAssignments(), wood: ExpNumber.fromNumber(woodWorkers) },
    { townHall: 1, ...(houseCount > 0 ? { house: houseCount } : {}) },
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
  );

/** Test upgrades pushed into the registry for the duration of the describe block. */
const testUpgrades: UpgradeDefinition[] = [
  new UpgradeDefinition(
    "test-bonus-wood",
    "Test Wood Bonus",
    "test",
    [{ resource: "food", base: ExpNumber.fromNumber(0), factor: 2, exponent: 0.5 }],
    [
      {
        type: "attributeMultiplier",
        destination: "wood",
        value: ExpNumber.fromNumber(1.1),
      },
    ],
    { source: "buildingCount", building: "townHall", threshold: 1 },
  ),
  new UpgradeDefinition(
    "test-bonus-basic",
    "Test Basic Production Bonus",
    "test",
    [{ resource: "food", base: ExpNumber.fromNumber(0), factor: 2, exponent: 0.5 }],
    [
      {
        type: "attributeMultiplier",
        destination: "basicProduction",
        value: ExpNumber.fromNumber(1.2),
      },
    ],
    { source: "buildingCount", building: "townHall", threshold: 1 },
  ),
  new UpgradeDefinition(
    "test-bonus-all",
    "Test All Production Bonus",
    "test",
    [{ resource: "food", base: ExpNumber.fromNumber(0), factor: 2, exponent: 0.5 }],
    [
      {
        type: "attributeMultiplier",
        destination: "allProduction",
        value: ExpNumber.fromNumber(1.3),
      },
    ],
    { source: "buildingCount", building: "townHall", threshold: 1 },
  ),
  new UpgradeDefinition(
    "test-house-power",
    "Test House Power Bonus",
    "test",
    [{ resource: "food", base: ExpNumber.fromNumber(0), factor: 2, exponent: 0.5 }],
    [
      {
        type: "attributeFlat",
        destination: "housePower",
        value: ExpNumber.fromNumber(0.22),
      },
    ],
    { source: "buildingCount", building: "townHall", threshold: 1 },
  ),
];

describe("building bonus scaling matches additiveMultiplier curve", () => {
  beforeEach(() => {
    for (const u of testUpgrades) upgradeDefinitions.push(u);
  });

  afterEach(() => {
    for (const u of testUpgrades) {
      const idx = upgradeDefinitions.findIndex((x) => x.key === u.key);
      if (idx >= 0) upgradeDefinitions.splice(idx, 1);
    }
  });

  it("stacks worker-efficiency bonuses from upgrade, achievement, research on wood", () => {
    let state = makeState(1000);
    state = state.buyUpgrade("test-bonus-wood")!;
    state = state.buyUpgrade("test-bonus-basic")!;
    state = state.buyUpgrade("test-bonus-all")!;

    // 1000 workers × 1 base × 1.1 (wood) × 1.2 (basic) × 1.3 (all)
    expect(state.computeResourceRate("wood").toNumber()).toBeCloseTo(
      1000 * 1.1 * 1.2 * 1.3,
      9,
    );
  });

  it("houses with power 0 do not change wood production", () => {
    const base = makeState(1000);
    const withHouses = makeState(1000, 150_000);

    expect(
      withHouses.computeResourceRate("wood").toNumber(),
    ).toBeCloseTo(base.computeResourceRate("wood").toNumber(), 9);
  });

  it("houses with power 0.22 scale bonus by (value × count)^power", () => {
    let state = makeState(1000, 150_000);
    state = state.buyUpgrade("test-house-power")!;

    // House bonus (destination "basicProduction.worker.efficiency", value 0.01)
    // Scaling: (value × count)^power = (0.01 × 150000)^0.22
    const houseScale = Math.pow(0.01 * 150_000, 0.22);
    // Base: 1000 workers × 1 = 1000
    expect(state.computeResourceRate("wood").toNumber()).toBeCloseTo(
      1000 * houseScale,
      9,
    );
  });

  it("wood production flat and multiplier bonuses stack correctly", () => {
    let state = makeState(1000);

    // Flat bonus: +500 wood/sec → additional pile
    state = state.addFactor("wood", "additional", [
      "flat bonus",
      ExpNumber.fromNumber(500),
    ]);

    // Multiplier bonus: ×2 wood production → multiplicative pile
    state = state.addFactor("wood", "multiplicative", [
      "multiplier bonus",
      ExpNumber.fromNumber(2),
    ]);

    // additional = 1000 workers × 1 + 500 flat = 1500
    // totalMultiplier = 2
    // result = 1500 × 2 = 3000
    expect(state.computeResourceRate("wood").toNumber()).toBeCloseTo(3000, 9);
  });

  it("upgrade bonus and house bonus compound multiplicatively", () => {
    let state = makeState(1000, 150_000);
    state = state.buyUpgrade("test-bonus-wood")!; // ×1.1 to wood
    state = state.buyUpgrade("test-bonus-basic")!; // ×1.2 to basicProduction
    state = state.buyUpgrade("test-bonus-all")!; // ×1.3 to allProduction
    state = state.buyUpgrade("test-house-power")!; // house power 0.22

    // Flat bonus: +500 wood/sec → additional pile
    state = state.addFactor("wood", "additional", [
      "flat bonus",
      ExpNumber.fromNumber(500),
    ]);

    // Multiplier bonus: ×2 wood production → multiplicative pile
    state = state.addFactor("wood", "multiplicative", [
      "multiplier bonus",
      ExpNumber.fromNumber(2),
    ]);

    // additionalTotal = 1000 workers × 1 + 500 flat = 1500
    // multiplier = 1.1 (wood) × 1.2 (basic) × 1.3 (all) × houseScale × 2
    // result = 1500 × 1.1 × 1.2 × 1.3 × houseScale × 2
    const houseScale = Math.pow(0.01 * 150_000, 0.22);
    expect(state.computeResourceRate("wood").toNumber()).toBeCloseTo(
      (1000 + 500) * 1.1 * 1.2 * 1.3 * houseScale * 2,
      9,
    );
  });
});
