/**
 * Simulation engine for balance testing and strategy optimization.
 * Runs headless game simulations with configurable strategies and objectives.
 */

import { CivilizationState } from "../../src/game/civilizationState.js";
import { ExpNumber } from "../../src/game/expNumber.js";
import { findAgeDefinition } from "../../src/game/ages.js";
import {
  buildingDefinitions,
  type BuildingKey,
} from "../../src/game/buildings.js";
import { encounterDefinitions } from "../../src/game/encounters.js";
import {
  producerResourceKeys,
  type ProductionResourceKey,
  type ResourceKey,
} from "../../src/game/attributes.js";
import type { TradeResourceKey, TradeRoute } from "../../src/game/trade.js";

/** Use the engine's isResourceGatherable method. */
export const isResourceGatherable = (
  state: CivilizationState,
  key: ResourceKey,
): boolean => state.isResourceGatherable(key);

export const normalizeAgeId = (ageId: string): string => {
  const legacyAgeId = /^age-(\d+)$/.exec(ageId);
  return legacyAgeId ? `age${legacyAgeId[1]}` : ageId;
};

export const resolveAgeId = (ageId: string): string | undefined =>
  findAgeDefinition(normalizeAgeId(ageId))?.key;

/**
 * Wall-clock cost of the two hot paths, sampled at one instant.
 *
 * These are *cumulative averages since the run started*, not per-snapshot
 * deltas: a snapshot is exactly where you look to notice the simulation
 * drifting, so a `tickMeanMs` that climbs row over row means each simulated
 * second is costing more wall-clock than the last — the run is getting slower
 * as the state grows. `tickMaxMs` / `decisionMaxMs` catch the opposite
 * problem, a single pathological spike.
 */
export interface SnapshotTiming {
  /** `state.tick()` calls measured so far. */
  ticks: number;
  tickMeanMs: number;
  tickMaxMs: number;
  /** `strategy.decideAction()` calls measured so far. */
  decisions: number;
  decisionMeanMs: number;
  decisionMaxMs: number;
}

/**
 * The state fields both a snapshot and an event carry, so the two log lines can
 * share one renderer. An event is a snapshot-minus-the-runner-metadata: the
 * same population, resources, army, buildings, … captured the instant something
 * happened, without the snapshot's ordinal / timing / resourcesSpent bookkeeping.
 */
export interface SimulationStateSummary {
  age: string;
  population: number;
  resources: Record<string, string>; // ExpNumber as string for serialization
  researches: string[];
  buildings: { building: BuildingKey; count: number }[];
  units: { unit: string; count: string }[]; // ExpNumber counts as strings
  productionRates: Record<string, string>; // per-second rates
  battlesWon: number;
  totalBuildings: number;
  militaryPower?: number;
}

/**
 * Why a snapshot was taken. Periodic rows sit on the interval grid; the
 * milestone kinds (age / battle) and `final` are stamped at the exact second
 * something happened, so their `timestamp` is deliberately off-grid.
 */
export type SnapshotKind = "periodic" | "age" | "battle" | "final";

/**
 * A snapshot of game state at a milestone for analysis.
 */
export interface SimulationSnapshot extends SimulationStateSummary {
  /** What triggered this snapshot — see {@link SnapshotKind}. */
  kind: SnapshotKind;
  /** For `age` / `battle` milestones: the age or encounter id. */
  milestoneId?: string;
  /**
   * Zero-based ordinal among `periodic` snapshots only; `undefined` for
   * milestones and the closing `final` row. This is the number the runner
   * prints as "Snapshot N", and because it counts periodic rows alone it stays
   * on the interval grid no matter how many milestones interleave.
   */
  periodicIndex?: number;
  /**
   * Zero-based ordinal of this snapshot across *all* kinds, from the runner's
   * own counter rather than the array length. A gap between consecutive
   * `index` values means snapshots were skipped, and a `timestamp` that jumps
   * without one marks exactly where the run stalled.
   */
  index: number;
  /** Timing sampled at the instant this snapshot was taken. */
  timing: SnapshotTiming;
  timestamp: number; // Game time in seconds
  /** Cumulative resources spent so far, per resource id (ExpNumber as string). */
  resourcesSpent: Record<string, string>;
}

/**
 * Simulation objective types for termination conditions.
 */
export type SimulationObjective =
  | { type: "buildingCount"; building: BuildingKey; target: number }
  | { type: "ageReach"; ageId: string }
  | { type: "battleVictory"; encounterId: string }
  | { type: "timeLimit"; seconds: number };

/**
 * Simulation configuration.
 */
export interface SimulationConfig {
  objective: SimulationObjective;
  gatherClicksPerAction: number; // clicks each gather action models (default 10)
  actionsPerSecond?: number; // strategy actions per active second (default 5)
  maxGameTime: number; // maximum simulation time in seconds
  recordSnapshots: boolean;
  /**
   * An extra stop condition, checked before the configured `objective`. Lets a
   * run halt the instant an arbitrary engine-exact predicate flips — e.g. an
   * objective-plan rung's `done()` — without the simulation importing or knowing
   * anything about the plan that supplied it (which would close an import cycle).
   */
  stopWhen?: (state: CivilizationState) => boolean;
  /**
   * Manufacture the opening house and citizens before the main loop (default
   * true). Set false when the run resumes a save: the prologue exists to bootstrap
   * an empty civilization, and on a mid-game state it would build a redundant
   * house and spend the save's food on citizens the player already has.
   */
  fromScratch?: boolean;
  /**
   * Seconds between periodic snapshots (default 60). Battle wins always snapshot.
   *
   * 60 matches `DEFAULT_DEV_LOG_SNAPSHOT_SECONDS`, so a live run and a simulation
   * line up row for row on the same game-minute cadence. It was 300, which left
   * the interesting part of a battle — and the tech that unlocks the unit it
   * needed — inside a single unobserved interval.
   */
  snapshotIntervalSeconds?: number;
  verbose?: boolean; // enable debug output
  onEvent?: (event: SimulationEvent) => void;
  onSnapshot?: (snapshot: SimulationSnapshot, index: number) => void;
}

// Preserve per-second decisions through Age 1; later ages use bounded action bursts.
const laterAgePacing: Record<
  number,
  { actionWindowSeconds: number; maxActions: number; fastForwardSeconds: number }
> = {
  2: { actionWindowSeconds: 10, maxActions: 50, fastForwardSeconds: 60 },
  3: { actionWindowSeconds: 10, maxActions: 50, fastForwardSeconds: 120 },
  4: { actionWindowSeconds: 10, maxActions: 50, fastForwardSeconds: 300 },
  5: { actionWindowSeconds: 10, maxActions: 50, fastForwardSeconds: 600 },
  6: { actionWindowSeconds: 10, maxActions: 50, fastForwardSeconds: 1800 },
};

/**
 * Simulation result with milestone data.
 */
export interface SimulationResult {
  success: boolean;
  objectiveReached: boolean;
  gameTime: number; // seconds simulated
  finalState: CivilizationState;
  snapshots: SimulationSnapshot[];
  objectiveMet?: string;
  terminationReason: string;
  events: SimulationEvent[];
  finalProductionRates: Record<string, string>;
  tickTiming: TickTiming;
  decisionTiming: DecisionTiming;
}

/**
 * A timestamped record of a major progression event, logged at the game-second
 * it first occurred. Used to build the end-of-run timeline.
 */
export type SimulationEventType =
  | "age"
  | "upgrade"
  | "achievement"
  | "battle"
  | "research";

export interface SimulationEvent extends SimulationStateSummary {
  time: number; // game time in seconds
  type: SimulationEventType;
  id: string;
}

/**
 * Shared wall-clock statistics for a repeated simulation step. `totalMs` is the
 * sum over every measured call and `maxMs` the slowest single one, so `meanMs`
 * is a per-call average rather than a per-simulated-second one.
 */
export interface StepTiming {
  totalMs: number;
  meanMs: number;
  maxMs: number;
}

/**
 * Aggregated wall-clock statistics for every state.tick() call made during
 * the simulation.
 */
export interface TickTiming extends StepTiming {
  ticks: number;
}

/**
 * Aggregated wall-clock statistics for every `strategy.decideAction()` call.
 * This is the strategy's own decision cost, isolated from the engine tick, so
 * it answers "is this strategy cheap enough to simulate a long horizon" without
 * the state-tick noise.
 */
export interface DecisionTiming extends StepTiming {
  decisions: number;
}

/**
 * Fold accumulated totals into the shared shape. A zero count yields a zero
 * mean rather than NaN, so an empty run still prints cleanly.
 */
const summarizeTiming = (
  count: number,
  totalMs: number,
  maxMs: number,
): StepTiming => ({
  totalMs,
  meanMs: count === 0 ? 0 : totalMs / count,
  maxMs,
});

/**
 * Action types a strategy can request.
 */
export type SimulationAction =
  | { type: "gather"; resource: string }
  | { type: "assignWorker"; resource: ProductionResourceKey; count: number }
  | { type: "unassignWorker"; resource: ProductionResourceKey; count: number }
  | { type: "build"; building: BuildingKey; count: number }
  | { type: "buyUpgrade"; upgradeId: string }
  | { type: "buyResearch"; researchId: string }
  | { type: "buyUnit"; unitId: string; count: number }
  | { type: "launchBattle"; encounterId: string }
  | { type: "enterAge"; ageId: string }
  /** Point a market trade route at a resource. Costs nothing but an action slot. */
  | { type: "setTradeRoute"; resource: TradeResourceKey; route: TradeRoute }
  | { type: "wait"; seconds: number };

/**
 * Strategy interface for decision-making.
 */
export interface SimulationStrategy {
  name: string;
  description: string;

  /**
   * Decide next action given current state and context.
   * Returns null if no action should be taken (wait/skip phase).
   */
  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null;

  /**
   * Optional: React to milestone events (age entered, battle won).
   */
  onMilestone?(event: MilestoneEvent, state: CivilizationState): void;
}

/**
 * Context passed to strategy decision-making.
 */
export interface SimulationContext {
  gameTime: number;
  snapshots: SimulationSnapshot[];
  /**
   * Live timing as of this decision. Strategies rarely want it, but it lets a
   * capture hook stamp a row with the same figures the snapshots carry rather
   * than reaching back to the previous one.
   */
  timing: SnapshotTiming;
}

/**
 * Milestone events for strategy callbacks.
 */
export type MilestoneEvent =
  | { type: "ageEntered"; ageId: string }
  | { type: "battleWon"; encounterId: string }
  | { type: "buildingBuilt"; building: BuildingKey; count: number };

/**
 * Main simulation engine.
 */
export class GameSimulation {
  private state: CivilizationState;
  private config: SimulationConfig;
  private strategy: SimulationStrategy;
  private snapshots: SimulationSnapshot[] = [];
  private snapshotCount = 0;
  private gameTime = 0;
  private events: SimulationEvent[] = [];
  private seenEvents = new Set<string>();
  private lastMilestoneAge: string | undefined;
  private lastMilestoneBattles = 0;
  private tickCount = 0;
  private tickTotalMs = 0;
  private tickMaxMs = 0;
  /**
   * Next game time a periodic snapshot is due. This is a self-contained clock
   * (seeded at the first interval, then advanced by one interval per snapshot)
   * rather than "now minus the last snapshot's timestamp", so an off-grid
   * milestone snapshot can no longer push the periodic grid sideways. It also
   * survives `skipTime`'s batched ticks, which can step `gameTime` by up to 60
   * seconds past the due point between two `checkMilestones()` calls.
   */
  private nextPeriodicTime = 0;
  /** Count of periodic snapshots taken, for the player-facing "Snapshot N". */
  private periodicCount = 0;
  private decisionCount = 0;
  private decisionTotalMs = 0;
  private decisionMaxMs = 0;

  constructor(
    initialState: CivilizationState,
    strategy: SimulationStrategy,
    config: SimulationConfig,
  ) {
    this.state = initialState;
    this.strategy = strategy;
    this.config = config;
    this.primeBaseline();
  }

  /**
   * Seed the diff baselines from the state the run starts on.
   *
   * Both the event recorder and the milestone checks work by diffing against
   * what was already there, and both used to assume that was nothing. A run that
   * resumes a save begins with battles won, upgrades bought, research done and
   * achievements earned, so on the first tick every one of them read as *newly*
   * acquired and was reported at 1s. Reading the baseline out of the snapshot
   * list had a second flaw: with `recordSnapshots: false` there is no snapshot to
   * read, so the battle milestone re-fired on every tick forever.
   *
   * A from-scratch run is unaffected — its starting state is empty, so this
   * primes nothing.
   */
  private primeBaseline(): void {
    for (const [type, ids] of [
      ["age", this.state.enteredAges],
      ["upgrade", this.state.boughtUpgrades],
      ["achievement", this.state.earnedAchievements],
      ["battle", this.state.defeatedEncounters],
      ["research", this.state.boughtResearch],
    ] as const) {
      for (const id of ids) this.seenEvents.add(`${type}:${id}`);
    }
    // The last age actually *entered* (not merely the age the population puts
    // you in), so a fresh run still announces entering its first age.
    this.lastMilestoneAge =
      this.state.enteredAges[this.state.enteredAges.length - 1];
    this.lastMilestoneBattles = this.state.defeatedEncounters.length;
  }

  /** Log a message if verbose mode is enabled. */
  private log(...args: any[]): void {
    if (this.config.verbose) {
      console.log(...args);
    }
  }

  /**
   * Advance the simulation by one game-second, timing the domain tick and
   * diffing the state's progression id lists to build the event timeline.
   */
  private tick(): void {
    const startedAt = performance.now();
    this.state = this.state.tick();
    const elapsed = performance.now() - startedAt;

    this.tickCount += 1;
    this.tickTotalMs += elapsed;
    this.tickMaxMs = Math.max(this.tickMaxMs, elapsed);

    this.gameTime += 1;
    this.recordEvents();
    this.recordPeriodicSnapshot();
  }

  /**
   * Log any progression ids that appeared since the last call, stamped with the
   * current game time. Diffing the whole state keeps this free of per-content
   * conditionals â€” new event types only need a field on the state.
   */
  private recordEvents(): void {
    this.recordNewEvents("age", this.state.enteredAges);
    this.recordNewEvents("upgrade", this.state.boughtUpgrades);
    this.recordNewEvents("achievement", this.state.earnedAchievements);
    this.recordNewEvents("battle", this.state.defeatedEncounters);
    this.recordNewEvents("research", this.state.boughtResearch);
  }

  /**
   * The state fields both snapshots and events log, built once so the two can
   * never drift apart. This is what lets an `[EVENT]` line render exactly like a
   * `[SNAPSHOT]` line. `getArmyPower()` is the one non-trivial call here; events
   * fire on every new progression id, so this is the cost of event/snapshot
   * parity — measured, and worth it, because the alternative is two shape
   * definitions that silently diverge.
   */
  private buildStateSummary(): SimulationStateSummary {
    const currentAge = this.state.getCurrentAge();
    return {
      age: currentAge?.key || "unknown",
      population: this.state.population.toNumber(),
      resources: this.resourceSnapshot(),
      researches: [...this.state.boughtResearch],
      buildings: Object.entries(this.state.builtBuildings).map(
        ([building, count]) => ({
          building: building as BuildingKey,
          count: count ?? 0,
        }),
      ),
      units: Object.entries(this.state.unitCounts)
        .filter(([, count]) => count.gt(ExpNumber.ZERO))
        .map(([unit, count]) => ({ unit, count: count.toString() })),
      productionRates: this.computeProductionRates(),
      battlesWon: this.state.defeatedEncounters.length,
      totalBuildings: Object.values(this.state.builtBuildings).reduce(
        (sum, count) => sum + (count ?? 0),
        0,
      ),
      militaryPower: this.state.getArmyPower().toNumber(),
    };
  }

  private recordNewEvents(
    type: SimulationEventType,
    ids: readonly string[],
  ): void {
    for (const id of ids) {
      const key = `${type}:${id}`;
      if (this.seenEvents.has(key)) continue;
      this.seenEvents.add(key);
      const event: SimulationEvent = {
        ...this.buildStateSummary(),
        time: this.gameTime,
        type,
        id,
      };
      this.events.push(event);
      this.config.onEvent?.(event);
      this.log(`event ${key} at ${this.gameTime}s`);
      if (type === "achievement") {
        this.log(`*** ACHIEVEMENT UNLOCKED: ${id} at ${this.gameTime}s ***`);
      }
    }
  }

  /** Current per-second production for every production resource. */
  private computeProductionRates(): Record<string, string> {
    return Object.fromEntries(
      producerResourceKeys.map((key) => [
        key,
        this.state.computeResourceRate(key).toString(),
      ]),
    );
  }

  /**
   * Effective balances for event and milestone snapshots. Amounts come from the
   * state, while capacities go through getBuildingMax() so enhancer multipliers
   * are visible without mutating the stored capacity base.
   */
  private resourceSnapshot(): Record<string, string> {
    const buildingByCapacityKey = new Map(
      buildingDefinitions.map((building) => [
        `${building.key}Capacity`,
        building.key,
      ]),
    );
    return Object.fromEntries(
      Object.entries(this.state.resources).map(([resource, amount]) => {
        const buildingKey = buildingByCapacityKey.get(resource);
        const value = buildingKey
          ? this.state.getBuildingMax(buildingKey)
          : amount;
        return [resource, value.toString()];
      }),
    );
  }

  /**
   * The from-scratch opening: gather wood, build a house, gather food, then
   * build as many citizens as are affordable. Extracted from `run` so a run that
   * resumes a save can skip it in one line.
   */
  private bootstrapFromScratch(): void {
    this.log(
      "Initial houseCapacity:",
      this.state.resources.houseCapacity.toString(),
    );
    this.log(
      "Initial peopleCapacity:",
      this.state.resources.peopleCapacity.toString(),
    );
    this.log("Initial canBuild house?", this.state.canBuild("house"));
    this.log("Initial canBuild people?", this.state.canBuild("people"));

    // Step 1: Gather wood until we can build a house. Gathering consumes the
    // entire action budget for this simulated second.
    while (
      !this.state.canBuild("house") &&
      this.state.resources.wood.lt(ExpNumber.fromNumber(10))
    ) {
      this.executeAction({ type: "gather", resource: "wood" });
      this.tick();
    }

    this.log(
      "After wood gather - houseCapacity:",
      this.state.resources.houseCapacity.toString(),
    );
    this.log(
      "After wood gather - canBuild house?",
      this.state.canBuild("house"),
    );

    // Step 2: Build a house
    if (this.state.canBuild("house")) {
      this.state = this.state.build("house");
      this.log(
        "Built a house, houseCapacity now:",
        this.state.resources.houseCapacity.toString(),
      );
    }

    // Step 3: Gather food until we can build a person. Gathering consumes the
    // entire action budget for this simulated second.
    while (
      !this.state.canBuild("people") &&
      this.state.resources.food.lt(ExpNumber.fromNumber(10))
    ) {
      this.executeAction({ type: "gather", resource: "food" });
      this.tick();
    }

    // Step 4: Build as many people as we can afford
    if (this.state.canBuild("people")) {
      const { state: newState, count } = this.buildMaxBuilding("people");
      if (count > 0) {
        this.state = newState;
        this.log(
          `Built ${count} people, population now:`,
          this.state.population.toString(),
        );
      }
    }
  }

  /**
   * Run the full simulation to completion.
   */
  run(): SimulationResult {
    const configuredActionsPerSecond = this.config.actionsPerSecond ?? 5;
    const actionsPerSecond =
      Number.isFinite(configuredActionsPerSecond) &&
      configuredActionsPerSecond >= 1
        ? Math.floor(configuredActionsPerSecond)
        : 5;

    // Initial burst: gather wood and build a house, then gather food and build people
    // This sets up the initial population and workers. A resumed run skips it —
    // see `SimulationConfig.fromScratch`.
    if (this.config.fromScratch !== false) this.bootstrapFromScratch();

    while (this.gameTime < this.config.maxGameTime) {
      // Check objective completion
      if (this.checkObjective()) {
        return this.createResult(true, "Objective reached");
      }

      const currentAge = this.state.getCurrentAge();
      const ageIndex = currentAge
        ? Number.parseInt(currentAge.key.slice(-1), 10)
        : -1;
      const pacing = laterAgePacing[ageIndex];
      if (pacing) {
        const actionWindowEnd = this.gameTime + pacing.actionWindowSeconds;
        let decisions = 0;
        let endActionWindow = false;

        while (
          this.gameTime < actionWindowEnd &&
          decisions < pacing.maxActions &&
          this.gameTime < this.config.maxGameTime
        ) {
          let remainingActions = actionsPerSecond;
          while (remainingActions > 0 && decisions < pacing.maxActions) {
            const decidedAt = performance.now();
            const action = this.strategy.decideAction(this.state, {
              gameTime: this.gameTime,
              snapshots: this.snapshots,
              timing: this.currentTiming(),
            });
            this.recordDecisionTiming(performance.now() - decidedAt);
            decisions += 1;
            if (!action) {
              endActionWindow = true;
              break;
            }

            if (action.type === "gather") {
              endActionWindow = true;
              break;
            }

            this.executeAction(action);
            remainingActions -= 1;
            if (this.checkObjective()) {
              return this.createResult(true, "Objective reached");
            }
            if (this.gameTime >= this.config.maxGameTime) break;
          }

          if (
            this.gameTime >= this.config.maxGameTime ||
            this.gameTime >= actionWindowEnd ||
            endActionWindow
          ) {
            break;
          }
          this.tick();
          this.checkMilestones();
          if (this.checkObjective()) {
            return this.createResult(true, "Objective reached");
          }
          if (this.state.getCurrentAge()?.key !== currentAge?.key) break;
        }

        if (this.gameTime < this.config.maxGameTime) {
          const nextAgeIndex = Number.parseInt(
            this.state.getCurrentAge()?.key.slice(-1) ?? "",
            10,
          );
          this.fastForward(
            (laterAgePacing[nextAgeIndex] ?? pacing).fastForwardSeconds,
          );
        }
        continue;
      }

      // Each simulated second has an action budget. A normal action consumes
      // one slot; gather consumes every remaining slot with that gather action.
      let remainingActions = actionsPerSecond;
      while (remainingActions > 0) {
        const decidedAt = performance.now();
        const action = this.strategy.decideAction(this.state, {
          gameTime: this.gameTime,
          snapshots: this.snapshots,
          timing: this.currentTiming(),
        });
        this.recordDecisionTiming(performance.now() - decidedAt);
        if (!action) break;
        this.executeAction(action);
        remainingActions = action.type === "gather" ? 0 : remainingActions - 1;
        if (this.checkObjective()) {
          return this.createResult(true, "Objective reached");
        }
        if (this.gameTime >= this.config.maxGameTime) break;
      }

      if (this.gameTime >= this.config.maxGameTime) break;
      this.tick();
      this.checkMilestones();
    }

    return this.createResult(false, "Time limit reached");
  }

  private fastForward(seconds: number): void {
    let remaining = Math.min(
      seconds,
      this.config.maxGameTime - this.gameTime,
    );

    while (remaining > 0) {
      this.tick();
      remaining -= 1;
      if (this.gameTime % 60 === 0) this.checkMilestones();
      if (this.checkObjective()) break;
    }

    this.checkMilestones();
  }

  /**
   * Execute a simulation action. Each gather action models
   * `gatherClicksPerAction` production clicks and reports the amount gathered.
   */
  private executeAction(action: SimulationAction): void {
    switch (action.type) {
      case "gather": {
        const clicks = this.config.gatherClicksPerAction;
        const resource = action.resource as ProductionResourceKey;
        const before = this.state.resources[resource];
        let next = this.state;
        for (let i = 0; i < clicks; i++) {
          next = next.gather(resource);
        }
        this.state = next;
        const gathered = next.resources[resource].sub(before);
        this.log(
          `gather ${resource}`,
          `gathered ${gathered.toString()} (${clicks} clicks)`,
        );
        break;
      }
      case "assignWorker": {
        const assignedBefore =
          this.state.workers[action.resource]?.toString() ?? "0";
        this.state = this.state.assignWorker(action.resource, action.count);
        this.log(
          `assign ${action.count} workers to ${action.resource}`,
          `(before: ${assignedBefore}, now: ${this.state.workers[action.resource]?.toString() ?? "0"})`,
        );
        break;
      }
      case "unassignWorker": {
        const assignedBefore =
          this.state.workers[action.resource]?.toString() ?? "0";
        this.state = this.state.unassignWorker(action.resource, action.count);
        this.log(
          `unassign ${action.count} workers from ${action.resource}`,
          `(before: ${assignedBefore}, now: ${this.state.workers[action.resource]?.toString() ?? "0"})`,
        );
        break;
      }
      case "build": {
        const before = this.state.builtBuildings[action.building] || 0;
        this.state = this.buildBuilding(action.building, action.count);
        const built =
          (this.state.builtBuildings[action.building] || 0) - before;
        this.log(
          `build ${action.building}`,
          `built ${built}/${action.count} (total ${this.state.builtBuildings[action.building] || 0})`,
        );
        break;
      }
      case "buyUpgrade": {
        const before = this.state.boughtUpgrades.length;
        this.state = this.state.buyUpgrade(action.upgradeId);
        const bought = this.state.boughtUpgrades.length > before;
        this.log(
          `buyUpgrade ${action.upgradeId}`,
          bought ? "bought" : "not affordable or locked (skipped)",
        );
        break;
      }
      case "buyResearch": {
        const before = this.state.boughtResearch.length;
        this.state = this.state.buyResearch(action.researchId);
        const bought = this.state.boughtResearch.length > before;
        this.log(
          `buyResearch ${action.researchId}`,
          bought ? "bought" : "not affordable or locked (skipped)",
        );
        break;
      }
      case "buyUnit": {
        const before = this.state.getUnitCount(action.unitId);
        this.state = this.state.buyUnit(action.unitId, action.count);
        const bought = this.state.getUnitCount(action.unitId).sub(before);
        this.log(
          `buyUnit ${action.unitId}`,
          `bought ${bought.toString()}/${action.count}`,
        );
        break;
      }
      case "launchBattle": {
        const battlesBefore = this.state.defeatedEncounters.length;
        this.state = this.launchBattle(action.encounterId);
        const won = this.state.defeatedEncounters.length > battlesBefore;
        this.log(
          `battle ${action.encounterId}`,
          won ? "won" : "lost or unwinnable (skipped)",
        );
        break;
      }
      case "enterAge": {
        if (!this.state.canEnterAge(action.ageId)) {
          this.log(
            `enterAge ${action.ageId}`,
            "requirements not met (skipped)",
          );
          break;
        }
        const agesBefore = this.state.enteredAges.length;
        this.state = this.state.enterAge(action.ageId);
        const entered = this.state.enteredAges.length > agesBefore;
        this.log(
          `enterAge ${action.ageId}`,
          entered ? "entered" : "already entered (skipped)",
        );
        break;
      }
      case "setTradeRoute": {
        this.state = this.state.setTradeRoute(action.resource, action.route);
        const route = this.state.getTradeRoute(action.resource);
        this.log(
          `trade route ${action.resource}`,
          route.enabled
            ? `${route.mode} at ${route.intensity} intensity`
            : "disabled",
        );
        break;
      }
      case "wait":
        this.log(`wait ${action.seconds}s`);
        this.skipTime(action.seconds);
        break;
    }
  }

  /**
   * Skip forward in time (simulate idle production).
   * Calls tick() for each second to process production, age checks, etc.
   */
  private skipTime(seconds: number): void {
    // Batch ticks for performance - process in chunks
    const chunkSize = Math.min(seconds, 60); // Process up to 60 seconds at a time
    let remaining = seconds;

    while (remaining > 0) {
      const batch = Math.min(remaining, chunkSize);
      for (let i = 0; i < batch; i++) {
        this.tick();
      }
      remaining -= batch;

      // Check milestones after each batch
      this.checkMilestones();
    }
  }

  /**
   * Build a building (handle capacity and cost).
   */
  private buildBuilding(
    building: BuildingKey,
    count: number,
  ): CivilizationState {
    const maxAffordable = this.state.getMaxAffordableBuildings(building);
    const actualCount = Math.min(count, maxAffordable);
    if (actualCount > 0) {
      return this.state.build(building, actualCount);
    }
    return this.state;
  }

  /**
   * Build as many of a building as possible right now.
   * Returns the new state and how many were actually built.
   */
  private buildMaxBuilding(building: BuildingKey): {
    state: CivilizationState;
    count: number;
  } {
    const maxAffordable = this.state.getMaxAffordableBuildings(building);
    // Safety limit of 100 max in one go to match old logic
    const actualCount = Math.min(maxAffordable, 100);
    if (actualCount > 0) {
      return {
        state: this.state.build(building, actualCount),
        count: actualCount,
      };
    }
    return { state: this.state, count: 0 };
  }

  /**
   * Launch a battle if available and winnable.
   */
  private launchBattle(encounterId: string): CivilizationState {
    const encounter = encounterDefinitions.find(
      (e: { key: string }) => e.key === encounterId,
    );
    if (!encounter) return this.state;

    const simulation = this.state.simulateEncounter(encounterId);
    if (simulation && simulation.outcome === "player") {
      this.state = this.state.resolveBattle(encounterId, simulation);
      this.strategy.onMilestone?.(
        { type: "battleWon", encounterId },
        this.state,
      );
    }
    return this.state;
  }

  /**
   * Check if the simulation objective has been met.
   */
  private checkObjective(): boolean {
    // A caller-supplied stop predicate (an objective-plan rung's engine-exact
    // `done()`, for instance) short-circuits the configured objective, so the run
    // halts the moment that condition flips true.
    if (this.config.stopWhen?.(this.state)) return true;

    const objective = this.config.objective;

    switch (objective.type) {
      case "buildingCount":
        return (
          (this.state.builtBuildings[objective.building] || 0) >=
          objective.target
        );
      case "ageReach":
        return (
          this.state.getCurrentAge()?.key === resolveAgeId(objective.ageId)
        );
      case "battleVictory":
        return this.state.defeatedEncounters.includes(objective.encounterId);
      case "timeLimit":
        return this.gameTime >= objective.seconds;
    }
  }

  /**
   * Check for milestone events and record snapshots.
   */
  private checkMilestones(): void {
    const currentAge = this.state.getCurrentAge();
    if (!currentAge) return;

    const ageId = currentAge.key;
    if (
      this.lastMilestoneAge !== ageId &&
      this.state.enteredAges.includes(ageId)
    ) {
      this.lastMilestoneAge = ageId;
      this.recordSnapshot("age", ageId);
      this.strategy.onMilestone?.({ type: "ageEntered", ageId }, this.state);
    }

    // Battle won (check if new battles defeated since the last milestone)
    const battlesWon = this.state.defeatedEncounters.length;
    if (battlesWon > this.lastMilestoneBattles) {
      const newBattle = this.state.defeatedEncounters[battlesWon - 1];
      this.lastMilestoneBattles = battlesWon;
      this.recordSnapshot("battle", newBattle);
      this.strategy.onMilestone?.(
        { type: "battleWon", encounterId: newBattle },
        this.state,
      );
    }
  }

  /**
   * Record a periodic snapshot when the interval grid says one is due.
   *
   * Called from `tick()` — every simulated second, including each second inside
   * `skipTime`'s batches — so the snapshot lands on the exact grid second rather
   * than up to a batch late. `nextPeriodicTime` is a self-contained clock (seeded
   * at the first interval, then realigned to the next absolute grid multiple), so
   * an off-grid milestone snapshot recorded elsewhere can no longer push the
   * periodic cadence sideways the way the old "now minus last snapshot" anchor
   * did. Milestones keep their own rows; this only advances the periodic grid.
   */
  private recordPeriodicSnapshot(): void {
    if (!this.config.recordSnapshots || this.gameTime <= 0) return;

    const interval = this.config.snapshotIntervalSeconds ?? 60;
    if (this.nextPeriodicTime === 0) this.nextPeriodicTime = interval;
    if (this.gameTime >= this.nextPeriodicTime) {
      this.recordSnapshot("periodic");
      // Realign to the next absolute grid multiple past the current game time.
      // With the check on every tick this is normally `+interval`, but the floor
      // keeps the grid anchored to interval multiples should it ever overshoot.
      this.nextPeriodicTime =
        (Math.floor(this.gameTime / interval) + 1) * interval;
    }
  }

  /**
   * Record a snapshot at the current state, tagged with what triggered it.
   *
   * `index` stays a single counter across every kind (the CSV and the stall
   * detector read it as "the nth row"); `periodicIndex` counts periodic rows
   * alone so the runner's "Snapshot N" stays on the interval grid regardless of
   * how many milestone rows interleave.
   */
  private recordSnapshot(kind: SnapshotKind, milestoneId?: string): void {
    if (!this.config.recordSnapshots) return;

    const periodicIndex = kind === "periodic" ? this.periodicCount : undefined;
    if (kind === "periodic") this.periodicCount += 1;

    const snapshot: SimulationSnapshot = {
      ...this.buildStateSummary(),
      kind,
      milestoneId,
      periodicIndex,
      index: this.snapshotCount,
      timing: this.currentTiming(),
      timestamp: this.gameTime,
      resourcesSpent: Object.fromEntries(
        Object.entries(this.state.statistics.resourcesSpent).map(
          ([key, value]) => [key, value.toString()],
        ),
      ),
    };

    this.snapshots.push(snapshot);
    this.snapshotCount += 1;
    this.config.onSnapshot?.(snapshot, this.snapshots.length - 1);
  }

  /**
   * Fold the live accumulators into the snapshot-shaped timing. Returned by
   * value, so a snapshot keeps the numbers as they were when it was taken
   * instead of mutating as later ticks land.
   */
  private currentTiming(): SnapshotTiming {
    const tick = summarizeTiming(
      this.tickCount,
      this.tickTotalMs,
      this.tickMaxMs,
    );
    const decision = summarizeTiming(
      this.decisionCount,
      this.decisionTotalMs,
      this.decisionMaxMs,
    );
    return {
      ticks: this.tickCount,
      tickMeanMs: tick.meanMs,
      tickMaxMs: tick.maxMs,
      decisions: this.decisionCount,
      decisionMeanMs: decision.meanMs,
      decisionMaxMs: decision.maxMs,
    };
  }

  /**
   * Create the final simulation result.
   */
  private createResult(success: boolean, reason: string): SimulationResult {
    // Every termination path (both `Objective reached` returns and the final
    // `Time limit reached`) funnels through here, so this is the one place that
    // can guarantee the closing state is recorded. A run that stops on an
    // objective returns before the next `checkMilestones`, so the last periodic
    // snapshot can be up to a whole interval short of the real end state â€” and
    // that is precisely the row a benchmark reads as "final". Skipped when the
    // last snapshot already sits on `gameTime` (a time-limit run that ended
    // exactly on an interval tick), so the common case gains no duplicate row.
    if (
      this.config.recordSnapshots &&
      this.snapshots[this.snapshots.length - 1]?.timestamp !== this.gameTime
    ) {
      this.recordSnapshot("final");
    }

    return {
      success,
      objectiveReached: this.checkObjective(),
      gameTime: this.gameTime,
      finalState: this.state,
      snapshots: this.snapshots,
      objectiveMet: this.getObjectiveMet(),
      terminationReason: reason,
      events: this.events,
      finalProductionRates: this.computeProductionRates(),
      tickTiming: {
        ticks: this.tickCount,
        ...summarizeTiming(this.tickCount, this.tickTotalMs, this.tickMaxMs),
      },
      decisionTiming: {
        decisions: this.decisionCount,
        ...summarizeTiming(
          this.decisionCount,
          this.decisionTotalMs,
          this.decisionMaxMs,
        ),
      },
    };
  }

  /**
   * Accumulate one `decideAction` call. Calls that return null ("do nothing")
   * are counted too — they still cost the strategy real time, and excluding
   * them would flatter a strategy that idles.
   */
  private recordDecisionTiming(elapsed: number): void {
    this.decisionCount += 1;
    this.decisionTotalMs += elapsed;
    this.decisionMaxMs = Math.max(this.decisionMaxMs, elapsed);
  }

  /**
   * Get which objective was met (if any).
   */
  private getObjectiveMet(): string | undefined {
    const objective = this.config.objective;

    switch (objective.type) {
      case "buildingCount":
        if (
          (this.state.builtBuildings[objective.building] || 0) >=
          objective.target
        ) {
          return `${objective.building} count ${objective.target}`;
        }
        break;
      case "ageReach":
        if (this.state.getCurrentAge()?.key === resolveAgeId(objective.ageId)) {
          return `age ${resolveAgeId(objective.ageId)}`;
        }
        break;
      case "battleVictory":
        if (this.state.defeatedEncounters.includes(objective.encounterId)) {
          return `battle ${objective.encounterId}`;
        }
        break;
      case "timeLimit":
        if (this.gameTime >= objective.seconds) {
          return `time limit ${objective.seconds}s`;
        }
        break;
    }
    return undefined;
  }
}

/**
 * Create a fresh initial state for simulation.
 */
export function createInitialState(): CivilizationState {
  return new CivilizationState();
}
