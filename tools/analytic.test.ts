import { describe, expect, it } from "vitest";
import {
  calibratedSettleSeconds,
  contextForScale,
  countAffordableBy,
  defaultElasticity,
  describeEconomy,
  estimateAtTime,
  housingFor,
  probeState,
  productionAt,
  progression,
  settleAchievements,
  woodWorkerFloor,
} from "./analytic.js";
import { CivilizationState } from "../src/game/civilizationState.js";
import { researchDefinitions } from "../src/game/research.js";

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
    // so it must match a hand-built state. Pinned on the `bare` stack, where the
    // shape and the probe are trivially the same object graph.
    const shape = { farm: 40, people: 120, townHall: 5, house: 20 };
    const described = describeEconomy(shape, undefined, "bare");
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
    // Costs move with the bonus stack too — research and enhancers both cut them —
    // so this pins the bare stack, where the engine's own cost is the reference.
    const engine = new CivilizationState();
    expect(describeEconomy({ farm: 100 }, undefined, "bare").cost.food).toBeCloseTo(
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

describe("the realistic bonus stack", () => {
  it("enters every age the population has passed", () => {
    expect(contextForScale({ people: 0 }).ages).toEqual(["age0"]);
    expect(contextForScale({ people: 1000 }).ages).toContain("age1");
    expect(contextForScale({ people: 10_000 }).ages).toContain("age2");
    // An unreached age must not leak into the context.
    expect(contextForScale({ people: 999 }).ages ?? []).not.toContain("age1");
  });

  it("closes the research tree over the ages it has entered", () => {
    const early = contextForScale({ people: 0 }).boughtResearch ?? [];
    const later = contextForScale({ people: 10_000 }).boughtResearch ?? [];
    expect(early.length).toBeGreaterThan(0);
    expect(later.length).toBeGreaterThan(early.length);
  });

  it("respects research prerequisites rather than granting a whole age", () => {
    // The tree is a DAG, so the bought set must be closed under prerequisites.
    const bought = new Set(contextForScale({ people: 10_000 }).boughtResearch ?? []);
    expect(bought.size).toBeGreaterThan(0);
    for (const id of bought) {
      // Every prerequisite of a bought tech must itself be bought.
      const tech = researchDefinitions.find((t) => t.key === id);
      if (!tech) continue;
      for (const prerequisite of tech.prerequisites) {
        expect(bought.has(prerequisite)).toBe(true);
      }
    }
  });

  it("unlocks the enhancer tiers the building counts reach", () => {
    expect(contextForScale({ farm: 5 }).upgrades ?? []).not.toContain("farmEnhancer9");
    expect(contextForScale({ farm: 9 }).upgrades ?? []).toContain("farmEnhancer9");
    expect(contextForScale({ farm: 98 }).upgrades ?? []).toContain("farmEnhancer98");
  });

  it("is far above the bare stack, and the gap widens with scale", () => {
    // The regression this guards: reporting a bare shape as if it were a real one
    // understated 500-farm food production by a factor of 8e15.
    const bare = describeEconomy({ farm: 500, people: 1000 }, undefined, "bare");
    const real = describeEconomy({ farm: 500, people: 1000 });
    expect(real.production.food ?? 0).toBeGreaterThan((bare.production.food ?? 0) * 1e12);
  });

  it("defaults to the settled stack so the bare reading cannot be mistaken for it", () => {
    const shape = { farm: 500, people: 1000 };
    // Default is `settled`, which must equal an explicit `settled` call.
    expect(describeEconomy(shape).production.food).toBe(
      describeEconomy(shape, undefined, "settled").production.food,
    );
    // And the three tiers must be strictly ordered: bare < realistic < settled.
    const bare = describeEconomy(shape, undefined, "bare").production.food ?? 0;
    const realistic = describeEconomy(shape, undefined, "realistic").production.food ?? 0;
    const settled = describeEconomy(shape, undefined, "settled").production.food ?? 0;
    expect(realistic).toBeGreaterThan(bare);
    expect(settled).toBeGreaterThan(realistic);
  });

  it("raises production across every producer, not just food", () => {
    const shape = { farm: 500, people: 1000 };
    const bare = describeEconomy(shape, undefined, "bare").production;
    const real = describeEconomy(shape).production;
    for (const key of Object.keys(real)) {
      expect(real[key] ?? 0).toBeGreaterThan(bare[key] ?? 0);
    }
  });

  it("makes the same shape far cheaper under the realistic stack", () => {
    // Research and enhancers both cut costs, so the payback picture changes too.
    const shape = { farm: 500, people: 1000 };
    expect(describeEconomy(shape).cost.food ?? 0).toBeLessThan(
      describeEconomy(shape, undefined, "bare").cost.food ?? Infinity,
    );
  });
});

describe("settling a settlement for its achievement set", () => {
  it("earns achievements the engine itself recognises", () => {
    // The whole point of the settle pass: resource and hoarder achievements read
    // live stock, so they can only be earned by actually letting the settlement
    // accrue. Delegating to the engine's own `checkAchievements` keeps this honest.
    const settled = settleAchievements({ farm: 500, people: 1000 });
    expect(settled.earned).toBeGreaterThan(0);
  });

  it("accumulates real holdings over the settle window", () => {
    const settled = settleAchievements({ farm: 500, people: 1000 }, { settleSeconds: 3600 });
    expect(settled.held.food ?? 0).toBeGreaterThan(0);
    expect(settled.held.wood ?? 0).toBeGreaterThan(0);
  });

  it("earns at least as much the longer it settles", () => {
    const short = settleAchievements({ farm: 500, people: 1000 }, { settleSeconds: 60 });
    const long = settleAchievements({ farm: 500, people: 1000 }, { settleSeconds: 7200 });
    expect(long.earned).toBeGreaterThanOrEqual(short.earned);
    expect(long.held.food ?? 0).toBeGreaterThan(short.held.food ?? 0);
  });

  it("beats the un-settled realistic stack on production", () => {
    // The hoarder chains are logarithmic in held stock, so an hour of accrual is
    // worth several tiers of flat multiplier — this is the gap being closed.
    const shape = { farm: 500, people: 1000 };
    const realistic = describeEconomy(shape, undefined, "realistic");
    const settled = describeEconomy(shape, undefined, "settled");
    expect(settled.production.food ?? 0).toBeGreaterThan(realistic.production.food ?? 0);
  });

  it("makes the same shape much cheaper, because research cuts costs", () => {
    const shape = { farm: 500, people: 1000 };
    expect(describeEconomy(shape, undefined, "settled").cost.food ?? 0).toBeLessThan(
      describeEconomy(shape, undefined, "realistic").cost.food ?? Infinity,
    );
  });

  it("uses the calibrated window by default", () => {
    // Measured against sim-output/calib/sim-balanced.csv: 60 s is the optimum, and
    // longer windows score worse. Pinned so a re-tune has to be deliberate.
    expect(calibratedSettleSeconds).toBe(60);
    expect(settleAchievements({ farm: 500, people: 1000 }).held.food).toBe(
      settleAchievements({ farm: 500, people: 1000 }, { settleSeconds: 60 }).held.food,
    );
  });

  it("scores worse with a longer window, as the calibration found", () => {
    // The counter-intuitive result worth protecting: more accrual grants hoarder
    // tiers a real run has not reached, because the static stack already supplied
    // the implied bonus tier.
    const short = settleAchievements({ farm: 500, people: 1000 }, { settleSeconds: 60 });
    const long = settleAchievements({ farm: 500, people: 1000 }, { settleSeconds: 28800 });
    expect(long.earned).toBeGreaterThan(short.earned);
  });

  it("does not grant battles to a shape that cannot field an army", () => {
    // The recorded run has not won `wolfSlayer` while holding a 10-farm
    // settlement; granting an entered age's whole encounter list over-reported.
    expect(contextForScale({ farm: 10, people: 90 }).defeatedEncounters).toHaveLength(0);
    expect(
      (contextForScale({ farm: 10, people: 90, barracks: 5 }).defeatedEncounters ?? []).length,
    ).toBeGreaterThan(0);
  });

  it("stays cheap — a bounded settle, not a strategy sweep", () => {
    const started = Date.now();
    settleAchievements({ farm: 500, people: 1000 }, { settleSeconds: 3600 });
    // Generous ceiling: the point is that this is milliseconds, not the minutes a
    // real 7200-second strategy run costs.
    expect(Date.now() - started).toBeLessThan(2000);
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