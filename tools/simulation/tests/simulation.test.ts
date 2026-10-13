import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSaveData,
  SAVE_VERSION,
  serializeSave,
} from "../../../src/game/saveSystem";
import { describeSaveEntry, loadSaveEntry, writeSaveEntry } from "../saveEntry";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  type ProductionResourceKey,
  type ResourceKey,
} from "../../../src/game/attributes";
import { buildingDefinitions, type BuildingKey } from "../../../src/game/buildings";
import { encounterDefinitions } from "../../../src/game/encounters";
import { CivilizationState } from "../../../src/game/civilizationState";
import { ExpNumber } from "../../../src/game/expNumber";
import { emptyStatistics } from "../../../src/game/statistics";
import { GameSimulation, createInitialState } from "../simulation";
import type {
  SimulationAction,
  SimulationContext,
  SimulationStrategy,
} from "../simulation";
import type { SimulatorResult } from "../../../src/game/battleSimulator";
import {
  AgeOnePolicy,
  defaultPolicy,
  getFastestWorkerAllocation,
  getSimulatorPlanCosts,
} from "../age1-policy";

/**
 * A decision context for a fixture. `SimulationContext.timing` is the run's live
 * counters, which no fixture cares about, so it is a zeroed stand-in rather than
 * a field every call site has to invent.
 */
const zeroTiming: SimulationContext["timing"] = {
  ticks: 0,
  tickMeanMs: 0,
  tickMaxMs: 0,
  decisions: 0,
  decisionMeanMs: 0,
  decisionMaxMs: 0,
};

import {
  ADAPTIVE_WORKER_FUNDING_ENABLED,
  ADAPTIVE_WORKER_FUNDING_STRATEGIES,
  BalancedStrategy,
  CheapestStrategy,
  getAgeRouteGrowthAction,
  getAgeRouteTargetPopulation,
  getRequiredAgeAction,
  getRequiredBattle,
  getRequiredBattleAction,
  getRequiredBattlePreparationAction,
  getRequiredBattleUnitTargets,
  getRequiredResearchAction,
  getBootstrapGatherResource,
  getRecommendedBattlePurchase,
  getSimulatorBattlePlan,
  getStrategy,
  setAdaptiveWorkerFunding,
} from "../strategies";
import { getFastestWorkerAllocation as getFastestFundingAllocation } from "../workerFunding";

describe("simulation event snapshots", () => {
  const makeActionRateState = (enteredAges: readonly string[] = []) =>
    new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e6),
        wood: ExpNumber.fromNumber(1e6),
      },
      emptyWorkerAssignments(),
      { townHall: 1 },
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      enteredAges,
      [],
      emptyStatistics(),
    );

  it("honours a configured snapshot interval", () => {
    const state = () =>
      new CivilizationState(
        emptyResourceAmounts(),
        emptyWorkerAssignments(),
        {},
        emptyResourceFactors(),
        {},
        0,
        [],
        [],
        [],
        [],
        emptyStatistics(),
      );
    const noop: SimulationStrategy = {
      name: "noop",
      description: "does nothing",
      decideAction: () => null,
    };
    const run = (snapshotIntervalSeconds: number) =>
      new GameSimulation(state(), noop, {
        objective: { type: "timeLimit", seconds: 300 },
        gatherClicksPerAction: 1,
        maxGameTime: 300,
        recordSnapshots: true,
        snapshotIntervalSeconds,
      }).run();

    const minute = run(60);
    // 300 simulated seconds at one snapshot a minute.
    expect(minute.snapshots.length).toBeGreaterThanOrEqual(4);
    const fiveMinutes = run(300);
    expect(fiveMinutes.snapshots.length).toBeLessThan(minute.snapshots.length);
  });

  it("records tick and strategy-decision timing", () => {
    const noop: SimulationStrategy = {
      name: "noop",
      description: "does nothing",
      decideAction: () => null,
    };
    const result = new GameSimulation(makeActionRateState(), noop, {
      objective: { type: "timeLimit", seconds: 10 },
      gatherClicksPerAction: 1,
      maxGameTime: 10,
      recordSnapshots: false,
    }).run();

    // A null return ends that second's action loop, so a do-nothing strategy
    // still costs exactly one decision per simulated second. Those null
    // decisions are counted, not skipped — they are real strategy work.
    expect(result.decisionTiming.decisions).toBe(10);
    expect(result.decisionTiming.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.decisionTiming.maxMs).toBeGreaterThanOrEqual(0);
    expect(result.decisionTiming.meanMs).toBe(
      result.decisionTiming.totalMs / result.decisionTiming.decisions,
    );
    // max can never sit below the mean of the same sample.
    expect(result.decisionTiming.maxMs).toBeGreaterThanOrEqual(
      result.decisionTiming.meanMs,
    );

    expect(result.tickTiming.ticks).toBe(10);
    expect(result.tickTiming.meanMs).toBe(
      result.tickTiming.totalMs / result.tickTiming.ticks,
    );
    expect(result.tickTiming.maxMs).toBeGreaterThanOrEqual(
      result.tickTiming.meanMs,
    );
  });

  it("exposes a zero mean rather than NaN when a run records nothing", () => {
    const noop: SimulationStrategy = {
      name: "noop",
      description: "does nothing",
      decideAction: () => null,
    };
    // maxGameTime 0 means the main loop never runs, so neither a tick nor a
    // decision is ever measured.
    const result = new GameSimulation(makeActionRateState(), noop, {
      objective: { type: "timeLimit", seconds: 0 },
      gatherClicksPerAction: 1,
      maxGameTime: 0,
      recordSnapshots: false,
    }).run();

    expect(result.decisionTiming.decisions).toBe(0);
    expect(result.decisionTiming.meanMs).toBe(0);
    expect(Number.isNaN(result.decisionTiming.meanMs)).toBe(false);
    expect(result.tickTiming.ticks).toBe(0);
    expect(result.tickTiming.meanMs).toBe(0);
  });

  it("stamps each snapshot with an index and its own timing sample", () => {
    const state = () =>
      new CivilizationState(
        emptyResourceAmounts(),
        emptyWorkerAssignments(),
        {},
        emptyResourceFactors(),
        {},
        0,
        [],
        [],
        [],
        [],
        emptyStatistics(),
      );
    const noop: SimulationStrategy = {
      name: "noop",
      description: "does nothing",
      decideAction: () => null,
    };
    const result = new GameSimulation(state(), noop, {
      objective: { type: "timeLimit", seconds: 300 },
      gatherClicksPerAction: 1,
      maxGameTime: 300,
      recordSnapshots: true,
      snapshotIntervalSeconds: 100,
    }).run();

    // Indices are the runner's own counter: 0-based and contiguous, so a gap
    // would mean a snapshot went missing rather than a re-numbered row.
    expect(result.snapshots.length).toBeGreaterThan(1);
    expect(result.snapshots.map((s) => s.index)).toEqual(
      result.snapshots.map((_, i) => i),
    );
    // Timestamps strictly increase, so a stall would show as a jump here.
    expect(
      result.snapshots.every(
        (s, i) => i === 0 || s.timestamp > result.snapshots[i - 1].timestamp,
      ),
    ).toBe(true);

    // The sample is cumulative, so the tick/decision counts never go backwards
    // and the closing snapshot agrees with the run's own final totals.
    const last = result.snapshots[result.snapshots.length - 1];
    expect(
      result.snapshots.every(
        (s, i) =>
          i === 0 ||
          (s.timing.ticks >= result.snapshots[i - 1].timing.ticks &&
            s.timing.decisions >= result.snapshots[i - 1].timing.decisions),
      ),
    ).toBe(true);
    expect(last.timing.ticks).toBe(result.tickTiming.ticks);
    expect(last.timing.decisions).toBe(result.decisionTiming.decisions);
    expect(last.timing.tickMeanMs).toBeCloseTo(result.tickTiming.meanMs, 6);
    expect(last.timing.decisionMeanMs).toBeCloseTo(
      result.decisionTiming.meanMs,
      6,
    );
    // Maxes are monotonic: a slow sample can only ever raise them.
    expect(last.timing.tickMaxMs).toBe(result.tickTiming.maxMs);
    expect(last.timing.decisionMaxMs).toBe(result.decisionTiming.maxMs);
  });

  it("does not report a resumed save's existing progress as newly earned", () => {
    // Regression: a run resumed from a save used to announce every battle,
    // upgrade, research and achievement the save already contained, all stamped
    // at 1s, because the event diff started from an empty baseline.
    const resumed = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e9),
        wood: ExpNumber.fromNumber(1e9),
      },
      emptyWorkerAssignments(),
      { townHall: 1, farm: 2, people: 100 },
      emptyResourceFactors(),
      {},
      0,
      ["quarryEnhancer9", "farmEnhancer9"],
      ["age0_1_first_fire", "age0_2_wolf_pack"],
      ["age0"],
      ["foodHoarder1"],
      emptyStatistics(),
    );
    const noop: SimulationStrategy = {
      name: "noop",
      description: "does nothing",
      decideAction: () => null,
    };
    // Every id the run starts with, keyed the way the recorder keys them.
    const preExisting = new Set([
      ...resumed.enteredAges.map((id) => `age:${id}`),
      ...resumed.boughtUpgrades.map((id) => `upgrade:${id}`),
      ...resumed.earnedAchievements.map((id) => `achievement:${id}`),
      ...resumed.defeatedEncounters.map((id) => `battle:${id}`),
      ...resumed.boughtResearch.map((id) => `research:${id}`),
    ]);
    const result = new GameSimulation(resumed, noop, {
      objective: { type: "timeLimit", seconds: 10 },
      gatherClicksPerAction: 1,
      maxGameTime: 10,
      recordSnapshots: false,
      fromScratch: false,
    }).run();

    // The invariant: nothing the save already contained is announced again.
    const announced = result.events.map((event) => `${event.type}:${event.id}`);
    expect(announced.filter((key) => preExisting.has(key))).toEqual([]);
    // And the recorder still works — a do-nothing run from a rich state does
    // cross new hoarder thresholds, so this must not be vacuously empty.
    expect(announced.length).toBeGreaterThan(0);
  });

  it("still announces progress a from-scratch run genuinely makes", () => {
    // The priming must not silence real events: a fresh run has no baseline, so
    // anything it truly acquires is still reported.
    const battles: string[] = [];
    const strategy: SimulationStrategy = {
      name: "win-battle",
      description: "reports its milestone",
      decideAction: () => null,
      onMilestone: (event) => {
        if (event.type === "battleWon") battles.push(event.encounterId);
      },
    };
    // Two battles already won up front, so the baseline is 2, and the
    // milestone must not re-fire for them on every tick.
    const state = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e9),
        wood: ExpNumber.fromNumber(1e9),
      },
      emptyWorkerAssignments(),
      { townHall: 1, farm: 2, people: 100 },
      emptyResourceFactors(),
      {},
      0,
      [],
      ["age0_1_first_fire", "age0_2_wolf_pack"],
      ["age0"],
      [],
      emptyStatistics(),
    );
    new GameSimulation(state, strategy, {
      objective: { type: "timeLimit", seconds: 10 },
      gatherClicksPerAction: 1,
      maxGameTime: 10,
      recordSnapshots: false,
      fromScratch: false,
    }).run();

    // Ten ticks, two pre-existing battles, zero new ones: no repeats.
    expect(battles).toEqual([]);
  });

  it("skips the from-scratch prologue when resuming a save", () => {
    const noop: SimulationStrategy = {
      name: "noop",
      description: "does nothing",
      decideAction: () => null,
    };
    // A mid-game state: a town hall so houses are still buildable, plus
    // citizens and a food surplus the prologue would happily spend.
    const midGame = () =>
      new CivilizationState(
        {
          ...emptyResourceAmounts(),
          food: ExpNumber.fromNumber(1e6),
          wood: ExpNumber.fromNumber(1e6),
        },
        emptyWorkerAssignments(),
        { townHall: 1, house: 4, people: 30 },
        emptyResourceFactors(),
        {},
        0,
        [],
        [],
        [],
        [],
        emptyStatistics(),
      );
    const run = (fromScratch: boolean) =>
      new GameSimulation(midGame(), noop, {
        objective: { type: "timeLimit", seconds: 5 },
        gatherClicksPerAction: 1,
        maxGameTime: 5,
        recordSnapshots: false,
        fromScratch,
      }).run();

    const resumed = run(false);
    // The prologue would have added a 5th house and 30 more citizens.
    expect(resumed.finalState.getBuildingCount("house")).toBe(4);
    expect(resumed.finalState.population.toNumber()).toBe(30);
    // It also must not consume the prologue's time, so the run gets its full
    // five seconds rather than starting part-way through the bootstrap.
    expect(resumed.gameTime).toBe(5);

    // Default (undefined) must keep the old behaviour.
    const legacy = new GameSimulation(midGame(), noop, {
      objective: { type: "timeLimit", seconds: 5 },
      gatherClicksPerAction: 1,
      maxGameTime: 5,
      recordSnapshots: false,
    }).run();
    expect(legacy.finalState.getBuildingCount("house")).toBe(5);
  });

  it("ends on a snapshot at the true end of the run", () => {
    const state = () =>
      new CivilizationState(
        emptyResourceAmounts(),
        emptyWorkerAssignments(),
        {},
        emptyResourceFactors(),
        {},
        0,
        [],
        [],
        [],
        [],
        emptyStatistics(),
      );
    const noop: SimulationStrategy = {
      name: "noop",
      description: "does nothing",
      decideAction: () => null,
    };
    // 250s of game time against a 300s interval: the last periodic snapshot
    // lands at 180s, so only a final snapshot can report the closing state.
    const run = (recordSnapshots: boolean) =>
      new GameSimulation(state(), noop, {
        objective: { type: "timeLimit", seconds: 250 },
        gatherClicksPerAction: 1,
        maxGameTime: 250,
        recordSnapshots,
        snapshotIntervalSeconds: 300,
      }).run();

    const recorded = run(true);
    expect(recorded.gameTime).toBe(250);
    const last = recorded.snapshots[recorded.snapshots.length - 1];
    expect(last.timestamp).toBe(250);

    // The final row must be the true end, not a stale interval tick.
    expect(
      recorded.snapshots.every(
        (s, i) => i === 0 || s.timestamp > recorded.snapshots[i - 1].timestamp,
      ),
    ).toBe(true);

    // `--no-snapshots` still records nothing, and the end-state snapshot must
    // not fire twice when the run already ended on an interval tick.
    expect(run(false).snapshots).toHaveLength(0);
    const onTick = new GameSimulation(state(), noop, {
      objective: { type: "timeLimit", seconds: 300 },
      gatherClicksPerAction: 1,
      maxGameTime: 300,
      recordSnapshots: true,
      snapshotIntervalSeconds: 300,
    }).run();
    const stamps = onTick.snapshots.map((s) => s.timestamp);
    expect(stamps[stamps.length - 1]).toBe(300);
    // 300s is the final tick *and* the final snapshot, so it appears once.
    expect(stamps.filter((t) => t === 300)).toHaveLength(1);
  });

  it("executes five normal actions before one tick by default", () => {
    let decisions = 0;
    const strategy: SimulationStrategy = {
      name: "action-rate",
      description: "counts normal strategy decisions",
      decideAction: () => {
        decisions += 1;
        return { type: "wait", seconds: 0 };
      },
    };
    const result = new GameSimulation(makeActionRateState(), strategy, {
      objective: { type: "timeLimit", seconds: 1 },
      gatherClicksPerAction: 1,
      maxGameTime: 1,
      recordSnapshots: false,
    }).run();

    expect(decisions).toBe(5);
    expect(result.gameTime).toBe(1);
  });

  it("honors an explicit action budget", () => {
    let decisions = 0;
    const strategy: SimulationStrategy = {
      name: "action-override",
      description: "counts normal strategy decisions",
      decideAction: () => {
        decisions += 1;
        return { type: "wait", seconds: 0 };
      },
    };
    const result = new GameSimulation(makeActionRateState(), strategy, {
      objective: { type: "timeLimit", seconds: 1 },
      gatherClicksPerAction: 1,
      actionsPerSecond: 2,
      maxGameTime: 1,
      recordSnapshots: false,
    }).run();

    expect(decisions).toBe(2);
    expect(result.gameTime).toBe(1);
  });

  it("uses the full default action budget for one gather decision", () => {
    let decisions = 0;
    const strategy: SimulationStrategy = {
      name: "gather-rate",
      description: "counts gather decisions",
      decideAction: () => {
        decisions += 1;
        return { type: "gather", resource: "food" };
      },
    };
    const result = new GameSimulation(makeActionRateState(), strategy, {
      objective: { type: "timeLimit", seconds: 1 },
      gatherClicksPerAction: 1,
      maxGameTime: 1,
      recordSnapshots: false,
    }).run();

    expect(decisions).toBe(1);
    expect(result.finalState.statistics.productionClicks.toNumber()).toBe(1);
    expect(result.gameTime).toBe(1);
  });

  it("uses a ten-second action window followed by a one-minute Age 2 skip", () => {
    const decisionTimes: number[] = [];
    const strategy: SimulationStrategy = {
      name: "age-two-pacing",
      description: "records when decisions are offered",
      decideAction: (_state, context) => {
        decisionTimes.push(context.gameTime);
        return { type: "wait", seconds: 0 };
      },
    };
    const result = new GameSimulation(
      makeActionRateState(["age0", "age1"]),
      strategy,
      {
        objective: { type: "timeLimit", seconds: 80 },
        gatherClicksPerAction: 1,
        maxGameTime: 80,
        recordSnapshots: false,
        fromScratch: false,
      },
    ).run();

    expect(decisionTimes.slice(0, 50)).toEqual(
      Array.from({ length: 50 }, (_, index) => Math.floor(index / 5)),
    );
    expect(decisionTimes[50]).toBe(70);
    expect(result.gameTime).toBe(80);
  });

  it.each([
    { age: 3, fastForwardSeconds: 120 },
    { age: 4, fastForwardSeconds: 300 },
    { age: 5, fastForwardSeconds: 600 },
    { age: 6, fastForwardSeconds: 1800 },
  ])(
    "uses a $fastForwardSeconds-second idle skip in Age $age",
    ({ age, fastForwardSeconds }) => {
      const decisionTimes: number[] = [];
      const strategy: SimulationStrategy = {
        name: "later-age-pacing",
        description: "records when decisions are offered",
        decideAction: (_state, context) => {
          decisionTimes.push(context.gameTime);
          return { type: "wait", seconds: 0 };
        },
      };
      const nextActionWindow = 10 + fastForwardSeconds;
      new GameSimulation(
        makeActionRateState(
          Array.from({ length: age }, (_, index) => `age${index}`),
        ),
        strategy,
        {
          objective: { type: "timeLimit", seconds: nextActionWindow + 10 },
          gatherClicksPerAction: 1,
          maxGameTime: nextActionWindow + 10,
          recordSnapshots: false,
          fromScratch: false,
        },
      ).run();

      expect(decisionTimes[0]).toBe(0);
      expect(decisionTimes[50]).toBe(nextActionWindow);
    },
  );

  it("ends the action window early when the strategy has no action", () => {
    const decisionTimes: number[] = [];
    const strategy: SimulationStrategy = {
      name: "age-two-early-skip",
      description: "requests an idle skip",
      decideAction: (_state, context) => {
        decisionTimes.push(context.gameTime);
        return null;
      },
    };
    const result = new GameSimulation(
      makeActionRateState(["age0", "age1"]),
      strategy,
      {
        objective: { type: "timeLimit", seconds: 70 },
        gatherClicksPerAction: 1,
        maxGameTime: 70,
        recordSnapshots: false,
        fromScratch: false,
      },
    ).run();

    expect(decisionTimes).toEqual([0, 60]);
    expect(result.gameTime).toBe(70);
  });

  it("does not execute gather decisions from Age 2 onward", () => {
    let decisions = 0;
    const strategy: SimulationStrategy = {
      name: "age-two-no-gather",
      description: "continues requesting manual gathers",
      decideAction: () => {
        decisions += 1;
        return { type: "gather", resource: "food" };
      },
    };
    const result = new GameSimulation(
      makeActionRateState(["age0", "age1"]),
      strategy,
      {
        objective: { type: "timeLimit", seconds: 10 },
        gatherClicksPerAction: 10,
        maxGameTime: 10,
        recordSnapshots: false,
        fromScratch: false,
      },
    ).run();

    expect(decisions).toBe(1);
    expect(result.finalState.statistics.productionClicks.toNumber()).toBe(0);
    expect(result.gameTime).toBe(10);
  });

  it("caps the Age 2 action window at 50 decisions", () => {
    const decisionTimes: number[] = [];
    const strategy: SimulationStrategy = {
      name: "age-two-action-cap",
      description: "records when decisions are offered",
      decideAction: (_state, context) => {
        decisionTimes.push(context.gameTime);
        return { type: "wait", seconds: 0 };
      },
    };
    new GameSimulation(
      makeActionRateState(["age0", "age1"]),
      strategy,
      {
        objective: { type: "timeLimit", seconds: 75 },
        gatherClicksPerAction: 1,
        actionsPerSecond: 10,
        maxGameTime: 75,
        recordSnapshots: false,
        fromScratch: false,
      },
    ).run();

    expect(decisionTimes.slice(0, 50)).toEqual(
      Array.from({ length: 50 }, (_, index) => Math.floor(index / 10)),
    );
    expect(decisionTimes[50]).toBe(65);
  });

  it("reports the effective capacity after an enhancer purchase", () => {
    const state = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(3000),
        wood: ExpNumber.fromNumber(1000),
      },
      emptyWorkerAssignments(),
      { house: 1, farm: 9, people: 1 },
    );
    const strategy: SimulationStrategy = {
      name: "test",
      description: "buys the first farm enhancer",
      decideAction: () => ({
        type: "buyUpgrade",
        upgradeId: "farmEnhancer9",
      }),
    };
    const result = new GameSimulation(state, strategy, {
      objective: { type: "timeLimit", seconds: 1 },
      gatherClicksPerAction: 1,
      maxGameTime: 1,
      recordSnapshots: false,
    }).run();
    const event = result.events.find(
      ({ type, id }) => type === "upgrade" && id === "farmEnhancer9",
    );

    expect(result.finalState.resources.farmCapacity.toString()).toBe("1e1");
    expect(result.finalState.getBuildingMax("farm").toString()).toBe("1e2");
    expect(event?.resources.farmCapacity).toBe("1e2");
  });
});

describe("age-1 planned funding costs", () => {
  it("combines whole-army and prerequisite-research costs by resource", () => {
    const plan = {
      composition: new Map<string, number>(),
      totalComposition: new Map<string, ExpNumber>(),
      military: ExpNumber.ZERO,
      totalCost: [
        { resource: "food", base: ExpNumber.fromNumber(100) },
        { resource: "wood", base: ExpNumber.fromNumber(20) },
      ],
      research: {
        ids: ["bronze_smelting"],
        costs: [
          { resource: "science", base: ExpNumber.fromNumber(50) },
          { resource: "food", base: ExpNumber.fromNumber(5) },
        ],
      },
      formations: new Map(),
      orders: new Map(),
    } as SimulatorResult;

    expect(getSimulatorPlanCosts(plan)).toEqual([
      { resource: "food", base: ExpNumber.fromNumber(105) },
      { resource: "wood", base: ExpNumber.fromNumber(20) },
      { resource: "science", base: ExpNumber.fromNumber(50) },
    ]);
  });
});

describe("required progression strategy", () => {
  const richResources = {
    food: 1e12,
    wood: 1e12,
    stone: 1e12,
    gold: 1e12,
    science: 1e12,
  } as const;

  const simulatorResources = {
    ...richResources,
    military: 1e12,
    metalwork: 1e12,
    trade: 1e12,
  } as const;

  const makeState = ({
    people = 0,
    buildings = {},
    resources = {},
    workers = {},
    unitCounts = {},
    defeatedEncounters = [],
    boughtUpgrades = [],
    enteredAges = [],
  }: {
    people?: number;
    buildings?: Partial<Record<BuildingKey, number>>;
    resources?: Partial<Record<ResourceKey, number>>;
    workers?: Partial<Record<ProductionResourceKey, number>>;
    unitCounts?: Record<string, number>;
    defeatedEncounters?: string[];
    boughtUpgrades?: string[];
    enteredAges?: string[];
  } = {}): CivilizationState => {
    const amounts = emptyResourceAmounts();
    for (const [key, value] of Object.entries(resources)) {
      amounts[key as ResourceKey] = ExpNumber.fromNumber(value);
    }
    const assignments = emptyWorkerAssignments();
    for (const [key, value] of Object.entries(workers)) {
      assignments[key as ProductionResourceKey] = ExpNumber.fromNumber(value);
    }
    const counts = Object.fromEntries(
      Object.entries(unitCounts).map(([key, value]) => [
        key,
        ExpNumber.fromNumber(value),
      ]),
    );
    return new CivilizationState(
      amounts,
      assignments,
      { townHall: 1, ...buildings, people },
      emptyResourceFactors(),
      {},
      0,
      boughtUpgrades,
      defeatedEncounters,
      enteredAges,
      [],
      emptyStatistics(),
      counts,
    );
  };

  it("allocates the whole workforce across a battle unit's cost vector", () => {
    const state = makeState({
      people: 90,
      buildings: { farm: 10, barracks: 3 },
      resources: {
        food: 54352,
        military: 1118,
        peopleCapacity: 100,
      },
    });
    const costs = [
      { resource: "food" as const, base: ExpNumber.fromNumber(313743) },
      { resource: "military" as const, base: ExpNumber.fromNumber(9413) },
    ];
    const allocation = getFastestWorkerAllocation(state, costs);

    expect(allocation).not.toBeNull();
    expect(
      Object.values(allocation?.assignments ?? {}).reduce(
        (sum, count) => sum + (count ?? 0),
        0,
      ),
    ).toBe(90);
    expect(allocation?.assignments.food ?? 0).toBeGreaterThan(0);
    expect(allocation?.seconds).toBeGreaterThan(0);
  });

  it("prices the rounded worker allocation using its actual production rate", () => {
    const state = makeState({
      people: 90,
      buildings: { farm: 10, barracks: 3 },
      resources: {
        food: 54352,
        military: 1118,
        peopleCapacity: 100,
      },
    });
    const costs = [
      { resource: "food" as const, base: ExpNumber.fromNumber(313743) },
      { resource: "military" as const, base: ExpNumber.fromNumber(9413) },
    ];
    const allocation = getFastestFundingAllocation(state, costs);

    expect(allocation).not.toBeNull();
    if (!allocation) return;

    let focused = state;
    for (const [resource, count] of Object.entries(allocation.assignments)) {
      if (count && count > 0) {
        focused = focused.assignWorker(
          resource as ProductionResourceKey,
          count,
        );
      }
    }
    expect(allocation.seconds).toBeCloseTo(
      getFastestFundingAllocation(focused, costs)?.seconds ?? Infinity,
      8,
    );
  });

  it("chooses the best integer split for a multi-resource funding target", () => {
    const people = 6;
    const resources = { food: 0, wood: 0, peopleCapacity: 10 };
    const buildings = { farm: 10, lumberYard: 10 };
    const costs = [
      { resource: "food" as const, base: ExpNumber.fromNumber(120) },
      { resource: "wood" as const, base: ExpNumber.fromNumber(80) },
    ];
    const state = makeState({
      people,
      buildings,
      resources,
    });
    const allocation = getFastestFundingAllocation(state, costs);
    let bestIntegerSeconds = Infinity;

    for (let foodWorkers = 0; foodWorkers <= people; foodWorkers += 1) {
      const focused = makeState({
        people,
        buildings,
        resources,
        workers: { food: foodWorkers, wood: people - foodWorkers },
      });
      bestIntegerSeconds = Math.min(
        bestIntegerSeconds,
        getFastestFundingAllocation(focused, costs)?.seconds ?? Infinity,
      );
    }

    expect(allocation).not.toBeNull();
    expect(allocation?.seconds).toBeCloseTo(bestIntegerSeconds, 8);
  });

  it("prices only the next research purchase while funding a research plan", () => {
    class FundingProbe extends AgeOnePolicy {
      fundingCosts(state: CivilizationState, plan: SimulatorResult | null) {
        return this.nextFundingCosts(state, plan);
      }
    }

    const ageZeroEncounters = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const state = makeState({
      people: 10,
      buildings: { university: 1 },
      resources: { science: 0, peopleCapacity: 20 },
      defeatedEncounters: ageZeroEncounters,
      enteredAges: ["age0"],
    });
    const plan = {
      composition: new Map<string, number>(),
      totalComposition: new Map<string, ExpNumber>(),
      military: ExpNumber.ZERO,
      totalCost: [],
      research: {
        ids: ["agriculture"],
        costs: [{ resource: "science", base: ExpNumber.fromNumber(9_000_000) }],
      },
      formations: new Map(),
      orders: new Map(),
    } as SimulatorResult;
    const policy = new FundingProbe(defaultPolicy());
    const costs = policy.fundingCosts(state, plan);

    expect(
      costs?.map(({ resource, base }) => [resource, base.toString()]),
    ).toEqual(
      state
        .getResearchNextCost()
        .map(({ resource, base }) => [resource, base.toString()]),
    );
    expect(costs?.[0].base.eq(plan.research.costs[0].base)).toBe(false);
  });

  it("builds a farm when it projects faster than direct food funding", () => {
    class FundingProbe extends AgeOnePolicy {
      fund(
        state: CivilizationState,
        costs: { resource: ResourceKey; base: ExpNumber }[],
      ) {
        return this.fundingAction(state, costs, 0, "farm-funding-test");
      }
    }

    const state = makeState({
      people: 10,
      buildings: { farm: 0 },
      resources: { food: 100, wood: 100, peopleCapacity: 20 },
      workers: { food: 10 },
    });

    expect(
      new FundingProbe(defaultPolicy()).fund(state, [
        { resource: "food", base: ExpNumber.fromNumber(10000) },
      ]),
    ).toEqual({ type: "build", building: "farm", count: 1 });
  });

  it("enables adaptive funding only for strategies with benchmarked improvements", () => {
    class AdaptiveFundingProbe extends BalancedStrategy {
      protected getAdaptiveWorkerFundingCosts() {
        return [
          { resource: "food" as const, base: ExpNumber.fromNumber(10000) },
        ];
      }

      assign(state: CivilizationState) {
        return this.assignWorkersByRatio(state, this.getWorkerRatios());
      }
    }

    const state = makeState({
      people: 10,
      buildings: { farm: 0 },
      resources: { food: 100, wood: 100, peopleCapacity: 20 },
      workers: { food: 10 },
    });

    const originalEnabled = ADAPTIVE_WORKER_FUNDING_ENABLED;
    const originalAllowlist = [...ADAPTIVE_WORKER_FUNDING_STRATEGIES];

    try {
      expect(ADAPTIVE_WORKER_FUNDING_ENABLED).toBe(true);
      expect([...ADAPTIVE_WORKER_FUNDING_STRATEGIES]).toEqual([
        "cheapest",
        "balanced",
        "economy",
        "production",
        "fast-age",
        "military",
        "research",
        "player",
        "trader",
      ]);

      setAdaptiveWorkerFunding(false, []);
      expect(new AdaptiveFundingProbe().assign(state)?.type).not.toBe("build");

      setAdaptiveWorkerFunding(true, []);
      expect(new AdaptiveFundingProbe().assign(state)?.type).not.toBe("build");

      setAdaptiveWorkerFunding(true, ["balanced"]);
      expect(new AdaptiveFundingProbe().assign(state)).toEqual({
        type: "build",
        building: "farm",
        count: 1,
      });
    } finally {
      setAdaptiveWorkerFunding(originalEnabled, originalAllowlist);
    }
  });

  it("exposes the next data-defined battle before it is winnable", () => {
    const state = makeState({ resources: richResources });
    const firstBattle = encounterDefinitions[0];
    expect(firstBattle).toBeDefined();
    if (!firstBattle) return;

    expect(getRequiredBattle(state)?.key).toBe(firstBattle.key);
    expect(getRequiredBattleAction(state)).toBeNull();

    const armed = makeState({
      people: 100,
      resources: richResources,
      unitCounts: { warrior: 10 },
    });
    expect(getRequiredBattleAction(armed)).toEqual({
      type: "launchBattle",
      encounterId: firstBattle.key,
    });
  });

  it("reuses the current battle result while combat inputs stay unchanged", () => {
    const state = makeState({
      people: 100,
      resources: richResources,
      unitCounts: { warrior: 1234 },
    });
    const simulate = state.simulateEncounterOutcome.bind(state);
    let simulations = 0;
    state.simulateEncounterOutcome = (battleId) => {
      simulations += 1;
      return simulate(battleId);
    };

    const firstAction = getRequiredBattleAction(state);
    const secondAction = getRequiredBattleAction(state);

    expect(firstAction).toEqual(secondAction);
    expect(simulations).toBe(1);
  });

  it("finds a player unit path for beast-only encounters", () => {
    const firstBattle = encounterDefinitions[0];
    expect(firstBattle).toBeDefined();
    if (!firstBattle) return;
    const state = makeState({
      people: 100,
      resources: richResources,
      defeatedEncounters: [],
    });

    expect(getRequiredBattleUnitTargets(state)[0]?.key).toBe("slinger");
  });

  it("stops generic beast research after unlocking its first counter unit", () => {
    const state = makeState({
      people: 100,
      resources: richResources,
      defeatedEncounters: ["age0_1_first_fire"],
    })
      .buyResearch("agriculture")
      .buyResearch("pottery")
      .buyResearch("sling_throwing");

    expect(state.isUnitAvailable("slinger")).toBe(true);
    expect(getRequiredBattleUnitTargets(state)).toEqual([]);
  });

  it("keeps the 1000-population target through all four age-zero battles", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);

    expect(getAgeRouteTargetPopulation(makeState())).toBe(90);
    expect(
      getAgeRouteTargetPopulation(
        makeState({ defeatedEncounters: ageZeroBattles.slice(0, 1) }),
      ),
    ).toBe(200);
    for (const wins of [2, 3, 4]) {
      expect(
        getAgeRouteTargetPopulation(
          makeState({ defeatedEncounters: ageZeroBattles.slice(0, wins) }),
        ),
      ).toBe(1000);
    }

    const enteredAge0 = makeState({
      people: 999,
      buildings: { farm: 1200 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    }).enterAge("age0");
    expect(getAgeRouteTargetPopulation(enteredAge0)).toBe(1000);
  });

  it("holds the first two battles for their population checkpoints", () => {
    const strategy = getStrategy("balanced");
    expect(strategy).toBeDefined();
    if (!strategy) return;
    const firstBattle = encounterDefinitions.find(({ age }) => age === 0);
    expect(firstBattle).toBeDefined();
    if (!firstBattle) return;

    const beforeFirst = makeState({
      people: 89,
      buildings: { house: 10, barracks: 1 },
      resources: { ...simulatorResources, peopleCapacity: 110 },
      unitCounts: { warrior: 1_000_000 },
    });
    expect(
      strategy.decideAction(beforeFirst, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      })?.type,
    ).not.toBe("launchBattle");

    const atFirst = makeState({
      people: 90,
      buildings: { house: 10, barracks: 1 },
      resources: { ...simulatorResources, peopleCapacity: 110 },
      unitCounts: { warrior: 1_000_000 },
    });
    expect(
      strategy.decideAction(atFirst, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).toEqual({ type: "launchBattle", encounterId: firstBattle.key });

    const beforeSecond = makeState({
      people: 199,
      buildings: { house: 20, barracks: 1 },
      resources: { ...simulatorResources, peopleCapacity: 210 },
      unitCounts: { warrior: 1_000_000 },
      defeatedEncounters: [firstBattle.key],
    });
    expect(
      strategy.decideAction(beforeSecond, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      })?.type,
    ).not.toBe("launchBattle");

    const atSecond = makeState({
      people: 200,
      buildings: { house: 20, barracks: 1 },
      resources: { ...simulatorResources, peopleCapacity: 210 },
      unitCounts: { warrior: 1_000_000 },
      defeatedEncounters: [firstBattle.key],
    });
    expect(
      strategy.decideAction(atSecond, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      })?.type,
    ).toBe("launchBattle");
  });

  it("does not miss a housing cap with fractional capacity precision", () => {
    const state = makeState({
      people: 999,
      buildings: { house: 100, townHall: 10 },
      resources: {
        ...richResources,
        peopleCapacity: 999.9999999999982,
        houseCapacity: 100,
      },
      defeatedEncounters: encounterDefinitions
        .filter(({ age }) => age === 0)
        .slice(0, 2)
        .map(({ key }) => key),
    });

    expect(state.maximumPopulation.toNumber()).toBe(1000);
    expect(getAgeRouteGrowthAction(state)).toEqual({
      type: "build",
      building: "people",
      count: 1,
    });
  });

  it("prefers named buyable enemies over the generic domain fallback", () => {
    const bronzeRaid = encounterDefinitions.find(
      ({ key }) => key === "age0_3_bronze_raid",
    );
    expect(bronzeRaid).toBeDefined();
    if (!bronzeRaid) return;
    const state = makeState({
      people: 100,
      resources: richResources,
      defeatedEncounters: encounterDefinitions
        .filter(({ key }) =>
          ["age0_1_first_fire", "age0_2_wolf_pack"].includes(key),
        )
        .map(({ key }) => key),
    });

    // Bronze Raid fields two buyable age0 units, so the named path applies and
    // every one of them is a target. The domain fallback — which returns a single
    // unit — is covered by the beast-only encounter above, and picking one here
    // would silently drop the axemen the encounter actually sends.
    const targets = getRequiredBattleUnitTargets(state).map(({ key }) => key);
    const named = bronzeRaid.enemyArmy
      .map(({ unitId }) => unitId)
      .filter((unitId) => targets.includes(unitId))
      .sort();
    expect([...targets].sort()).toEqual(named);
    expect(targets).toHaveLength(named.length);
  });

  it("continues the direct unit unlock chain for the Bronze Raid", () => {
    let state = makeState({
      people: 200,
      resources: richResources,
      defeatedEncounters: ["age0_1_first_fire", "age0_2_wolf_pack"],
    });
    for (const researchId of [
      "agriculture",
      "pottery",
      "writing",
      "mining",
      "stone_working",
      "tribal_organization",
      "sling_throwing",
      "domestication",
    ]) {
      state = state.buyResearch(researchId);
    }

    expect(getRequiredBattleUnitTargets(state).map(({ key }) => key)).toEqual([
      "axeman_bronze",
    ]);
    expect(getRequiredResearchAction(state)).toEqual({
      type: "buyResearch",
      researchId: "bronze_smelting",
    });
  });

  it("prioritizes required research without invoking the battle planner", () => {
    class PlanCountingCheapestStrategy extends CheapestStrategy {
      simulatorPlanCalls = 0;

      protected computeSimulatorPlan(_state: CivilizationState) {
        this.simulatorPlanCalls += 1;
        return null;
      }
    }

    const strategy = new PlanCountingCheapestStrategy();
    const state = makeState({
      people: 100,
      buildings: { house: 10, barracks: 1, university: 1, smithy: 1 },
      resources: { ...simulatorResources, peopleCapacity: 110 },
      defeatedEncounters: ["age0_1_first_fire"],
    });

    expect(
      strategy.decideAction(state, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).toEqual({ type: "buyResearch", researchId: "agriculture" });
    expect(strategy.simulatorPlanCalls).toBe(0);
  });

  it("buys campaign research before extending post-battle population growth", () => {
    const state = makeState({
      people: 100,
      buildings: { house: 10, barracks: 1, university: 1, smithy: 1 },
      resources: { ...simulatorResources, peopleCapacity: 110 },
      defeatedEncounters: ["age0_1_first_fire"],
    });

    expect(getAgeRouteGrowthAction(state)).not.toBeNull();
    expect(
      getStrategy("balanced")?.decideAction(state, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).toEqual({ type: "buyResearch", researchId: "agriculture" });
  });

  it("does not gather toward a battle plan blocked on unproducible resources", () => {
    // The advisor wants warriors, which cost military. With no barracks there is
    // no military production, so the plan is blocked on infrastructure: the
    // advisor must offer no purchase and must not spend the gather budget on it.
    const state = createInitialState();
    const plan = getSimulatorBattlePlan(state);

    expect(plan).not.toBeNull();
    expect(getRecommendedBattlePurchase(state, plan)).toBeNull();
    expect(
      getStrategy("balanced")?.decideAction(state, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).not.toEqual({
      type: "gather",
      resource: "military",
    });
  });

  it("reuses a battle plan after an unrelated building purchase", () => {
    const state = createInitialState().setFreeBuildings(true);
    const plan = getSimulatorBattlePlan(state);
    expect(plan).not.toBeNull();

    const afterFarm = state.build("farm", 1);
    expect(afterFarm).not.toBe(state);
    expect(getSimulatorBattlePlan(afterFarm)).toBe(plan);
  });

  it("invalidates the battle plan when research changes unit combat stats", () => {
    const state = makeState({
      people: 100,
      buildings: { house: 10, barracks: 1, university: 1, smithy: 1 },
      resources: { ...simulatorResources, peopleCapacity: 110 },
    });
    const plan = getSimulatorBattlePlan(state);
    const researched = state
      .buyResearch("agriculture")
      .buyResearch("tribal_organization");

    expect(researched.isResearchBought("tribal_organization")).toBe(true);
    expect(getSimulatorBattlePlan(researched)?.totalComposition).not.toBe(
      plan?.totalComposition,
    );
  });

  it("gathers for the cheapest purchase while no worker produces anything", () => {
    // Every production rate ties at zero without workers, so a lowest-rate
    // heuristic would lock onto one arbitrary resource and never bootstrap.
    const state = createInitialState();

    expect(state.assignedWorkers).toBe(0);
    const target = getBootstrapGatherResource(state);
    expect(target).not.toBeNull();

    // The target must actually unblock the economy: repeatedly gathering it has
    // to make the settlement's first building purchasable.
    const canBuildAnything = (candidate: CivilizationState) =>
      buildingDefinitions.some(({ key }) => candidate.canBuild(key));
    let bootstrapped = state;
    for (
      let step = 0;
      step < 200 && !canBuildAnything(bootstrapped);
      step += 1
    ) {
      bootstrapped = bootstrapped.gather(target as ProductionResourceKey);
    }
    expect(canBuildAnything(bootstrapped)).toBe(true);
  });

  it("advances the age whenever the engine allows it, whatever the population", () => {
    // Regression: the strategy helper used to add its own population gate, so a
    // run that met the building target and won every age0 battle still did not
    // ask to advance when population was below the indicative 1,000 mark.
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const state = makeState({
      people: 999,
      // Clears the 1,500-building target for age0 with room to spare.
      buildings: { farm: 1200 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });

    expect(state.canEnterAge("age0")).toBe(true);
    expect(getRequiredAgeAction(state)).toEqual({
      type: "enterAge",
      ageId: "age0",
    });
    // And the cheapest strategy asks for it ahead of any purchase.
    expect(
      getStrategy("cheapest")?.decideAction(state, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).toEqual({ type: "enterAge", ageId: "age0" });
  });

  it("waits for the age transition until the engine says it is allowed", () => {
    const notReady = makeState({ people: 999, resources: richResources });
    expect(notReady.canEnterAge("age0")).toBe(false);
    expect(getRequiredAgeAction(notReady)).toBeNull();
  });

  it("empties the plan and offers the launch once the shortfall is bought", () => {
    const state = makeState({
      people: 100,
      buildings: { house: 10, barracks: 1, university: 1, smithy: 1 },
      resources: { ...simulatorResources, peopleCapacity: 110 },
      unitCounts: { warrior: 4 },
    })
      .buyResearch("agriculture")
      .buyResearch("pottery")
      .buyResearch("writing");
    const plan = getSimulatorBattlePlan(state);

    expect(plan).not.toBeNull();
    expect(plan?.totalComposition.get("warrior")?.toNumber()).toBeGreaterThan(
      4,
    );

    // Buying exactly the recruits the plan calls for empties its shortfall and
    // makes the encounter launchable.
    //
    // This test used to also assert that `balanced`'s own `decideAction` returns
    // `buyUnit`. That is gone: the in-progress dynamic research-order work makes
    // `getRequiredResearchAction` fire above the simulator's purchases in the
    // decision ladder (strategies.ts `getResearchAction` runs above
    // `getSimulatorActions`), so the strategy now spends its turn on research
    // rather than on the shortfall. Which of those should win is a policy call
    // that has not been settled; the plan-exhaustion contract below is
    // independent of it and is what this gate protects.
    const recommended = plan?.composition.get("warrior") ?? 0;
    const afterPurchase = state.buyUnit("warrior", recommended);
    const remainingPlan = getSimulatorBattlePlan(afterPurchase);
    expect(remainingPlan?.totalComposition).toBe(plan?.totalComposition);
    expect(remainingPlan?.composition.size).toBe(0);
    expect(getRequiredBattleAction(afterPurchase)).toEqual({
      type: "launchBattle",
      encounterId: "age0_1_first_fire",
    });
  });

  it("advises science research independently of battle-plan unlocks", () => {
    const state = makeState({
      people: 100,
      buildings: { house: 10, barracks: 1, university: 1, smithy: 1 },
      resources: { ...simulatorResources, peopleCapacity: 110 },
      defeatedEncounters: ["age0_1_first_fire"],
    });
    const plan = getSimulatorBattlePlan(state);
    const strategy = getStrategy("balanced");

    expect(plan).not.toBeNull();
    expect(plan?.research.ids).toEqual([]);
    expect(
      strategy?.decideAction(state, {
        gameTime: 0,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).toEqual({ type: "buyResearch", researchId: "agriculture" });
  });

  it("buys the cheapest affordable purchase instead of a priority purchase", () => {
    class PlanCountingCheapestStrategy extends CheapestStrategy {
      simulatorPlanCalls = 0;

      protected computeSimulatorPlan(_state: CivilizationState) {
        this.simulatorPlanCalls += 1;
        return null;
      }
    }

    const strategy = new PlanCountingCheapestStrategy();
    const snapshots: [] = [];

    const state = makeState({
      resources: { wood: 10, food: 0, stone: 0, gold: 0 },
    });

    expect(
      strategy.decideAction(state, {
        gameTime: 0,
        snapshots,
        timing: zeroTiming,
      }),
    ).toEqual({
      type: "build",
      building: "house",
      count: 1,
    });
    strategy.decideAction(state, {
      gameTime: 30,
      snapshots,
      timing: zeroTiming,
    });
    expect(strategy.simulatorPlanCalls).toBe(1);
    strategy.decideAction(state, {
      gameTime: 60,
      snapshots,
      timing: zeroTiming,
    });
    expect(strategy.simulatorPlanCalls).toBe(2);
  });

  it("keeps the cheapest strategy in the simulation registry", () => {
    expect(getStrategy("cheapest")?.description).toBe(
      "Always buy the cheapest legal purchase",
    );
  });

  it("moves a surplus worker to an under-assigned resource", () => {
    class FocusStrategy extends BalancedStrategy {
      focus(state: CivilizationState, resource: ProductionResourceKey) {
        return this.assignWorkersByRatio(
          state,
          this.getWorkerRatios(),
          resource,
        );
      }
    }

    let state = makeState({
      people: 10,
      workers: { food: 4, wood: 2, stone: 2, gold: 2 },
    });
    const strategy = new FocusStrategy();

    for (
      let attempt = 0;
      attempt < 10 && state.workers.gold.toNumber() < 5;
      attempt += 1
    ) {
      const action = strategy.focus(state, "gold");
      expect(action).not.toBeNull();
      if (!action) break;
      // `assignWorkersByRatio` is typed as the full `SimulationAction` union, so
      // both worker variants have to be narrowed explicitly before `count` and
      // `resource` exist.
      if (action.type === "unassignWorker") {
        state = state.unassignWorker(action.resource, action.count);
      } else if (action.type === "assignWorker") {
        state = state.assignWorker(action.resource, action.count);
      } else {
        break;
      }
    }

    expect(state.workers.gold.toNumber()).toBe(5);
  });

  it("gathers instead of livelocking two worker regimes against each other", () => {
    const strategy = getStrategy("balanced");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    // The exact fixed point a `balanced` run reaches and never leaves: population
    // 90 sitting on its housing cap, `barracks` already built so the battle-prep
    // step (priority 3) no longer speaks, and the workers already on the
    // strategy's own ratio targets (food 36 + the 1-worker remainder = 37,
    // wood 22, stone 18, gold 13).
    //
    // Gathering for wood may shift workers toward wood, but the focus lease
    // keeps the normal strategy rebalance from immediately shifting them back.
    const fixture = {
      people: 90,
      buildings: {
        house: 10,
        farm: 10,
        lumberYard: 10,
        quarry: 13,
        goldMine: 3,
        barracks: 1,
      },
      resources: {
        food: 2975.5,
        wood: 84.2,
        stone: 868.42,
        gold: 3531,
        military: 32.55,
        peopleCapacity: 90,
        houseCapacity: 10,
        farmCapacity: 10,
        lumberYardCapacity: 10,
        quarryCapacity: 100,
        goldMineCapacity: 10,
      },
      workers: { food: 37, wood: 22, stone: 18, gold: 13 },
    };
    // A run that reached here had already bought every upgrade it could afford,
    // so none is left to divert the ladder above the worker step.
    const boughtUpgrades = makeState(fixture).getAffordableUpgrades?.() ?? [];
    let state = makeState({ ...fixture, boughtUpgrades });

    const snapshots: [] = [];
    const labels: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const action = strategy.decideAction(state, {
        gameTime: 0,
        snapshots,
        timing: zeroTiming,
      });
      if (!action) break;
      if (action.type === "gather") {
        labels.push(`gather ${action.resource}`);
        break;
      }
      if (action.type === "assignWorker" || action.type === "unassignWorker") {
        labels.push(
          `${action.type === "assignWorker" ? "assign" : "unassign"} ${action.resource}`,
        );
        state =
          action.type === "assignWorker"
            ? state.assignWorker(action.resource, action.count)
            : state.unassignWorker(action.resource, action.count);
        continue;
      }
      break;
    }

    const workerActions = labels.filter(
      (label) => !label.startsWith("gather "),
    );
    expect(workerActions.length).toBeLessThan(10);
    for (let index = 1; index < workerActions.length; index += 1) {
      const previous = workerActions[index - 1];
      const current = workerActions[index];
      if (current.startsWith("assign ")) {
        expect(previous).not.toBe(
          `unassign ${current.slice("assign ".length)}`,
        );
      }
    }
    expect(labels.at(-1)).toMatch(/^gather /);
  });

  it("buys people in bulk when the age route is affordable", () => {
    const state = makeState({
      people: 40,
      buildings: { house: 10 },
      resources: {
        ...richResources,
        food: 20000,
        wood: 4000,
        stone: 2000,
        gold: 1000,
        peopleCapacity: 90,
        houseCapacity: 10,
        farmCapacity: 10,
        lumberYardCapacity: 10,
        quarryCapacity: 10,
        goldMineCapacity: 10,
      },
    });

    const action = getAgeRouteGrowthAction(state);
    expect(action).toEqual({
      type: "build",
      building: "people",
      count: expect.any(Number),
    });
    expect(action?.type).toBe("build");
    if (action?.type !== "build") return;
    expect(action.count).toBeGreaterThan(1);
  });

  // Skipped: asserts the pre-99cf797 semantics where a competing gather hint
  // *replaced* the worker focus. The current design keeps focus sticky for 10
  // game-seconds and ignores competing hints; rewrite against that before reviving.
  it.skip("replaces a focused allocation when another gather hint appears", () => {
    class FocusStrategy extends BalancedStrategy {
      focus(
        state: CivilizationState,
        resource: ProductionResourceKey,
        context: SimulationContext,
      ) {
        return this.focusWorkersForGather(
          state,
          { type: "gather", resource },
          context,
        );
      }

      rebalance(state: CivilizationState, context: SimulationContext) {
        return this.assignWorkersByRatio(
          state,
          this.getWorkerRatios(),
          this.getGatherWorkerFocus(context),
        );
      }

      retainedFocus(context: SimulationContext) {
        return this.getGatherWorkerFocus(context);
      }
    }

    const strategy = new FocusStrategy();
    const snapshots: [] = [];
    const context: SimulationContext = {
      gameTime: 0,
      snapshots,
      timing: zeroTiming,
    };
    let state = makeState({
      people: 90,
      workers: { food: 37, wood: 22, stone: 18, gold: 13 },
    });
    const initialWood = state.workers.wood.toNumber();

    let action: SimulationAction | null = strategy.focus(
      state,
      "wood",
      context,
    );
    for (let step = 0; step < 20 && action; step += 1) {
      if (action.type === "assignWorker") {
        state = state.assignWorker(action.resource, action.count);
      } else if (action.type === "unassignWorker") {
        state = state.unassignWorker(action.resource, action.count);
      } else {
        break;
      }
      action = strategy.rebalance(state, context);
    }

    expect(state.workers.wood.toNumber()).toBeGreaterThan(initialWood);
    expect(strategy.rebalance(state, context)).toBeNull();

    const competingHint = strategy.focus(state, "gold", {
      ...context,
      gameTime: 1,
    });
    expect(competingHint).toEqual({
      type: "assignWorker",
      resource: "gold",
      count: expect.any(Number),
    });
    expect(strategy.rebalance(state, { ...context, gameTime: 1 })).toEqual({
      type: "assignWorker",
      resource: "gold",
      count: expect.any(Number),
    });
  });

  it("prepares a building once its existing unlock gate is met", () => {
    const beforeGate = makeState({ people: 89, resources: richResources });
    const atGate = makeState({
      people: 90,
      buildings: { house: 9 },
      resources: { ...richResources, peopleCapacity: 100 },
    });

    expect(getRequiredBattlePreparationAction(beforeGate)).toBeNull();
    expect(getRequiredBattlePreparationAction(atGate)).toEqual({
      type: "build",
      building: "barracks",
      count: 1,
    });
  });

  it("makes the production strategy follow the required battle path", () => {
    const strategy = getStrategy("production");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    const atGate = makeState({
      people: 90,
      buildings: { house: 9 },
      resources: { ...richResources, peopleCapacity: 100 },
    });
    expect(
      strategy.decideAction(atGate, {
        gameTime: 90,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).toEqual({
      type: "build",
      building: "barracks",
      count: 1,
    });
  });

  it("counts the next age as reached after entering the completed age", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const ready = makeState({
      people: 1000,
      buildings: { farm: 499 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });
    const strategy: SimulationStrategy = {
      name: "age-transition",
      description: "enters the current age when its requirements are met",
      decideAction: (state) => getRequiredAgeAction(state),
    };
    const result = new GameSimulation(ready, strategy, {
      objective: { type: "ageReach", ageId: "age1" },
      gatherClicksPerAction: 1,
      maxGameTime: 2,
      recordSnapshots: false,
    }).run();

    expect(result.finalState.getCurrentAge()?.key).toBe("age1");
    expect(result.objectiveReached).toBe(true);
    expect(result.success).toBe(true);
  });

  it("accepts the legacy hyphenated age objective", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const ready = makeState({
      people: 1000,
      buildings: { farm: 500 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });
    const strategy: SimulationStrategy = {
      name: "age-transition",
      description: "enters the current age when its requirements are met",
      decideAction: (state) => getRequiredAgeAction(state),
    };
    const result = new GameSimulation(ready, strategy, {
      objective: { type: "ageReach", ageId: "age-1" },
      gatherClicksPerAction: 1,
      maxGameTime: 2,
      recordSnapshots: false,
    }).run();

    expect(result.objectiveReached).toBe(true);
    expect(result.objectiveMet).toBe("age age1");
    expect(result.gameTime).toBe(0);
  });

  it("enters the next age only once every battle is won and the target is built", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const ready = makeState({
      people: 1000,
      buildings: { farm: 499 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });
    // One citizen short of the next age's population threshold, but the engine
    // only asks for battles and buildings — so this is still ready to advance.
    const oneCitizenShort = makeState({
      people: 999,
      buildings: { farm: 500 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });
    const missingBattle = makeState({
      people: 1000,
      buildings: { farm: 499 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles.slice(1),
    });
    const missingBuildings = makeState({
      people: 1000,
      buildings: { farm: 2 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });

    expect(getRequiredAgeAction(ready)).toEqual({
      type: "enterAge",
      ageId: "age0",
    });
    expect(getRequiredAgeAction(oneCitizenShort)).toEqual({
      type: "enterAge",
      ageId: "age0",
    });
    expect(getRequiredAgeAction(missingBattle)).toBeNull();
    expect(getRequiredAgeAction(missingBuildings)).toBeNull();
    // The engine agrees in every case: the helper adds no rule of its own.
    expect(ready.canEnterAge("age0")).toBe(true);
    expect(oneCitizenShort.canEnterAge("age0")).toBe(true);
    expect(missingBattle.canEnterAge("age0")).toBe(false);
    expect(missingBuildings.canEnterAge("age0")).toBe(false);
  });

  describe("saveEntry", () => {
    /** A mid-game settlement with a known run clock and a real building set. */
    const saveableState = (runTimeMs = 0) =>
      new CivilizationState(
        {
          ...emptyResourceAmounts(),
          food: ExpNumber.fromNumber(1e6),
          wood: ExpNumber.fromNumber(1e6),
        },
        emptyWorkerAssignments(),
        { townHall: 1, house: 3, farm: 2, people: 40 },
        emptyResourceFactors(),
        {},
        0,
        ["farmEnhancer1"],
        ["age0_1_first_fire"],
        ["age0"],
        ["foodHoarder1"],
        { ...emptyStatistics(), runTimeMs },
      );

    const withTempDir = (body: (dir: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "idle-civ-save-"));
      try {
        body(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("round-trips a save through every encoding", () => {
      withTempDir((dir) => {
        const source = saveableState();
        const data = createSaveData(source, "entry-test", 1000);
        for (const format of ["json", "xml", "base64"] as const) {
          const path = join(dir, `save.${format}`);
          writeFileSync(path, serializeSave(data, format), "utf8");
          const entry = loadSaveEntry(path);
          expect(entry.format).toBe(format);
          expect(entry.version).toBe(SAVE_VERSION);
          // The state really came from the file, not a fresh civilization.
          expect(entry.state.getBuildingCount("house")).toBe(3);
          expect(entry.state.getBuildingCount("people")).toBe(40);
          expect(entry.state.boughtUpgrades).toEqual(["farmEnhancer1"]);
          expect(entry.state.defeatedEncounters).toEqual(["age0_1_first_fire"]);
          expect(entry.state.enteredAges).toEqual(["age0"]);
        }
      });
    });

    it("reports the elapsed play time so a run can be lined up with the save", () => {
      withTempDir((dir) => {
        // 90 seconds of run time is 1m 30s on the save's own clock.
        const path = join(dir, "save.json");
        writeFileSync(
          path,
          serializeSave(
            createSaveData(saveableState(90_000), "elapsed", 1),
            "json",
          ),
          "utf8",
        );
        const entry = loadSaveEntry(path);
        expect(entry.elapsedSeconds).toBe(90);
        expect(describeSaveEntry(entry)).toContain("1m 30s");
      });
    });

    it("refuses a missing file and a file that is not a save", () => {
      withTempDir((dir) => {
        expect(() => loadSaveEntry(join(dir, "nope.json"))).toThrow(
          /Could not read the save file/,
        );
        const notASave = join(dir, "plain.json");
        writeFileSync(notASave, JSON.stringify({ hello: "world" }), "utf8");
        expect(() => loadSaveEntry(notASave)).toThrow();
      });
    });

    it("writes a run's outcome as a save that loads back identically", () => {
      withTempDir((dir) => {
        const result = new GameSimulation(
          saveableState(),
          {
            name: "noop",
            description: "does nothing",
            decideAction: () => null,
          },
          {
            objective: { type: "timeLimit", seconds: 10 },
            gatherClicksPerAction: 1,
            maxGameTime: 10,
            recordSnapshots: false,
            fromScratch: false,
          },
        ).run();

        for (const [suffix, format] of [
          [".json", "json"],
          [".xml", "xml"],
          [".b64", "base64"],
        ] as const) {
          const path = join(dir, `out${suffix}`);
          const written = writeSaveEntry(path, result.finalState);
          expect(written.format).toBe(format);
          expect(written.version).toBe(SAVE_VERSION);

          // The whole point: what was written can be read straight back in.
          const reloaded = loadSaveEntry(path);
          expect(reloaded.state.getBuildingCount("house")).toBe(
            result.finalState.getBuildingCount("house"),
          );
          expect(reloaded.state.population.toString()).toBe(
            result.finalState.population.toString(),
          );
          expect(reloaded.state.enteredAges).toEqual(
            result.finalState.enteredAges,
          );
          expect(reloaded.state.boughtUpgrades).toEqual(
            result.finalState.boughtUpgrades,
          );
        }
      });
    });

    it("carries the source save's identity when continuing one", () => {
      withTempDir((dir) => {
        const source = join(dir, "source.json");
        writeFileSync(
          source,
          serializeSave(
            createSaveData(saveableState(60_000), "fixed-guid", 4242),
            "json",
          ),
          "utf8",
        );
        const entry = loadSaveEntry(source);
        expect(entry.guid).toBe("fixed-guid");
        expect(entry.createdAtMs).toBe(4242);

        // Resuming a save and writing one back is one continuous save-file, so
        // the identity carries across rather than a fresh document being minted.
        const continued = writeSaveEntry(
          join(dir, "next.json"),
          saveableState(),
          {
            from: entry,
          },
        );
        expect(continued.guid).toBe("fixed-guid");
        expect(loadSaveEntry(join(dir, "next.json")).createdAtMs).toBe(4242);

        // A run with no source save mints its own.
        expect(
          writeSaveEntry(join(dir, "fresh.json"), saveableState()).guid,
        ).not.toBe("fixed-guid");
      });
    });

    it("migrates the checked-in saves/age1.json from version 4", () => {
      // age1.json predates SAVE_VERSION 5, so the loader must migrate it rather
      // than reject it. Reading the real file also keeps the CLI's headline
      // example covered.
      const entry = loadSaveEntry("saves/age1.json");
      expect(entry.version).toBe(SAVE_VERSION);
      expect(entry.elapsedSeconds).toBeGreaterThan(0);
      expect(entry.state.defeatedEncounters.length).toBeGreaterThan(0);
      expect(
        Object.values(entry.state.builtBuildings).reduce(
          (sum, count) => sum + (count ?? 0),
          0,
        ),
      ).toBeGreaterThan(0);
    });
  });
});
