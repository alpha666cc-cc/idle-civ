/**
 * Run all 10 strategies with objective: reach age-1, max 7200 seconds
 * Extract and report battle times for each strategy
 */

import { runSimulation } from "./simulationRunner.js";
import { getStrategy, getStrategyNames } from "./strategies.js";
import { formatExpoNumber } from "./simFormat.js";

const STRATEGIES = getStrategyNames();
const MAX_TIME = 7200;
const OBJECTIVE = { type: "ageReach", ageId: "age1" };

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

function runStrategy(strategyName) {
  const strategy = getStrategy(strategyName);
  if (!strategy) {
    console.error(`Unknown strategy: ${strategyName}`);
    return null;
  }

  const config = {
    objective: OBJECTIVE,
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: MAX_TIME,
    recordSnapshots: true,
    snapshotIntervalSeconds: 300,
    verbose: false,
  };

  console.log(`Running strategy: ${strategyName}...`);
  const startTime = Date.now();
  const result = runSimulation(strategy, config);
  const endTime = Date.now();

  // Extract battle events from the result
  const battleEvents = result.events.filter((e) => e.type === "battle");

  return {
    strategyName,
    result,
    battleEvents,
    runTime: endTime - startTime,
  };
}

function main() {
  console.log("=== Running all 10 strategies ===");
  console.log(`Objective: Reach age-1`);
  console.log(`Max time: ${MAX_TIME}s (${formatGameTime(MAX_TIME)})`);
  console.log("");

  const results = [];

  for (const strategyName of STRATEGIES) {
    const runResult = runStrategy(strategyName);
    if (runResult) {
      results.push(runResult);
    }
    console.log("");
  }

  console.log("\n=== RESULTS SUMMARY ===\n");

  for (const { strategyName, result, battleEvents, runTime } of results) {
    console.log(`Strategy: ${strategyName}`);
    console.log(`  Success: ${result.success}`);
    console.log(`  Objective Reached: ${result.objectiveReached}`);
    console.log(
      `  Game Time: ${result.gameTime}s (${formatGameTime(result.gameTime)})`,
    );
    console.log(`  Real Time: ${(runTime / 1000).toFixed(2)}s`);
    console.log(`  Termination: ${result.terminationReason}`);
    console.log(
      `  Final Age: ${result.finalState.getCurrentAge()?.key || "unknown"}`,
    );
    console.log(
      `  Final Population: ${formatExpoNumber(result.finalState.population)}`,
    );
    console.log(
      `  Battles Won: ${result.finalState.defeatedEncounters.length}`,
    );

    if (battleEvents.length > 0) {
      console.log(`  Battle Times:`);
      for (const event of battleEvents) {
        console.log(
          `    - ${event.id}: ${event.time}s (${formatGameTime(event.time)})`,
        );
      }
    } else {
      console.log(`  Battle Times: No battles won`);
    }

    console.log("");
  }

  // Create a summary table
  console.log("=== BATTLE TIMES SUMMARY ===\n");
  console.log("Strategy | Age-1 Time | Battles Won | Battle Details");
  console.log("---------|------------|-------------|---------------");

  for (const { strategyName, result, battleEvents } of results) {
    const battleDetails = battleEvents
      .map((e) => `${e.id}@${e.time}s`)
      .join(", ");
    console.log(
      `${strategyName.padEnd(9)} | ${String(result.gameTime).padEnd(10)} | ${String(result.finalState.defeatedEncounters.length).padEnd(11)} | ${battleDetails || "none"}`,
    );
  }
}

main();
