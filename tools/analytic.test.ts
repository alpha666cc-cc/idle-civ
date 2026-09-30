import { describe, expect, it } from "vitest";
import {
  countAffordableBy,
  defaultElasticity,
  describeEconomy,
  estimateAtTime,
  housingFor,
  probeState,
  productionAt,
  progression,
  woodWorkerFloor,
} from "./analytic.js";
import { CivilizationState } from "../src/game/civilizationState.js";

/**
 * The closed-form cost inversion is the load-bearing claim of this module: it is
 * what lets a budget be turned into a building count with no search loop. These
 * pin it against the engine's own `getBuildingCost`, which is the source of
 * truth, so the two can never disagree.
 */
describe("the closed-form cost inversion", () => {
  const engine = new CivilizationState();

  it("agrees with the engine's cumulative cost", () => {
    // The engine ceils each cost to a whole unit, so the budget fed back through
    // the inversion is up to one unit high and the recovered count lands a hair
    // above the true one. Two decimals is the honest tolerance; the error does not
    // grow with count, which is the property that matters at scale.
    for (const count of [100, 1000, 5000, 50_000]) {
      const engineCost = engine.getBuildingCost("farm", 0, count)[0].base.toNumber();
      expect(countAffordableBy("farm", "food", engineCost)).toBeCloseTo(count, 2);
    }
  });

  it("agrees on citizens at scale, where the sqrt branch dominates", () => {
    // Citizens keep a factor of only 2.5, so the engine's linear early-game floor
    // (§4.4) still applies at small counts and the closed form reads high there.
    // That is a documented limitation, asserted so it stays visible rather than
    // being discovered later as a surprise.
    for (const count of [500, 1000, 5000]) {
      const engineCost = engine.getBuildingCost("people", 0, count)[0].base.toNumber();
      expect(countAffordableBy("people", "food", engineCost)).toBeCloseTo(count, 4);
    }
    // Below the crossover it is an over-estimate, never an under-estimate.
    const small = engine.getBuildingCost("people", 0, 10)[0].base.toNumber();
    expect(countAffordableBy("people", "food", small)).toBeGreaterThan(10);
  });

  it("returns nothing for a budget below the first unit", () => {
    expect(countAffordableBy("farm", "food", 0)).toBe(0);
    expect(countAffordableBy("farm", "food", 5)).toBe(0);
  });

  it("grows monotonically with the budget", () => {
    let previous = 0;
    for (const budget of [1e3, 1e6, 1e9, 1e12, 1e15]) {
      const count = countAffordableBy("farm", "food", budget);
      expect(count).toBeGreaterThan(previous);
      previous = count;
    }
  });

  it("reads the same curve the engine uses, not a hardcoded one", () => {
    // A data change to the base or factor must move both sides together.
    const engineCost = engine.getBuildingCost("quarry", 0, 250)[0].base.toNumber();
    expect(countAffordableBy("quarry", "stone", engineCost)).toBeCloseTo(250, 4);
  });
});

describe("the housing chain", () => {
  it("supports the population it is asked for", () => {
    for (const population of [10, 100, 1000, 10000]) {
      expect(housingFor(population).supported).toBeGreaterThanOrEqual(population);
    }
  });

  it("is monotonic in the population requested", () => {
    let previous = 0;
    for (const population of [10, 100, 1000, 10000]) {
      const townHalls = housingFor(population).townHalls;
      expect(townHalls).toBeGreaterThanOrEqual(previous);
      previous = townHalls;
    }
  });

  it("reports nothing for an empty population", () => {
    expect(housingFor(0)).toEqual({ townHalls: 0, houses: 0, supported: 0 });
  });
});

describe("the exact inverse direction", () => {
  it("reports the population and production of a given shape", () => {
    const described = describeEconomy({ farm: 500, people: 1000 });
    expect(described.population).toBe(1000);
    expect(described.shape.farm).toBe(500);
    expect(described.production.food).toBeGreaterThan(0);
  });

  it("agrees with the engine's own rate for the same shape", () => {
    // The whole claim of this direction is that it evaluates rather than models,
    // so it must match a hand-built state.
    const shape = { farm: 40, people: 120, townHall: 5, house: 20 };
    const described = describeEconomy(shape);
    expect(described.production.food).toBeCloseTo(
      probeState(shape).computeResourceRate("food").toNumber(),
      6,
    );
  });

  it("solves the housing the requested population needs", () => {
    const described = describeEconomy({ farm: 10, people: 250 });
    expect(described.housing.supported).toBeGreaterThanOrEqual(250);
    expect(described.population).toBe(250);
  });

  it("prices the shape from an empty start", () => {
    const engine = new CivilizationState();
    expect(describeEconomy({ farm: 100 }).cost.food).toBeCloseTo(
      engine.getBuildingCost("farm", 0, 100)[0].base.toNumber(),
      6,
    );
  });

  it("scales production with the farm count", () => {
    const small = productionAt({ farm: 10, people: 100 });
    const large = productionAt({ farm: 100, people: 100 });
    expect(large.food).toBeGreaterThan(small.food ?? 0);
  });
});

describe("the forward estimate", () => {
  it("is empty at time zero", () => {
    expect(estimateAtTime(0).population).toBe(0);
  });

  it("grows monotonically with elapsed time", () => {
    // Sampled past the click-driven cold start, where the model is documented to
    // hold at its seed. Below that the answer is flat, not decreasing.
    let previousFarms = 0;
    let previousPopulation = 0;
    for (const seconds of [3600, 4800, 6000, 7200]) {
      const estimate = estimateAtTime(seconds);
      const farms = estimate.shape.farm ?? 0;
      expect(farms).toBeGreaterThan(previousFarms);
      // Population is housing-gated: the wood budget buys houses ten citizens at a
      // time, so it moves in steps and can legitimately hold steady between them.
      expect(estimate.population).toBeGreaterThanOrEqual(previousPopulation);
      previousFarms = farms;
      previousPopulation = estimate.population;
    }
  });

  it("holds at its seed rather than collapsing before the cold start", () => {
    // The first hour is click-driven and outside the model (see the accuracy
    // table on `estimateAtTime`), so the estimate is flat there rather than wrong
    // in a way that could be mistaken for a real reading.
    expect(estimateAtTime(60).shape.farm).toBe(estimateAtTime(2400).shape.farm);
    expect(estimateAtTime(60).population).toBe(estimateAtTime(2400).population);
  });

  it("escapes the zero-wood dead zone", () => {
    // A single citizen staffs no wood at all, so a seed below the floor has a
    // zero wood rate, buys no house, and can never grow. This trap is what the
    // seed exists to avoid, so it is asserted rather than assumed.
    expect(
      probeState({ farm: 1, people: 1 }).computeResourceRate("wood").toNumber(),
    ).toBeLessThanOrEqual(0);
    expect(woodWorkerFloor).toBeGreaterThan(1);
    expect(estimateAtTime(3600).population).toBeGreaterThan(woodWorkerFloor);
  });

  it("takes the farm enhancer tiers its budget unlocks", () => {
    // Tier I unlocks at 9 farms; the estimate must pass that threshold.
    expect(estimateAtTime(7200).shape.farm ?? 0).toBeGreaterThan(9);
  });

  it("stays in the right order of magnitude from the first hour on", () => {
    // Ground truth from sim-output/sim2h/sim-balanced.csv (the `balanced`
    // strategy). The first hour is deliberately excluded: that part of the
    // recorded run is click-driven and this model has no click term, so it is
    // pinned at the seed by design. Bands are loose on purpose — this is a
    // sanity check, not a simulation.
    const actual = [
      { seconds: 3600, farms: 58, population: 487 },
      { seconds: 7200, farms: 80, population: 559 },
    ];
    for (const point of actual) {
      const estimate = estimateAtTime(point.seconds);
      const farms = estimate.shape.farm ?? 0;
      expect(farms / point.farms).toBeGreaterThan(0.5);
      expect(farms / point.farms).toBeLessThan(1.3);
      expect(estimate.population / point.population).toBeGreaterThan(0.2);
      expect(estimate.population / point.population).toBeLessThan(1.2);
    }
  });

  it("is systematically low rather than noisy", () => {
    // A recorded fit, not a coincidence: the estimator under-predicts because it
    // models no transient surplus. Asserted so a change that makes it wildly
    // over-predict is caught, and so the bias stays documented.
    for (const seconds of [3600, 4800, 6000, 7200]) {
      const farms = estimateAtTime(seconds).shape.farm ?? 0;
      expect(farms).toBeLessThanOrEqual(80);
      expect(farms).toBeGreaterThan(20);
    }
  });

  it("responds to the elasticity knob", () => {
    const loose = estimateAtTime(7200, {}, defaultElasticity + 1);
    const tight = estimateAtTime(7200, {}, defaultElasticity - 1);
    // A larger divisor means a smaller budget, so fewer farms.
    expect(loose.shape.farm).toBeLessThan(tight.shape.farm ?? 0);
  });

  it("responds to the farm-share knob", () => {
    const small = estimateAtTime(7200, {}, defaultElasticity, 0.1);
    const large = estimateAtTime(7200, {}, defaultElasticity, 0.9);
    expect(large.shape.farm).toBeGreaterThan(small.shape.farm ?? 0);
  });

  it("keeps the other primary producers in step with farms", () => {
    const estimate = estimateAtTime(3600);
    expect(estimate.shape.lumberYard).toBe(estimate.shape.farm);
    expect(estimate.shape.quarry).toBe(estimate.shape.farm);
    expect(estimate.shape.goldMine).toBe(estimate.shape.farm);
  });

  it("samples a whole progression on one time axis", () => {
    const marks = [600, 1200, 2400, 4800];
    const samples = progression(marks);
    expect(samples).toHaveLength(marks.length);
    expect(samples[0].population).toBeLessThan(samples[3].population);
  });
});

describe("the probe state", () => {
  it("assigns every idle worker", () => {
    expect(probeState({ farm: 10, people: 100 }).assignedWorkers).toBe(100);
  });

  it("derives population from the people count, not a stored field", () => {
    expect(probeState({ people: 77 }).population.toNumber()).toBe(77);
  });

  it("raises capacity so a shape is never silently truncated", () => {
    expect(probeState({ farm: 500 }).buildingCount("farm")).toBe(500);
  });

  it("refuses fractional counts rather than storing them", () => {
    expect(probeState({ farm: 10.9 }).buildingCount("farm")).toBe(10);
  });
});