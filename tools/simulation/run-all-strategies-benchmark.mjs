/**
 * Run all 10 strategies starting from age1 with objective: reach age2 in 40 minutes
 * Extract and report battle times for each strategy
 */

import { GameSimulation, createInitialState } from "./simulation.js";
import { strategyRegistry } from "./strategies.js";
import { formatExpoNumber } from "./simFormat.js";

const STRATEGIES = Object.keys(strategyRegistry);
const MAX_TIME = 2400; // 40 minutes
const OBJECTIVE = { type: "ageReach", ageId: "age2" };

// First, create an age1 state by running the balanced strategy to age1
function createAge1State() {
  console.log("Creating age1 starting state using balanced strategy...");
  console.log("Available strategies:", STRATEGIES);
  const strategy = strategyRegistry["balanced"];
  if (!strategy) {
    console.error("Balanced strategy not found!");
    throw new Error("Balanced strategy not found");
  }
  const age1Config = {
    objective: { type: "ageReach", ageId: "age1" },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: 3600,
    recordSnapshots: false,
    verbose: false,
  };

  const initialState = createInitialState();
  const simulation = new GameSimulation(initialState, strategy, age1Config);
  const result = simulation.run();
  console.log(`Age1 state created at ${result.gameTime}s`);
  return result.finalState;
}

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

function runStrategy(strategyName, initialState) {
  const strategy = strategyRegistry[strategyName];
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
    snapshotIntervalSeconds: 60, // More frequent snapshots for better battle timing
    verbose: false,
    fromScratch: false, // Don't run the bootstrap since we're starting from age1
  };

  console.log(`Running strategy: ${strategyName}...`);
  const startTime = Date.now();

  // Run simulation from the provided initial state
  const simulation = new GameSimulation(initialState, strategy, config);
  const result = simulation.run();

  const endTime = Date.now();

  // Extract battle events from the result
  const battleEvents = result.events.filter((e) => e.type === "battle");

  // Also get battle times from snapshots (when battle count increased)
  // This catches battles that might not be in events
  const battleTimesFromSnapshots = [];
  let lastBattleCount = 0;
  for (const snapshot of result.snapshots) {
    if (snapshot.battlesWon > lastBattleCount) {
      // A battle was won between the last snapshot and this one
      // Use the snapshot timestamp as an approximation
      const newBattles = snapshot.battlesWon - lastBattleCount;
      for (let i = 0; i < newBattles; i++) {
        battleTimesFromSnapshots.push({
          timestamp: snapshot.timestamp,
          battleCount: lastBattleCount + i + 1,
        });
      }
      lastBattleCount = snapshot.battlesWon;
    }
  }

  // Map each defeated encounter to its event time or snapshot time
  const battleTimes = result.finalState.defeatedEncounters.map(
    (encounterId, index) => {
      const event = battleEvents.find((e) => e.id === encounterId);
      // If no event, try to get from snapshots
      const snapshotTime = battleTimesFromSnapshots[index]?.timestamp;
      return {
        id: encounterId,
        time: event ? event.time : snapshotTime || null,
      };
    },
  );

  return {
    strategyName,
    result,
    battleEvents,
    battleTimes,
    runTime: endTime - startTime,
  };
}

function main() {
  console.log("=== Running all 10 strategies from age1 ===");
  console.log(`Objective: Reach age2`);
  console.log(`Max time: ${MAX_TIME}s (${formatGameTime(MAX_TIME)})`);
  console.log("");

  // Create age1 starting state
  const age1State = createAge1State();
  console.log("");

  const results = [];

  for (const strategyName of STRATEGIES) {
    const runResult = runStrategy(strategyName, age1State);
    if (runResult) {
      results.push(runResult);
    }
    console.log("");
  }

  console.log("\n=== RESULTS SUMMARY ===\n");

  for (const { strategyName, result, battleTimes, runTime } of results) {
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

    if (battleTimes.length > 0) {
      console.log(`  Battle Times:`);
      for (const battle of battleTimes) {
        if (battle.time !== null) {
          console.log(
            `    - ${battle.id}: ${battle.time}s (${formatGameTime(battle.time)})`,
          );
        } else {
          console.log(`    - ${battle.id}: (time not recorded)`);
        }
      }
    } else {
      console.log(`  Battle Times: No battles won`);
    }

    console.log("");
  }

  // Create a summary table
  console.log("=== BATTLE TIMES SUMMARY ===\n");
  console.log("Strategy | Age-2 Time | Battles Won | Battle Details");
  console.log("---------|------------|-------------|---------------");

  for (const { strategyName, result, battleTimes } of results) {
    const battleDetails = battleTimes
      .map((b) => (b.time !== null ? `${b.id}@${b.time}s` : `${b.id}@?`))
      .join(", ");
    console.log(
      `${strategyName.padEnd(9)} | ${String(result.gameTime).padEnd(10)} | ${String(result.finalState.defeatedEncounters.length).padEnd(11)} | ${battleDetails || "none"}`,
    );
  }
}

main();
