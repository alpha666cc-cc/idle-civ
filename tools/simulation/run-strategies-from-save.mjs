/**
 * Run all strategies starting from a save file with objective: reach battle 8 (age2_1_marathon)
 * Max time: 10 hours (36000 seconds)
 */

import { GameSimulation } from "./simulation.js";
import { strategyRegistry } from "./strategies.js";
import { formatExpoNumber } from "./simFormat.js";
import {
  describeSaveEntry,
  loadSaveEntry,
} from "./saveEntry.js";

const STRATEGIES = Object.keys(strategyRegistry);
const MAX_TIME = 36000; // 10 hours
const TARGET_BATTLE = "age2_1_marathon";
const SAVE_PATH = "saves/age2-start-26109.json";

function formatGameTime(seconds) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  }
  return `${secs}s`;
}

function runStrategy(strategyName, entry) {
  const strategy = strategyRegistry[strategyName];
  if (!strategy) {
    console.error(`Unknown strategy: ${strategyName}`);
    return null;
  }

  const config = {
    objective: { type: "timeLimit", seconds: MAX_TIME },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: MAX_TIME,
    recordSnapshots: true,
    snapshotIntervalSeconds: 300, // Every 5 minutes
    verbose: false,
    fromScratch: false, // Starting from save
  };

  console.log(`Running strategy: ${strategyName}...`);
  const startTime = Date.now();

  const simulation = new GameSimulation(entry.state, strategy, config);
  const result = simulation.run();

  const endTime = Date.now();

  // Check if battle 8 was won
  const wonBattle8 = result.finalState.defeatedEncounters.includes(TARGET_BATTLE);
  const battle8Time = result.events.find(
    (e) => e.type === "battle" && e.id === TARGET_BATTLE
  )?.time;

  return {
    strategyName,
    result,
    wonBattle8,
    battle8Time,
    runTime: endTime - startTime,
  };
}

function main() {
  console.log("=== Running all strategies from age2-start save ===");
  console.log(`Target: Win battle 8 (${TARGET_BATTLE})`);
  console.log(`Max time: ${MAX_TIME}s (${formatGameTime(MAX_TIME)})`);
  console.log(`Save: ${SAVE_PATH}`);
  console.log("");

  // Load the save file
  let entry;
  try {
    entry = loadSaveEntry(SAVE_PATH);
    console.log(describeSaveEntry(entry));
    console.log("");
  } catch (error) {
    console.error(`Could not load the save: ${error.message}`);
    process.exit(1);
  }

  const results = [];

  for (const strategyName of STRATEGIES) {
    const runResult = runStrategy(strategyName, entry);
    if (runResult) {
      results.push(runResult);
    }
    console.log("");
  }

  console.log("\n=== RESULTS SUMMARY ===\n");

  const successfulStrategies = [];

  for (const { strategyName, result, wonBattle8, battle8Time, runTime } of results) {
    console.log(`Strategy: ${strategyName}`);
    console.log(`  Success: ${result.success}`);
    console.log(`  Game Time: ${result.gameTime}s (${formatGameTime(result.gameTime)})`);
    console.log(`  Real Time: ${(runTime / 1000).toFixed(2)}s`);
    console.log(`  Termination: ${result.terminationReason}`);
    console.log(`  Final Age: ${result.finalState.getCurrentAge()?.key || "unknown"}`);
    console.log(`  Final Population: ${formatExpoNumber(result.finalState.population)}`);
    console.log(`  Battles Won: ${result.finalState.defeatedEncounters.length}`);
    console.log(`  Won Battle 8 (${TARGET_BATTLE}): ${wonBattle8 ? "YES" : "NO"}`);
    if (wonBattle8 && battle8Time !== undefined) {
      console.log(`    Time to win: ${battle8Time}s (${formatGameTime(battle8Time)})`);
      successfulStrategies.push({
        strategy: strategyName,
        time: battle8Time,
      });
    }
    console.log("");
  }

  console.log("=== BATTLE 8 SUMMARY ===\n");
  if (successfulStrategies.length > 0) {
    console.log(
      `${successfulStrategies.length} strategy/strategies won battle 8 within 10 hours:`
    );
    successfulStrategies.sort((a, b) => a.time - b.time);
    for (const { strategy, time } of successfulStrategies) {
      console.log(`  - ${strategy}: ${time}s (${formatGameTime(time)})`);
    }
  } else {
    console.log("No strategy won battle 8 within 10 hours.");
  }
}

main();
