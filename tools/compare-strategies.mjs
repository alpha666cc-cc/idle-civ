/**
 * CLI runner for multi-strategy comparison.
 * Usage: node tools/compare-strategies.mjs [options]
 *
 * Options:
 *   --strategies <names>     Comma-separated strategy names (default: all)
 *   --objective <type>       Objective type (buildingCount, ageReach, battleVictory, timeLimit)
 *   --target <value>         Target value for objective
 *   --building <key>         Building key for buildingCount objective
 *   --age <id>               Age ID for ageReach objective
 *   --battle <id>            Encounter ID for battleVictory objective
 *   --actions <rate>         Actions per second (default: 10)
 *   --skip <seconds>         Skip interval in seconds (default: 60)
 *   --max-time <seconds>     Maximum simulation time (default: 3600)
 *   --seed <number>          Random seed (default: 42)
 *   --output <file>          Output file for results (JSON)
 *   --generations <number>  Number of evolutionary generations (default: 1)
 *   --top <number>           Top N strategies to keep per generation (default: 2)
 *   --no-snapshots           Disable snapshot recording
 *   --help                   Show this help
 */

import {
  compareStrategies,
  evolutionaryTournament,
  saveComparisonResults,
} from "./strategyComparison.js";
import { getStrategy, getStrategyNames } from "./strategies.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    strategies: null,
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
    generations: "1",
    top: "2",
    snapshots: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--strategies":
        options.strategies = args[++i].split(",");
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
      case "--generations":
        options.generations = args[++i];
        break;
      case "--top":
        options.top = args[++i];
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
Strategy Comparison Runner
==========================

Usage: node tools/compare-strategies.mjs [options]

Options:
  --strategies <names>     Comma-separated strategy names (default: all)
                          Available: ${getStrategyNames().join(", ")}
  --objective <type>       Objective type (default: timeLimit)
                          Available: buildingCount, ageReach, battleVictory, timeLimit
  --target <value>         Target value for objective (default: 3600)
  --building <key>         Building key for buildingCount objective
  --age <id>               Age ID for ageReach objective (e.g., age-1)
  --battle <id>            Encounter ID for battleVictory objective
  --actions <rate>         Actions per second (default: 10)
  --skip <seconds>         Skip interval in seconds (default: 60)
  --max-time <seconds>     Maximum simulation time (default: 3600)
  --seed <number>          Random seed (default: 42)
  --output <file>          Output file for results (JSON)
  --generations <number>   Number of evolutionary generations (default: 1)
  --top <number>           Top N strategies to keep per generation (default: 2)
  --no-snapshots           Disable snapshot recording
  --help                   Show this help

Examples:
  # Compare all strategies for 1 hour
  node tools/compare-strategies.mjs --max-time 3600

  # Compare specific strategies to reach age-1
  node tools/compare-strategies.mjs --strategies balanced,production --objective ageReach --age age-1

  # Run evolutionary tournament for 5 generations
  node tools/compare-strategies.mjs --generations 5 --top 2 --max-time 1800

  # Compare strategies for building 5 farms
  node tools/compare-strategies.mjs --objective buildingCount --building farm --target 5
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

async function main() {
  const options = parseArgs();

  // Get strategies to compare
  const strategyNames = options.strategies || getStrategyNames();
  const strategies = strategyNames
    .map((name) => getStrategy(name))
    .filter((s) => s !== undefined);

  if (strategies.length === 0) {
    console.error("No valid strategies found");
    process.exit(1);
  }

  console.log(
    `Comparing ${strategies.length} strategies: ${strategies.map((s) => s.name).join(", ")}`,
  );

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

  console.log(`Objective: ${JSON.stringify(objective)}`);
  console.log(`Config: ${JSON.stringify(config, null, 2)}`);
  console.log("");

  const startTime = Date.now();
  let result;

  const generations = parseInt(options.generations, 10);
  if (generations > 1) {
    // Run evolutionary tournament
    const topN = parseInt(options.top, 10);
    console.log(
      `Running evolutionary tournament (${generations} generations, top ${topN})...`,
    );
    result = await evolutionaryTournament(
      strategies,
      config,
      generations,
      topN,
    );

    console.log("\n=== Final Ranking ===");
    result.finalRanking.forEach((metrics, index) => {
      console.log(
        `${index + 1}. ${metrics.strategyName}: Score ${metrics.score.toFixed(0)}, Population ${metrics.finalPopulation}, Buildings ${metrics.totalBuildings}, Battles ${metrics.battlesWon}`,
      );
    });

    console.log(
      `\nBest Strategy: ${result.bestStrategy.strategyName} (Score: ${result.bestStrategy.score.toFixed(0)})`,
    );
  } else {
    // Single generation comparison
    result = await compareStrategies(strategies, config);

    console.log("\n=== Strategy Ranking ===");
    result.ranking.forEach((metrics, index) => {
      console.log(
        `${index + 1}. ${metrics.strategyName}: Score ${metrics.score.toFixed(0)}, Population ${metrics.finalPopulation}, Buildings ${metrics.totalBuildings}, Battles ${metrics.battlesWon}`,
      );
    });

    console.log(
      `\nBest Strategy: ${result.bestStrategy.strategyName} (Score: ${result.bestStrategy.score.toFixed(0)})`,
    );
  }

  const endTime = Date.now();
  console.log(
    `\nTotal Real Time: ${((endTime - startTime) / 1000).toFixed(2)}s`,
  );

  // Output to file if requested
  if (options.output) {
    const finalResult =
      generations > 1 ? result.history[result.history.length - 1] : result;
    await saveComparisonResults(finalResult, options.output);
  }

  process.exit(0);
}

main();
