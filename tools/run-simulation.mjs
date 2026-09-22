/**
 * CLI runner for game simulations.
 * Usage: node tools/run-simulation.mjs [options]
 * 
 * Options:
 *   --strategy <name>      Strategy to use (balanced, production, military, fast-age, economy)
 *   --objective <type>     Objective type (buildingCount, ageReach, battleVictory, timeLimit)
 *   --target <value>       Target value for objective
 *   --building <key>       Building key for buildingCount objective
 *   --age <id>             Age ID for ageReach objective  
 *   --battle <id>          Encounter ID for battleVictory objective
 *   --actions <rate>       Actions per second (default: 10)
 *   --skip <seconds>       Skip interval in seconds (default: 60)
 *   --max-time <seconds>   Maximum simulation time (default: 3600)
 *   --seed <number>        Random seed (default: 42)
 *   --output <file>        Output file for results (JSON)
 *   --no-snapshots         Disable snapshot recording
 *   --help                 Show this help
 */

import { createSimulationRunner } from "./simulationRunner.js";
import { getStrategy, getStrategyNames } from "./strategies.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    strategy: "balanced",
    objective: "timeLimit",
    target: "3600",
    building: null,
    age: null,
    battle: null,
    actions: "10",
    skip: "60",
    maxTime: "3600",
    seed: "42",
    output: null,
    snapshots: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--strategy":
        options.strategy = args[++i];
        break;
      case "--objective":
        options.objective = args[++i];
        break;
      case "--target":
        options.target = args[++i];
        break;
      case "--building":
        options.building = args[++i];
        break;
      case "--age":
        options.age = args[++i];
        break;
      case "--battle":
        options.battle = args[++i];
        break;
      case "--actions":
        options.actions = args[++i];
        break;
      case "--skip":
        options.skip = args[++i];
        break;
      case "--max-time":
        options.maxTime = args[++i];
        break;
      case "--seed":
        options.seed = args[++i];
        break;
      case "--output":
        options.output = args[++i];
        break;
      case "--no-snapshots":
        options.snapshots = false;
        break;
      case "--help":
        showHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        showHelp();
        process.exit(1);
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Game Simulation Runner
======================

Usage: node tools/run-simulation.mjs [options]

Options:
  --strategy <name>      Strategy to use (default: balanced)
                         Available: ${getStrategyNames().join(", ")}
  --objective <type>     Objective type (default: timeLimit)
                         Available: buildingCount, ageReach, battleVictory, timeLimit
  --target <value>       Target value for objective (default: 3600)
  --building <key>       Building key for buildingCount objective
  --age <id>             Age ID for ageReach objective (e.g., age-1)
  --battle <id>          Encounter ID for battleVictory objective
  --actions <rate>       Actions per second (default: 10)
  --skip <seconds>       Skip interval in seconds (default: 60)
  --max-time <seconds>   Maximum simulation time (default: 3600)
  --seed <number>        Random seed (default: 42)
  --output <file>        Output file for results (JSON)
  --no-snapshots         Disable snapshot recording
  --help                 Show this help

Examples:
  # Run balanced strategy for 1 hour
  node tools/run-simulation.mjs --strategy balanced --max-time 3600

  # Reach age-1 with production strategy
  node tools/run-simulation.mjs --strategy production --objective ageReach --age age-1

  # Build 5 farms with military strategy
  node tools/run-simulation.mjs --strategy military --objective buildingCount --building farm --target 5

  # Win first battle with fast-age strategy
  node tools/run-simulation.mjs --strategy fast-age --objective battleVictory --battle age0_1_first_fire
`);
}

function buildObjective(options) {
  const { objective, target, building, age, battle } = options;

  switch (objective) {
    case "buildingCount":
      if (!building) {
        console.error("--building required for buildingCount objective");
        process.exit(1);
      }
      return {
        type: "buildingCount",
        building,
        target: parseInt(target, 10),
      };
    case "ageReach":
      if (!age) {
        console.error("--age required for ageReach objective");
        process.exit(1);
      }
      return {
        type: "ageReach",
        ageId: age,
      };
    case "battleVictory":
      if (!battle) {
        console.error("--battle required for battleVictory objective");
        process.exit(1);
      }
      return {
        type: "battleVictory",
        encounterId: battle,
      };
    case "timeLimit":
      return {
        type: "timeLimit",
        seconds: parseInt(target, 10),
      };
    default:
      console.error(`Unknown objective type: ${objective}`);
      process.exit(1);
  }
}

function main() {
  const options = parseArgs();
  
  // Validate strategy
  const strategy = getStrategy(options.strategy);
  if (!strategy) {
    console.error(`Unknown strategy: ${options.strategy}`);
    console.error(`Available strategies: ${getStrategyNames().join(", ")}`);
    process.exit(1);
  }

  // Build objective
  const objective = buildObjective(options);

  // Build config
  const config = {
    seed: parseInt(options.seed, 10),
    objective,
    actionRate: parseInt(options.actions, 10),
    skipInterval: parseInt(options.skip, 10),
    maxGameTime: parseInt(options.maxTime, 10),
    recordSnapshots: options.snapshots,
  };

  console.log(`Starting simulation with strategy: ${strategy.name}`);
  console.log(`Objective: ${JSON.stringify(objective)}`);
  console.log(`Config: ${JSON.stringify(config, null, 2)}`);
  console.log("");

  const startTime = Date.now();
  const runner = createSimulationRunner(strategy, config);
  const result = runner.run();
  const endTime = Date.now();

  console.log("");
  console.log("=== Simulation Results ===");
  console.log(`Success: ${result.success}`);
  console.log(`Objective Reached: ${result.objectiveReached}`);
  console.log(`Game Time: ${result.gameTime}s (${(result.gameTime / 60).toFixed(1)} minutes)`);
  console.log(`Real Time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
  console.log(`Termination Reason: ${result.terminationReason}`);
  console.log(`Objective Met: ${result.objectiveMet || "None"}`);
  console.log(`Snapshots Recorded: ${result.snapshots.length}`);

  if (result.snapshots.length > 0) {
    console.log("");
    console.log("=== Milestone Snapshots ===");
    result.snapshots.forEach((snapshot, index) => {
      console.log(`Snapshot ${index + 1}:`);
      console.log(`  Time: ${snapshot.timestamp}s`);
      console.log(`  Age: ${snapshot.age}`);
      console.log(`  Population: ${snapshot.population}`);
      console.log(`  Buildings: ${snapshot.totalBuildings}`);
      console.log(`  Battles Won: ${snapshot.battlesWon}`);
      if (snapshot.militaryPower) {
        console.log(`  Military Power: ${snapshot.militaryPower}`);
      }
    });
  }

  // Output to file if requested
  if (options.output) {
    const fs = await import("fs");
    const outputData = {
      strategy: strategy.name,
      config,
      result: {
        ...result,
        finalState: null, // Don't serialize full state
      },
      runTime: endTime - startTime,
    };
    fs.writeFileSync(options.output, JSON.stringify(outputData, null, 2));
    console.log(`Results written to ${options.output}`);
  }

  process.exit(result.success ? 0 : 1);
}

main();
