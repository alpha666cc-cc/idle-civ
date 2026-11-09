/** Simple test of battle simulator cache performance. */

import { GameSimulation, createInitialState } from "./simulation.js";
import { getStrategy } from "./strategies.js";
import { getSimulatorCacheStats } from "./strategies.js";

console.log("Testing battle simulator cache with balanced strategy...");
console.log("");

const initialState = createInitialState();
const strategy = getStrategy("balanced");

const config = {
  objective: { type: "timeLimit", seconds: 3600 },
  gatherClicksPerAction: 10,
  actionsPerSecond: 5,
  maxGameTime: 3600,
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
console.log(`Final Age: ${result.finalState.getCurrentAge()?.key || "unknown"}`);
console.log(`Final Population: ${result.finalState.population.toString()}`);
console.log(`Battles Won: ${result.finalState.defeatedEncounters.length}`);
console.log(`Tick Mean: ${result.tickTiming.meanMs.toFixed(3)}ms`);
console.log(`Tick Max: ${result.tickTiming.maxMs.toFixed(3)}ms`);
console.log(`Decision Mean: ${result.decisionTiming.meanMs.toFixed(3)}ms`);
console.log(`Decision Max: ${result.decisionTiming.maxMs.toFixed(3)}ms`);
