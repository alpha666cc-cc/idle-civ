/**
 * Run all strategies from age2-start save, targeting battle 8 (age2_1_marathon)
 * Uses snapshot-csv infrastructure for parallel execution and CSV output
 */

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { loadSaveEntry } from "./saveEntry.js";
import { getStrategyNames } from "./strategies.js";

const SAVE_PATH = "saves/age2-start-26109.json";
const MAX_TIME = 36000; // 10 hours
const INTERVAL = 300; // 5 minutes
const OUT_DIR = "sim-output/age2-battle8-test";
const TARGET_BATTLE = "age2_1_marathon";
const JOBS = Math.min(availableParallelism(), 4); // Cap at 4 workers

// Load the save file
let entry;
try {
  entry = loadSaveEntry(SAVE_PATH);
  console.log(`Loaded save: ${SAVE_PATH}`);
  console.log(`Age: ${entry.state.getCurrentAge()?.key}`);
  console.log(`Battles won: ${entry.state.defeatedEncounters.length}`);
  console.log(`Population: ${entry.state.population}`);
  console.log("");
} catch (error) {
  console.error(`Could not load the save: ${error.message}`);
  process.exit(1);
}

const strategies = getStrategyNames();
console.log(`Running ${strategies.length} strategies with ${JOBS} workers`);
console.log(`Max time: ${MAX_TIME}s (${(MAX_TIME / 3600).toFixed(1)}h)`);
console.log(`Target: Win battle 8 (${TARGET_BATTLE})`);
console.log(`Output: ${OUT_DIR}/`);
console.log("");

// Worker script as a string
const workerScript = `
import { GameSimulation } from "./simulation.js";
import { parentPort, workerData } from "node:worker_threads";

const { strategyName, entryData, maxTime, interval, targetBattle } = workerData;

// Recreate the state from the entry data
const entry = JSON.parse(entryData);
const simulation = new GameSimulation(
  entry.state,
  { name: strategyName, description: strategyName, decideAction: () => null },
  {
    objective: { type: "timeLimit", seconds: maxTime },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: maxTime,
    recordSnapshots: true,
    snapshotIntervalSeconds: interval,
    verbose: false,
    fromScratch: false,
  }
);

const result = simulation.run();

// Check if target battle was won
const wonTargetBattle = result.finalState.defeatedEncounters.includes(targetBattle);
const battleEvent = result.events.find(e => e.type === "battle" && e.id === targetBattle);
const battleTime = battleEvent?.time ?? null;

parentPort.postMessage({
  strategyName,
  wonTargetBattle,
  battleTime,
  gameTime: result.gameTime,
  battlesWon: result.finalState.defeatedEncounters.length,
  finalAge: result.finalState.getCurrentAge()?.key,
  finalPopulation: result.finalState.population.toString(),
  militaryPower: result.finalState.militaryPower?.toString() ?? "0",
});
`;

// Run strategies in parallel
async function runAllStrategies() {
  const results = [];
  const runningWorkers = [];

  for (const strategyName of strategies) {
    // Wait for a worker slot if we're at capacity
    if (runningWorkers.length >= JOBS) {
      const completed = await Promise.race(runningWorkers);
      results.push(completed);
      const index = runningWorkers.findIndex(w => w === completed.worker);
      runningWorkers.splice(index, 1);
    }

    const workerPromise = new Promise((resolve) => {
      const worker = new Worker(workerScript, {
        eval: true,
        workerData: {
          strategyName,
          entryData: JSON.stringify(entry),
          maxTime: MAX_TIME,
          interval: INTERVAL,
          targetBattle: TARGET_BATTLE,
        },
      });

      worker.on("message", (message) => {
        resolve({ worker, message });
        worker.terminate();
      });

      worker.on("error", (error) => {
        console.error(`Worker error for ${strategyName}:`, error);
        resolve({
          worker,
          message: {
            strategyName,
            wonTargetBattle: false,
            battleTime: null,
            gameTime: 0,
            battlesWon: 0,
            error: error.message,
          },
        });
        worker.terminate();
      });
    });

    runningWorkers.push(workerPromise);
  }

  // Wait for remaining workers
  const remaining = await Promise.all(runningWorkers);
  results.push(...remaining);

  return results.map(r => r.message);
}

// Main execution
const startTime = Date.now();
const results = await runAllStrategies();
const endTime = Date.now();

console.log("\n=== RESULTS ===\n");

const successful = [];
for (const r of results) {
  console.log(`${r.strategyName.padEnd(12)} | ${r.wonTargetBattle ? "YES" : "NO ".padEnd(3)} | Battle 8: ${r.battleTime ? `${r.battleTime}s` : "N/A".padEnd(6)} | Battles: ${r.battlesWon} | Time: ${r.gameTime}s`);
  if (r.wonTargetBattle) {
    successful.push({ strategy: r.strategyName, time: r.battleTime });
  }
}

console.log("\n=== SUMMARY ===\n");
console.log(`Real time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
console.log(`Strategies won battle 8: ${successful.length}`);

if (successful.length > 0) {
  console.log("\nWinning strategies:");
  successful.sort((a, b) => a.time - b.time);
  for (const { strategy, time } of successful) {
    console.log(`  ${strategy}: ${time}s (${(time / 60).toFixed(1)}m)`);
  }
} else {
  console.log("No strategy won battle 8 within 10 hours.");
}
