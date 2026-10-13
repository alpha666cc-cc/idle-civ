/**
 * CLI runner for multi-strategy comparison.
 * Usage: node tools/simulation/compare-strategies.mjs [options]
 *
 * Options:
 *   --strategies <names>     Comma-separated strategy names (default: all)
 *   --objective <type>       Objective type (buildingCount, ageReach, battleVictory, timeLimit)
 *   --target <value>         Target value for objective
 *   --building <key>         Building key for buildingCount objective
 *   --age <id>               Age ID for ageReach objective
 *   --battle <id>            Encounter ID for battleVictory objective
 *   --max-time <seconds>     Maximum simulation time (default: 3600)
 *   --actions-per-second <n> Strategy actions per simulated second (default: 5)
 *   --output <file>          Output file for results (JSON)
 *   --generations <number>  Number of evolutionary generations (default: 1)
 *   --top <number>           Top N strategies to keep per generation (default: 2)
 *   --no-snapshots           Disable snapshot recording
 *   --help                   Show this help
 */

import { formatExpoNumber } from "./simFormat.js";
import { ageDefinitions } from "../../src/game/ages.js";
import {
  compareStrategies,
  evolutionaryTournament,
  saveComparisonResults,
} from "./strategyComparison.js";
import { getStrategy, getStrategyNames } from "./strategies.js";
import { resolveAgeId } from "./simulation.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    strategies: null,
    objective: "timeLimit",
    target: "3600",
    building: null,
    age: null,
    battle: null,
    maxTime: "3600",
    actionsPerSecond: "5",
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
      case "--max-time":
        options.maxTime = args[++i];
        break;
      case "--actions-per-second":
        options.actionsPerSecond = args[++i];
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

Usage: node tools/simulation/compare-strategies.mjs [options]

Options:
  --strategies <names>     Comma-separated strategy names (default: all)
                          Available: ${getStrategyNames().join(", ")}
  --objective <type>       Objective type (default: timeLimit)
                          Available: buildingCount, ageReach, battleVictory, timeLimit
  --target <value>         Target value for objective (default: 3600)
  --building <key>         Building key for buildingCount objective
  --age <id>               Age ID for ageReach objective (e.g., age1; age-1 is accepted)
  --battle <id>            Encounter ID for battleVictory objective
  --max-time <seconds>     Maximum simulation time (default: 3600)
  --actions-per-second <n> Strategy actions per simulated second (default: 5)
  --output <file>          Output file for results (JSON)
  --generations <number>   Number of evolutionary generations (default: 1)
  --top <number>           Top N strategies to keep per generation (default: 2)
  --no-snapshots           Disable snapshot recording
  --help                   Show this help

Examples:
  # Compare all strategies for 1 hour
  node tools/simulation/compare-strategies.mjs --max-time 3600

  # Compare specific strategies to reach age1
  node tools/simulation/compare-strategies.mjs --strategies balanced,production --objective ageReach --age age1

  # Run evolutionary tournament for 5 generations
  node tools/simulation/compare-strategies.mjs --generations 5 --top 2 --max-time 1800

  # Compare strategies for building 5 farms
  node tools/simulation/compare-strategies.mjs --objective buildingCount --building farm --target 5
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
      const ageId = resolveAgeId(age);
      if (!ageId) {
        console.error(
          `Unknown age ID "${age}". Valid age IDs: ${ageDefinitions.map(({ key }) => key).join(", ")}`,
        );
        process.exit(1);
      }
      return {
        type: "ageReach",
        ageId,
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
  const actionsPerSecond = Number.parseInt(options.actionsPerSecond, 10);
  if (!Number.isInteger(actionsPerSecond) || actionsPerSecond < 1) {
    console.error("--actions-per-second must be a positive integer");
    process.exit(1);
  }
  const config = {
    objective,
    gatherClicksPerAction: 10,
    actionsPerSecond,
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
        `${index + 1}. ${metrics.strategyName}: Score ${formatExpoNumber(metrics.score)}, Population ${formatExpoNumber(metrics.finalPopulation)}, Buildings ${metrics.totalBuildings}, Battles ${metrics.battlesWon}`,
      );
    });

    console.log(
      `\nBest Strategy: ${result.bestStrategy.strategyName} (Score: ${formatExpoNumber(result.bestStrategy.score)})`,
    );
  } else {
    // Single generation comparison
    result = await compareStrategies(strategies, config);

    console.log("\n=== Strategy Ranking ===");
    result.ranking.forEach((metrics, index) => {
      console.log(
        `${index + 1}. ${metrics.strategyName}: Score ${formatExpoNumber(metrics.score)}, Population ${formatExpoNumber(metrics.finalPopulation)}, Buildings ${metrics.totalBuildings}, Battles ${metrics.battlesWon}`,
      );
    });

    console.log(
      `\nBest Strategy: ${result.bestStrategy.strategyName} (Score: ${formatExpoNumber(result.bestStrategy.score)})`,
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
