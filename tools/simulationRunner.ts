/**
 * Simulation runner wrapper for CLI and programmatic use.
 * Provides a simplified interface for running simulations.
 */

import {
  GameSimulation,
  createInitialState,
  type SimulationConfig,
  type SimulationResult,
  type SimulationStrategy,
} from "./simulation.js";

/**
 * Create a configured simulation runner.
 */
export function createSimulationRunner(
  strategy: SimulationStrategy,
  config: SimulationConfig,
): {
  run: () => SimulationResult;
} {
  return {
    run: () => {
      const initialState = createInitialState();
      const simulation = new GameSimulation(initialState, strategy, config);
      return simulation.run();
    },
  };
}

/**
 * Run a simulation with inline configuration.
 */
export function runSimulation(
  strategy: SimulationStrategy,
  config: Partial<SimulationConfig> = {},
): SimulationResult {
  const defaultConfig: SimulationConfig = {
    seed: 42,
    objective: { type: "timeLimit", seconds: 3600 },
    actionRate: 10,
    skipInterval: 60,
    maxGameTime: 3600,
    recordSnapshots: true,
  };

  const fullConfig = { ...defaultConfig, ...config };
  const runner = createSimulationRunner(strategy, fullConfig);
  return runner.run();
}
