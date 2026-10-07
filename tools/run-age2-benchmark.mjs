/** Run the Age-1-to-Age-2 strategy sweep with one worker thread per strategy. */

import { Worker } from "node:worker_threads";
import { GameSimulation, createInitialState } from "./simulation.js";
import { createSaveData } from "../src/game/saveSystem.js";
import {
  ADAPTIVE_WORKER_FUNDING_ENABLED,
  ADAPTIVE_WORKER_FUNDING_STRATEGIES,
  getStrategy,
} from "./strategies.js";

const maxTimeArgument = process.argv.find((argument) =>
  argument.startsWith("--max-time="),
);
const MAX_TIME = Number(maxTimeArgument?.slice("--max-time=".length) ?? 18000);
const OBJECTIVE = { type: "ageReach", ageId: "age2" };
const strategyNames = [
  "cheapest",
  "balanced",
  "production",
  "military",
  "fast-age",
  "economy",
  "research",
  "player",
  "speedrun",
  "trader",
];

if (!Number.isFinite(MAX_TIME) || MAX_TIME <= 0) {
  throw new Error("--max-time must be a positive number of seconds");
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

const workerExecArgv = () => {
  const args = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const argument = process.execArgv[index];
    if (argument === "--eval" || argument === "-e") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--eval=")) continue;
    args.push(argument);
  }
  return args;
};

const runStrategyWorker = (strategyName, initialStateData) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./age2-benchmark-worker.mjs", import.meta.url),
      {
        workerData: {
          strategyName,
          initialStateData,
          maxTime: MAX_TIME,
          adaptiveWorkerFundingEnabled: ADAPTIVE_WORKER_FUNDING_ENABLED,
          adaptiveWorkerFundingStrategies: [
            ...ADAPTIVE_WORKER_FUNDING_STRATEGIES,
          ],
        },
        execArgv: workerExecArgv(),
      },
    );
    let result;
    worker.on("message", (message) => {
      result = message;
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${strategyName} worker exited with code ${code}`));
      } else if (!result) {
        reject(new Error(`${strategyName} worker exited without a result`));
      } else {
        resolve(result);
      }
    });
  });

async function main() {
  console.log("=== Running all 10 strategies from age1 to age2 ===");
  console.log(`Objective: Reach age2`);
  console.log(`Max time: ${MAX_TIME}s (${formatGameTime(MAX_TIME)})`);
  console.log("");

  // Create age1 starting state
  console.log("Creating age1 starting state using balanced strategy...");
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
    getStrategy("balanced"),
    age1Config,
  );
  const age1Result = age1Sim.run();
  console.log(`Age1 state created at ${age1Result.gameTime}s`);
  console.log("");

  const initialStateData = createSaveData(
    age1Result.finalState,
    "age2-benchmark",
    0,
  );
  console.log(`Starting ${strategyNames.length} strategy workers...`);
  const results = await Promise.all(
    strategyNames.map((strategyName) =>
      runStrategyWorker(strategyName, initialStateData),
    ),
  );

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
    console.log(`  Final Age: ${result.finalAge}`);
    console.log(`  Final Population: ${result.population}`);
    console.log(`  Battles Won: ${result.battlesWon}`);
    console.log(`  Upgrades Bought: ${result.upgradesBought}`);
    const wonderUpgrade = result.boughtUpgrades.find((upgrade) =>
      upgrade.includes("wonder"),
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
      `${strategyName.padEnd(9)} | ${String(result.gameTime).padEnd(10)} | ${String(result.objectiveReached).padEnd(7)} | ${result.battlesWon}`,
    );
  }
}

main();
