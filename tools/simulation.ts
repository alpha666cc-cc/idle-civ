/**
 * Simulation engine for balance testing and strategy optimization.
 * Runs headless game simulations with configurable strategies and objectives.
 */

import { CivilizationState } from "../src/game/civilizationState.js";
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
  buildings: Record<BuildingKey, number>;
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
  actionRate: number; // actions per second
  skipInterval: number; // seconds to skip between action phases
  maxGameTime: number; // maximum simulation time in seconds
  recordSnapshots: boolean;
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
  actionsThisPhase: number;
  currentPhase: "action" | "skip";
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
  private actionsThisPhase = 0;
  private currentPhase: "action" | "skip" = "action";

  constructor(
    initialState: CivilizationState,
    strategy: SimulationStrategy,
    config: SimulationConfig,
  ) {
    this.state = initialState;
    this.strategy = strategy;
    this.config = config;
  }

  /**
   * Run the full simulation to completion.
   */
  run(): SimulationResult {
    while (this.gameTime < this.config.maxGameTime) {
      // Check objective completion
      if (this.checkObjective()) {
        return this.createResult(true, "Objective reached");
      }

      // Execute strategy decision
      const action = this.strategy.decideAction(this.state, {
        gameTime: this.gameTime,
        actionsThisPhase: this.actionsThisPhase,
        currentPhase: this.currentPhase,
        snapshots: this.snapshots,
      });

      if (action) {
        this.executeAction(action);
        this.actionsThisPhase++;

        // Switch to skip phase after action rate limit
        if (this.actionsThisPhase >= this.config.actionRate) {
          this.currentPhase = "skip";
          this.actionsThisPhase = 0;
        }
      } else {
        // No action requested - skip time
        this.skipTime(this.config.skipInterval);
        this.currentPhase = "action";
        this.actionsThisPhase = 0;
      }

      // Check for milestones and record snapshots
      this.checkMilestones();
    }

    return this.createResult(false, "Time limit reached");
  }

  /**
   * Execute a single simulation action.
   */
  private executeAction(action: SimulationAction): void {
    switch (action.type) {
      case "gather":
        this.state = this.state.gather(action.resource as any);
        break;
      case "assignWorker":
        this.state = this.state.assignWorker(action.resource, action.count);
        break;
      case "unassignWorker":
        this.state = this.state.unassignWorker(action.resource, action.count);
        break;
      case "build":
        this.state = this.buildBuilding(action.building, action.count);
        break;
      case "buyUpgrade":
        // Upgrade purchasing not yet implemented in engine
        break;
      case "launchBattle":
        this.state = this.launchBattle(action.encounterId);
        break;
      case "wait":
        this.skipTime(action.seconds);
        break;
    }

    this.gameTime += 1 / this.config.actionRate; // Each action takes time
  }

  /**
   * Skip forward in time (simulate idle production).
   */
  private skipTime(seconds: number): void {
    for (let i = 0; i < seconds; i++) {
      this.state = this.state.tick();
      this.gameTime += 1;
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
        Object.entries(this.state.resources).map(([k, v]) => [k, v.toString()]),
      ) as Record<string, string>,
      buildings: { ...this.state.builtBuildings } as Record<
        BuildingKey,
        number
      >,
      productionRates: Object.fromEntries(
        producerResourceKeys.map((key) => [
          key,
          this.state.computeResourceRate(key).toString(),
        ]),
      ) as Record<string, string>,
      battlesWon: this.state.defeatedEncounters.length,
      totalBuildings: Object.values(this.state.builtBuildings).reduce(
        (sum, count) => sum + count,
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
