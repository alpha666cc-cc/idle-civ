import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CivilizationState } from "../civilizationState";
import { ExpNumber } from "../expNumber";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "../attributes";
import { normalizeBonusDestination } from "../bonus";
import { emptyStatistics } from "../statistics";
import { UpgradeDefinition } from "../upgrades";
import { upgradeDefinitions } from "../upgrades";

/** Build a state with N wood workers, optional houses, and optional bought upgrades. */
const makeState = (
  woodWorkers: number,
  houseCount: number = 0,
  boughtUpgrades: readonly string[] = [],
  scienceWorkers: number = 0,
  universityCount: number = 0,
): CivilizationState =>
  new CivilizationState(
    emptyResourceAmounts(),
    {
      ...emptyWorkerAssignments(),
      wood: ExpNumber.fromNumber(woodWorkers),
      science: ExpNumber.fromNumber(scienceWorkers),
    },
    {
      townHall: 1,
      ...(houseCount > 0 ? { house: houseCount } : {}),
      ...(universityCount > 0 ? { university: universityCount } : {}),
    },
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
        destination: normalizeBonusDestination("wood.worker.efficiency"),
        value: ExpNumber.fromNumber(1.1),
      },
    ],
    { source: "buildingCount", building: "townHall", threshold: 1 },
  ),
  new UpgradeDefinition(
    "test-bonus-wood-production-and-efficiency",
    "Test Wood Production and Efficiency Bonus",
    "test",
    [{ resource: "food", base: ExpNumber.fromNumber(0), factor: 2, exponent: 0.5 }],
    [
      {
        type: "attributeMultiplier",
        destination: normalizeBonusDestination("wood"),
        value: ExpNumber.fromNumber(1.5),
      },
      {
        type: "attributeMultiplier",
        destination: normalizeBonusDestination("wood.worker.efficiency"),
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
        destination: normalizeBonusDestination(
          "basicProduction.worker.efficiency",
        ),
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
        destination: normalizeBonusDestination(
          "allProduction.worker.efficiency",
        ),
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
  new UpgradeDefinition(
    "test-flat-advanced-efficiency",
    "Test Flat Advanced Efficiency",
    "test",
    [{ resource: "food", base: ExpNumber.fromNumber(0), factor: 2, exponent: 0.5 }],
    [
      {
        type: "attributeFlat",
        destination: "advancedProductionPerWorker",
        value: ExpNumber.fromNumber(0.1),
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

  it("compounds resource, basic, and all worker-efficiency bonuses", () => {
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

  it("combines a wood production boost with wood worker efficiency", () => {
    const state = makeState(1000).buyUpgrade(
      "test-bonus-wood-production-and-efficiency",
    )!;

    // The resource multiplier applies to worker output after wood efficiency:
    // 1000 workers × 1.1 efficiency × 1.5 wood production.
    expect(state.computeResourceRate("wood").toNumber()).toBeCloseTo(
      1000 * 1.1 * 1.5,
      9,
    );
    expect(state.computeResourceRate("science").toNumber()).toBeCloseTo(0, 9);
  });

  it("keeps worker-efficiency scopes and building-only output separate", () => {
    const base = makeState(1000, 0, [], 1000);
    const woodOnly = base.buyUpgrade("test-bonus-wood")!;
    const basicOnly = base.buyUpgrade("test-bonus-basic")!;
    const allProduction = base.buyUpgrade("test-bonus-all")!;

    expect(woodOnly.computeResourceRate("wood").toNumber()).toBeCloseTo(
      1100,
      9,
    );
    expect(woodOnly.computeResourceRate("science").toNumber()).toBeCloseTo(
      100,
      9,
    );

    expect(basicOnly.computeResourceRate("wood").toNumber()).toBeCloseTo(
      1200,
      9,
    );
    expect(basicOnly.computeResourceRate("science").toNumber()).toBeCloseTo(
      100,
      9,
    );

    expect(
      allProduction.computeResourceRate("wood").toNumber(),
    ).toBeCloseTo(1300, 9);
    expect(
      allProduction.computeResourceRate("science").toNumber(),
    ).toBeCloseTo(130, 9);

    const universityOnly = makeState(0, 0, [], 0, 1);
    const universityWithWorkerBonus = universityOnly.buyUpgrade(
      "test-bonus-all",
    )!;
    expect(
      universityWithWorkerBonus.computeResourceRate("science").toNumber(),
    ).toBeCloseTo(
      universityOnly.computeResourceRate("science").toNumber(),
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

    // House bonus (destination "basicProduction.worker.efficiency", value 2e-5)
    // Scaling: (value × count)^power = (2e-5 × 150000)^0.22
    const houseScale = Math.pow(2e-5 * 150_000, 0.22);
    // Base: 1000 workers × 1 = 1000
    expect(state.computeResourceRate("wood").toNumber()).toBeCloseTo(
      1000 * houseScale,
      9,
    );
  });

  it("applies flat worker efficiency to workers, not building production", () => {
    const base = makeState(0, 0, [], 10, 1);
    const boosted = base.buyUpgrade("test-flat-advanced-efficiency")!;
    const buildingOnly = makeState(0, 0, [], 0, 1);
    const boostedBuildingOnly = buildingOnly.buyUpgrade(
      "test-flat-advanced-efficiency",
    )!;

    expect(
      boosted.getAttributeValue("scienceProductionPerWorker").toNumber(),
    ).toBeCloseTo(0.2, 9);
    expect(
      boostedBuildingOnly.computeResourceRate("science").toNumber(),
    ).toBeCloseTo(
      buildingOnly.computeResourceRate("science").toNumber(),
      9,
    );
    // The worker increment still receives the university's separate 5% bonus.
    const expectedWorkerIncrement = ExpNumber.fromNumber(1).mul(
      base.getModifierSummary("science").totalMultiplier,
    );
    expect(
      boosted
        .computeResourceRate("science")
        .sub(base.computeResourceRate("science"))
        .toNumber(),
    ).toBeCloseTo(expectedWorkerIncrement.toNumber(), 9);
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

    // Per-worker bonuses scale workers only; the general multiplier still
    // scales both worker output and the flat addition.
    const houseScale = Math.pow(2e-5 * 150_000, 0.22);
    expect(state.computeResourceRate("wood").toNumber()).toBeCloseTo(
      (1000 * houseScale * 1.1 * 1.2 * 1.3 + 500) * 2,
      9,
    );
  });

  it("house count changes production when house power > 0 with wood workers", () => {
    const houseScale125k = Math.pow(2e-5 * 125_000, 0.22);
    const houseScale1M = Math.pow(2e-5 * 1_000_000, 0.22);

    const state125k = makeState(1_000_000, 125_000);
    const withPower125k = state125k.buyUpgrade("test-house-power")!;

    const state1M = makeState(1_000_000, 1_000_000);
    const withPower1M = state1M.buyUpgrade("test-house-power")!;

    // With house power > 0 and wood workers assigned, production scales by
    // (value × count)^power. More houses → higher multiplier.
    const rate125k = withPower125k.computeResourceRate("wood").toNumber();
    const rate1M = withPower1M.computeResourceRate("wood").toNumber();
    expect(rate1M / rate125k).toBeCloseTo(
      houseScale1M / houseScale125k,
      9,
    );
  });

  it("building count changes invalidate the bonus cache", () => {
    // This test reproduces the caching bug: when building counts change on the
    // same state lineage (shared boughtUpgrades reference), the bonus map must
    // reflect the new counts, not the stale cached entry.
    const sharedUpgrades = ["test-house-power"];

    // State with 125k houses — populate the cache.
    const state125k = new CivilizationState(
      emptyResourceAmounts(),
      { ...emptyWorkerAssignments(), wood: ExpNumber.fromNumber(1_000_000) },
      { townHall: 1, house: 125_000 },
      emptyResourceFactors(),
      {},
      0,
      sharedUpgrades,
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
    const rate125k = state125k.computeResourceRate("wood").toNumber();

    // State with 1M houses — same boughtUpgrades reference, so the cache is
    // shared (as it is in the real game via withState).
    const state1M = new CivilizationState(
      emptyResourceAmounts(),
      { ...emptyWorkerAssignments(), wood: ExpNumber.fromNumber(1_000_000) },
      { townHall: 1, house: 1_000_000 },
      emptyResourceFactors(),
      {},
      0,
      sharedUpgrades,
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
    const rate1M = state1M.computeResourceRate("wood").toNumber();

    // With the fix, building bonuses are recomputed fresh, so production changes.
    // Before the fix, the cached (125k) result was returned and rates were equal.
    expect(rate1M).not.toBeCloseTo(rate125k, 9);
  });
});
