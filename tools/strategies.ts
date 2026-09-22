/**
 * Pre-built simulation strategies for balance testing.
 * Each strategy implements decision-making logic for worker assignment,
 * building priorities, and battle timing.
 */

import { CivilizationState } from "../src/game/civilizationState.js";
import { ExpNumber } from "../src/game/expNumber.js";
import { type BuildingKey } from "../src/game/buildings.js";
import { encounterDefinitions } from "../src/game/encounters.js";
import {
  type SimulationStrategy,
  type SimulationAction,
  type SimulationContext,
  type MilestoneEvent,
} from "./simulation.js";
import {
  producerResourceKeys,
  type ProductionResourceKey,
} from "../src/game/attributes.js";

/**
 * Worker assignment ratios for different strategies.
 */
type WorkerRatios = {
  food: number;
  wood: number;
  stone: number;
  gold: number;
  military: number;
  science: number;
  metalwork: number;
  trade: number;
};

/**
 * Building priority lists for different strategies.
 */
type BuildingPriority = {
  building: BuildingKey;
  weight: number;
  targetCount?: number;
}[];

/**
 * Base strategy class with common utilities.
 */
abstract class BaseStrategy implements SimulationStrategy {
  abstract name: string;
  abstract description: string;

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.4,
      wood: 0.3,
      stone: 0.2,
      gold: 0.1,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 8 },
      { building: "farm", weight: 7 },
      { building: "lumber-yard", weight: 6 },
      { building: "quarry", weight: 5 },
      { building: "gold-mine", weight: 4 },
      { building: "market", weight: 3 },
      { building: "town-hall", weight: 2 },
    ];
  }

  protected shouldLaunchBattle(_state: CivilizationState): boolean {
    return false;
  }

  /**
   * Assign workers according to strategy ratios.
   */
  protected assignWorkersByRatio(
    state: CivilizationState,
    ratios: WorkerRatios,
  ): SimulationAction | null {
    const total = Object.values(ratios).reduce((sum, r) => sum + r, 0);
    const available = state.availableWorkers;

    if (available <= 0 || total === 0) return null;

    // Calculate target assignments for all production resources
    const targets: Record<ProductionResourceKey, number> = {
      food: Math.floor((ratios.food / total) * available),
      wood: Math.floor((ratios.wood / total) * available),
      stone: Math.floor((ratios.stone / total) * available),
      gold: Math.floor((ratios.gold / total) * available),
      military: Math.floor((ratios.military / total) * available),
      science: Math.floor((ratios.science / total) * available),
      metalwork: Math.floor((ratios.metalwork / total) * available),
      trade: Math.floor((ratios.trade / total) * available),
    };

    // Distribute remainder to food
    const assigned = Object.values(targets).reduce((sum, t) => sum + t, 0);
    targets.food += available - assigned;

    // Find resource needing most adjustment
    for (const resource of producerResourceKeys as ProductionResourceKey[]) {
      const current = state.workers[resource]?.toNumber() || 0;
      const target = targets[resource] || 0;
      const diff = target - current;

      if (diff > 0) {
        return { type: "assignWorker", resource, count: diff };
      } else if (diff < 0) {
        return { type: "unassignWorker", resource, count: -diff };
      }
    }

    return null;
  }

  /**
   * Find the best building to build based on priority and affordability.
   */
  protected findBestBuilding(
    state: CivilizationState,
    priority: BuildingPriority,
  ): BuildingKey | null {
    for (const { building, targetCount } of priority) {
      // Check if at target count
      if (targetCount && (state.builtBuildings[building] || 0) >= targetCount) {
        continue;
      }

      // Check if can build
      if (state.canBuild(building)) {
        return building;
      }
    }
    return null;
  }

  /**
   * Default decision logic that can be overridden.
   */
  decideAction(
    state: CivilizationState,
    _context: SimulationContext,
  ): SimulationAction | null {
    // Priority 1: Launch battle if ready
    if (this.shouldLaunchBattle(state)) {
      const nextBattle = state.getNextBattle();
      if (nextBattle) {
        return { type: "launchBattle", encounterId: nextBattle.key };
      }
    }

    // Priority 2: Assign workers
    const workerAction = this.assignWorkersByRatio(
      state,
      this.getWorkerRatios(),
    );
    if (workerAction) return workerAction;

    // Priority 3: Build buildings
    const building = this.findBestBuilding(state, this.getBuildingPriority());
    if (building) {
      return { type: "build", building, count: 1 };
    }

    // Priority 4: Gather resources
    const resourceToGather = this.getResourceToGather(state);
    if (resourceToGather) {
      return { type: "gather", resource: resourceToGather };
    }

    // Nothing to do - wait
    return null;
  }

  protected getResourceToGather(state: CivilizationState): string | null {
    // Gather the resource with lowest production rate
    let lowestResource: ProductionResourceKey = "food";
    let lowestRate = state.computeResourceRate("food");

    for (const resource of producerResourceKeys as ProductionResourceKey[]) {
      const rate = state.computeResourceRate(resource);
      if (rate.lt(lowestRate)) {
        lowestRate = rate;
        lowestResource = resource;
      }
    }

    return lowestResource;
  }

  onMilestone?(_event: MilestoneEvent, _state: CivilizationState): void {
    // Override in subclasses for milestone-specific behavior
  }
}

/**
 * Balanced strategy: equal focus on production and military.
 */
export class BalancedStrategy extends BaseStrategy {
  name = "balanced";
  description = "Balanced approach to production and military development";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.4,
      wood: 0.25,
      stone: 0.2,
      gold: 0.15,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "farm", weight: 8 },
      { building: "lumber-yard", weight: 7 },
      { building: "quarry", weight: 6 },
      { building: "gold-mine", weight: 5 },
      { building: "barracks", weight: 4, targetCount: 3 },
      { building: "smithy", weight: 3, targetCount: 2 },
      { building: "market", weight: 2 },
      { building: "town-hall", weight: 1 },
    ];
  }

  protected shouldLaunchBattle(state: CivilizationState): boolean {
    // Launch battle when military power is decent
    const power = state.getArmyPower();
    const nextBattle = state.getNextBattle();
    return nextBattle !== undefined && power.gte(ExpNumber.fromNumber(50));
  }
}

/**
 * Production-focused strategy: maximize resource generation.
 */
export class ProductionStrategy extends BaseStrategy {
  name = "production";
  description = "Focus on maximizing resource production, minimal military";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.5,
      wood: 0.25,
      stone: 0.15,
      gold: 0.1,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "farm", weight: 8 },
      { building: "lumber-yard", weight: 8 },
      { building: "quarry", weight: 7 },
      { building: "gold-mine", weight: 7 },
      { building: "market", weight: 5 },
      { building: "town-hall", weight: 4 },
    ];
  }

  protected shouldLaunchBattle(_state: CivilizationState): boolean {
    // Only launch battles when necessary (high power to ensure wins)
    return false; // Production strategy avoids battles
  }
}

/**
 * Military-focused strategy: early military investment.
 */
export class MilitaryStrategy extends BaseStrategy {
  name = "military";
  description = "Early military investment, aggressive battle engagement";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.35,
      wood: 0.25,
      stone: 0.25,
      gold: 0.15,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "farm", weight: 7 },
      { building: "lumber-yard", weight: 6 },
      { building: "quarry", weight: 6 },
      { building: "barracks", weight: 8, targetCount: 5 },
      { building: "smithy", weight: 7, targetCount: 3 },
      { building: "gold-mine", weight: 5 },
      { building: "market", weight: 3 },
      { building: "town-hall", weight: 2 },
    ];
  }

  protected shouldLaunchBattle(state: CivilizationState): boolean {
    // Launch battles aggressively
    const nextBattle = state.getNextBattle();
    return nextBattle !== undefined;
  }

  protected getResourceToGather(_state: CivilizationState): string | null {
    // Prioritize gathering resources for military buildings
    return "gold";
  }
}

/**
 * Fast-age strategy: push population growth to age up quickly.
 */
export class FastAgeStrategy extends BaseStrategy {
  name = "fast-age";
  description = "Prioritize population growth to reach new ages quickly";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.6,
      wood: 0.2,
      stone: 0.1,
      gold: 0.1,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 10 },
      { building: "farm", weight: 9 },
      { building: "town-hall", weight: 8 },
      { building: "lumber-yard", weight: 5 },
      { building: "quarry", weight: 4 },
      { building: "gold-mine", weight: 3 },
      { building: "market", weight: 2 },
    ];
  }

  protected shouldLaunchBattle(state: CivilizationState): boolean {
    // Only do battles required for age progression
    const currentAge = state.getCurrentAge();
    if (!currentAge) return false;

    // Check if all battles in current age are won
    const ageIndex = parseInt(currentAge.key.slice(-1), 10);
    const ageBattles = encounterDefinitions.filter(
      (e: { age: number }) => e.age === ageIndex,
    );
    const battlesWon = ageBattles.filter((b: { key: string }) =>
      state.defeatedEncounters.includes(b.key),
    ).length;

    // Launch next battle if not all won
    const nextBattle = state.getNextBattle();
    return nextBattle !== undefined && battlesWon < ageBattles.length;
  }
}

/**
 * Economy strategy: maximize gold and trade.
 */
export class EconomyStrategy extends BaseStrategy {
  name = "economy";
  description = "Focus on gold production and trade buildings";

  protected getWorkerRatios(): WorkerRatios {
    return {
      food: 0.3,
      wood: 0.2,
      stone: 0.15,
      gold: 0.35,
      military: 0,
      science: 0,
      metalwork: 0,
      trade: 0,
    };
  }

  protected getBuildingPriority(): BuildingPriority {
    return [
      { building: "people", weight: 10 },
      { building: "house", weight: 9 },
      { building: "gold-mine", weight: 9 },
      { building: "market", weight: 8, targetCount: 5 },
      { building: "farm", weight: 6 },
      { building: "lumber-yard", weight: 5 },
      { building: "quarry", weight: 4 },
      { building: "town-hall", weight: 3 },
    ];
  }

  protected getResourceToGather(_state: CivilizationState): string | null {
    return "gold";
  }
}

/**
 * Strategy registry for easy access.
 */
export const strategyRegistry: Record<string, SimulationStrategy> = {
  balanced: new BalancedStrategy(),
  production: new ProductionStrategy(),
  military: new MilitaryStrategy(),
  "fast-age": new FastAgeStrategy(),
  economy: new EconomyStrategy(),
};

/**
 * Get a strategy by name.
 */
export function getStrategy(name: string): SimulationStrategy | undefined {
  return strategyRegistry[name];
}

/**
 * Get all available strategy names.
 */
export function getStrategyNames(): string[] {
  return Object.keys(strategyRegistry);
}
