/**
 * Simulation engine for balance testing and strategy optimization.
 * Runs headless game simulations with configurable strategies and objectives.
 */

import { CivilizationState } from "../src/game/civilizationState.js";
import { ExpNumber } from "../src/game/expNumber.js";
import { type BuildingKey } from "../src/game/buildings.js";
import { encounterDefinitions } from "../src/game/encounters.js";
import {
  producerResourceKeys,
  type ProductionResourceKey,
} from "../src/game/attributes.js";

/**
 * A snapshot of game state at a milestone for analysis.
 */
export interface SimulationSnapshot {
  timestamp: number; // Game time in seconds
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
  seed: number;
  objective: SimulationObjective;
  gatherClicksPerAction: number; // clicks each gather action models (default 10)
  maxGameTime: number; // maximum simulation time in seconds
  recordSnapshots: boolean;
  verbose?: boolean; // enable debug output
}

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
}

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
  private gameTime = 0;

  constructor(
    initialState: CivilizationState,
    strategy: SimulationStrategy,
    config: SimulationConfig,
  ) {
    this.state = initialState;
    this.strategy = strategy;
    this.config = config;
  }

  /** Log a message if verbose mode is enabled. */
  private log(...args: any[]): void {
    if (this.config.verbose) {
      console.log(...args);
    }
  }

  /**
   * Run the full simulation to completion.
   */
  run(): SimulationResult {
    // Initial burst: gather wood and build a house, then gather food and build people
    // This sets up the initial population and workers

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

    // Step 1: Gather wood until we can build a house (one 10-click action/sec)
    while (
      !this.state.canBuild("house") &&
      this.state.resources.wood.lt(ExpNumber.fromNumber(10))
    ) {
      this.executeAction({ type: "gather", resource: "wood" });
      this.gameTime += 1;
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

    // Step 3: Gather food until we can build a person (one 10-click action/sec)
    while (
      !this.state.canBuild("people") &&
      this.state.resources.food.lt(ExpNumber.fromNumber(10))
    ) {
      this.executeAction({ type: "gather", resource: "food" });
      this.gameTime += 1;
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

    while (this.gameTime < this.config.maxGameTime) {
      // Check objective completion
      if (this.checkObjective()) {
        return this.createResult(true, "Objective reached");
      }

      // Execute strategy decision — one action per second, then one tick
      const action = this.strategy.decideAction(this.state, {
        gameTime: this.gameTime,
        snapshots: this.snapshots,
      });

      if (action) {
        this.executeAction(action);
      }

      // Advance one tick of production, achievement checks, etc.
      this.state = this.state.tick();
      this.gameTime += 1;

      // Check for milestones and record snapshots
      this.checkMilestones();
    }

    return this.createResult(false, "Time limit reached");
  }

  /**
   * Execute a single simulation action. One action per second; each gather
   * action models `gatherClicksPerAction` production clicks and reports the
   * amount gathered.
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
        this.state = this.state.tick();
        this.gameTime += 1;
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
    let state = this.state;
    for (let i = 0; i < count; i++) {
      if (state.canBuild(building)) {
        state = state.build(building);
      } else {
        break;
      }
    }
    return state;
  }

  /**
   * Build as many of a building as possible right now.
   * Returns the new state and how many were actually built.
   */
  private buildMaxBuilding(building: BuildingKey): {
    state: CivilizationState;
    count: number;
  } {
    let state = this.state;
    let count = 0;

    while (state.canBuild(building)) {
      state = state.build(building);
      count++;
      if (count >= 100) break; // Safety limit
    }

    return { state, count };
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
    const objective = this.config.objective;

    switch (objective.type) {
      case "buildingCount":
        return (
          (this.state.builtBuildings[objective.building] || 0) >=
          objective.target
        );
      case "ageReach":
        return this.state.enteredAges.includes(objective.ageId);
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
    const previousAge = this.snapshots[this.snapshots.length - 1]?.age;

    // New age entered
    if (previousAge !== ageId && this.state.enteredAges.includes(ageId)) {
      this.recordSnapshot();
      this.strategy.onMilestone?.({ type: "ageEntered", ageId }, this.state);
    }

    // Battle won (check if new battles defeated since last snapshot)
    const battlesWon = this.state.defeatedEncounters.length;
    const previousBattles =
      this.snapshots[this.snapshots.length - 1]?.battlesWon || 0;
    if (battlesWon > previousBattles) {
      const newBattle = this.state.defeatedEncounters[battlesWon - 1];
      this.recordSnapshot();
      this.strategy.onMilestone?.(
        { type: "battleWon", encounterId: newBattle },
        this.state,
      );
    }

    // Periodic snapshots every 5 minutes for long simulations
    if (this.config.recordSnapshots && this.gameTime > 0) {
      const lastSnapshotTime =
        this.snapshots[this.snapshots.length - 1]?.timestamp || 0;
      if (this.gameTime - lastSnapshotTime >= 300) {
        this.recordSnapshot();
      }
    }
  }

  /**
   * Record a snapshot at the current state.
   */
  private recordSnapshot(): void {
    if (!this.config.recordSnapshots) return;

    const currentAge = this.state.getCurrentAge();
    const snapshot: SimulationSnapshot = {
      timestamp: this.gameTime,
      age: currentAge?.key || "unknown",
      population: this.state.population.toNumber(),
      resources: Object.fromEntries(
        Object.entries(this.state.resources).map(([k, v]) => [
          k,
          (v as ExpNumber).toString(),
        ]),
      ) as Record<string, string>,
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
      productionRates: Object.fromEntries(
        producerResourceKeys.map((key) => [
          key,
          this.state.computeResourceRate(key).toString(),
        ]),
      ) as Record<string, string>,
      battlesWon: this.state.defeatedEncounters.length,
      totalBuildings: Object.values(this.state.builtBuildings).reduce(
        (sum, count) => sum + (count ?? 0),
        0,
      ),
      militaryPower: this.state.getArmyPower().toNumber(),
    };

    this.snapshots.push(snapshot);
  }

  /**
   * Create the final simulation result.
   */
  private createResult(success: boolean, reason: string): SimulationResult {
    return {
      success,
      objectiveReached: this.checkObjective(),
      gameTime: this.gameTime,
      finalState: this.state,
      snapshots: this.snapshots,
      objectiveMet: this.getObjectiveMet(),
      terminationReason: reason,
    };
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
        if (this.state.enteredAges.includes(objective.ageId)) {
          return `age ${objective.ageId}`;
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

/**
 * Returns true only if the given production resource is currently unlocked
 * (i.e. the player has built at least one of the required building).
 * Mirrors the filter in App.tsx's gather-grid.
 */
export function isResourceGatherable(
  state: CivilizationState,
  key: string,
): boolean {
  switch (key) {
    case "military":
      return state.getBuildingCount("barracks") > 0;
    case "science":
      return state.getBuildingCount("university") > 0;
    case "metalwork":
      return state.getBuildingCount("smithy") > 0;
    case "trade":
      return state.getBuildingCount("market") > 0;
    default:
      return true; // food, wood, stone, gold always available
  }
}
