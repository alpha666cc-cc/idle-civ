/**
 * Simple benchmark for age1->age2 in 40 minutes
 */

import { GameSimulation, createInitialState } from "./simulation.js";
import { formatExpoNumber } from "./simFormat.js";
import {
  CheapestStrategy,
  BalancedStrategy,
  ProductionStrategy,
  MilitaryStrategy,
  FastAgeStrategy,
  EconomyStrategy,
  ResearchStrategy,
  PlayerStrategy,
  SpeedrunStrategy,
  TradeStrategy,
} from "./strategies.js";

const MAX_TIME = 7200; // 2 hours
const OBJECTIVE = { type: "ageReach", ageId: "age2" };

const strategies = [
  new CheapestStrategy(),
  new BalancedStrategy(),
  new ProductionStrategy(),
  new MilitaryStrategy(),
  new FastAgeStrategy(),
  new EconomyStrategy(),
  new ResearchStrategy(),
  new PlayerStrategy(),
  new SpeedrunStrategy(),
  new TradeStrategy(),
];

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

function runStrategy(strategy, initialState) {
  const config = {
    objective: OBJECTIVE,
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: MAX_TIME,
    recordSnapshots: true,
    snapshotIntervalSeconds: 60,
    verbose: false,
    fromScratch: false,
  };

  console.log(`Running strategy: ${strategy.name}...`);
  const startTime = Date.now();

  const simulation = new GameSimulation(initialState, strategy, config);
  const result = simulation.run();

  const endTime = Date.now();

  const battleEvents = result.events.filter((e) => e.type === "battle");

  const battleTimesFromSnapshots = [];
  let lastBattleCount = 0;
  for (const snapshot of result.snapshots) {
    if (snapshot.battlesWon > lastBattleCount) {
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

  const battleTimes = result.finalState.defeatedEncounters.map(
    (encounterId, index) => {
      const event = battleEvents.find((e) => e.id === encounterId);
      const snapshotTime = battleTimesFromSnapshots[index]?.timestamp;
      return {
        id: encounterId,
        time: event ? event.time : snapshotTime || null,
      };
    },
  );

  return {
    strategyName: strategy.name,
    result,
    battleTimes,
    runTime: endTime - startTime,
  };
}

function main() {
  console.log("=== Running all 10 strategies from age1 to age2 ===");
  console.log(`Objective: Reach age2`);
  console.log(`Max time: ${MAX_TIME}s (${formatGameTime(MAX_TIME)}) - 2 hours`);
  console.log("");

  // Create age1 starting state
  console.log("Creating age1 starting state using balanced strategy...");
  const balancedStrategy = new BalancedStrategy();
  const age1Config = {
    objective: { type: "ageReach", ageId: "age1" },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: 3600,
    recordSnapshots: false,
    verbose: false,
  };

  const initialState = createInitialState();
  const age1Sim = new GameSimulation(
    initialState,
    balancedStrategy,
    age1Config,
  );
  const age1Result = age1Sim.run();
  console.log(`Age1 state created at ${age1Result.gameTime}s`);
  console.log("");

  const results = [];

  for (const strategy of strategies) {
    const runResult = runStrategy(strategy, age1Result.finalState);
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
    console.log(
      `  Upgrades Bought: ${result.finalState.boughtUpgrades.length}`,
    );
    const wonderUpgrade = result.finalState.boughtUpgrades.find((u) =>
      u.includes("wonder"),
    );
    console.log(
      `  Great Monument (5000 pop): ${wonderUpgrade ? "BOUGHT" : "NOT BOUGHT"}`,
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

  console.log("=== SUMMARY TABLE ===\n");
  console.log("Strategy | Age-2 Time | Success | Battles Won");
  console.log("---------|------------|---------|-------------");

  for (const { strategyName, result } of results) {
    console.log(
      `${strategyName.padEnd(9)} | ${String(result.gameTime).padEnd(10)} | ${String(result.objectiveReached).padEnd(7)} | ${result.finalState.defeatedEncounters.length}`,
    );
  }
}

main();
