/** Run a single strategy benchmark with timing details. */

import { GameSimulation, createInitialState } from "./simulation.js";
import { getStrategy } from "./strategies.js";
import { getSimulatorCacheStats } from "./strategies.js";

const strategyName = process.argv[2] || "balanced";
const maxTime = Number(process.argv[3]) || 72000;

console.log(`=== Running ${strategyName} strategy to age2 ===`);
console.log(`Max time: ${maxTime}s (${Math.floor(maxTime / 3600)}h ${Math.floor((maxTime % 3600) / 60)}m ${maxTime % 60}s)`);
console.log("");

const initialState = createInitialState();
const strategy = getStrategy(strategyName);
if (!strategy) {
  throw new Error(`Unknown strategy: ${strategyName}`);
}

const config = {
  objective: { type: "ageReach", ageId: "age2" },
  gatherClicksPerAction: 10,
  actionsPerSecond: 5,
  maxGameTime: maxTime,
  recordSnapshots: true,
  snapshotIntervalSeconds: 60,
  verbose: false,
};

const startedAt = Date.now();
const result = new GameSimulation(initialState, strategy, config).run();
const runTime = Date.now() - startedAt;

const cacheStats = getSimulatorCacheStats();

console.log("=== CACHE STATS ===");
console.log(`Cache Hits: ${cacheStats.hits}`);
console.log(`Cache Misses: ${cacheStats.misses}`);
console.log(`Cache Hit Rate: ${(cacheStats.hitRate * 100).toFixed(1)}%`);
console.log(`Cache Size: ${cacheStats.size}`);
console.log("");
console.log("=== SIMULATION STATS ===");
console.log(`Game Time: ${result.gameTime}s`);
console.log(`Real Time: ${(runTime / 1000).toFixed(2)}s`);
console.log(`Success: ${result.success}`);
console.log(`Objective Reached: ${result.objectiveReached}`);
console.log(`Termination: ${result.terminationReason}`);
console.log(`Final Age: ${result.finalState.getCurrentAge()?.key || "unknown"}`);
console.log(`Final Population: ${result.finalState.population.toString()}`);
console.log(`Battles Won: ${result.finalState.defeatedEncounters.length}`);
console.log(`Tick Mean: ${result.tickTiming.meanMs.toFixed(3)}ms`);
console.log(`Tick Max: ${result.tickTiming.maxMs.toFixed(3)}ms`);
console.log(`Decision Mean: ${result.decisionTiming.meanMs.toFixed(3)}ms`);
console.log(`Decision Max: ${result.decisionTiming.maxMs.toFixed(3)}ms`);
console.log(`Total Decisions: ${result.decisionTiming.decisions}`);
