/**
 * CLI runner for game simulations.
 * Usage: node tools/run-simulation.mjs [options]
 *
 * Options:
 *   --strategy <name>      Strategy to use (cheapest, balanced, production, military, fast-age, economy, speedrun)
 *   --objective <type>     Objective type (buildingCount, ageReach, battleVictory, timeLimit)
 *   --target <value>       Target value for objective
 *   --building <key>       Building key for buildingCount objective
 *   --age <id>             Age ID for ageReach objective
 *   --battle <id>          Encounter ID for battleVictory objective
 *   --max-time <seconds>   Maximum simulation time (default: 3600)
 *   --snapshot-interval <s> Seconds between snapshots (default: 100)
 *   --actions-per-second <n> Strategy actions per simulated second (default: 5)
 *   --output <file>        Output file for results (JSON)
 *   --no-snapshots         Disable snapshot recording
 *   --save <path>          Start from a save file instead of a new game (e.g. saves/age1.json)
 *   --save-out <path>      Write the final state out as a save (.json/.xml/.b64)
 *   --help                 Show this help
 */

import { createSimulationRunner } from "./simulationRunner.js";
import { ageDefinitions } from "../src/game/ages.js";
import { formatExpoNumber } from "./simFormat.js";
import { getStrategy, getStrategyNames } from "./strategies.js";
import { GameSimulation, resolveAgeId } from "./simulation.js";
import {
  describeSaveEntry,
  loadSaveEntry,
  writeSaveEntry,
} from "./saveEntry.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    strategy: "balanced",
    objective: "timeLimit",
    target: "3600",
    building: null,
    age: null,
    battle: null,
    maxTime: "36000",
    snapshotInterval: "100",
    actionsPerSecond: "5",
    output: null,
    snapshots: true,
    verbose: false,
    save: null,
    saveOut: null,
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
      case "--max-time":
        options.maxTime = args[++i];
        break;
      case "--snapshot-interval":
        options.snapshotInterval = args[++i];
        break;
      case "--actions-per-second":
        options.actionsPerSecond = args[++i];
        break;
      case "--output":
        options.output = args[++i];
        break;
      case "--no-snapshots":
        options.snapshots = false;
        break;
      case "--save":
        options.save = args[++i];
        break;
      case "--save-out":
        options.saveOut = args[++i];
        break;
      case "--verbose":
        options.verbose = true;
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
  --age <id>             Age ID for ageReach objective (e.g., age1; age-1 is accepted)
  --battle <id>          Encounter ID for battleVictory objective
  --max-time <seconds>   Maximum simulation time (default: 3600)
  --snapshot-interval <s> Seconds between snapshots (default: 100)
  --actions-per-second <n> Strategy actions per simulated second (default: 5)
  --output <file>        Output file for results (JSON)
  --no-snapshots         Disable snapshot recording
  --save <path>          Start from a save file instead of a new game (e.g. saves/age1.json)
  --save-out <path>      Write the final state out as a save (.json/.xml/.b64)
  --verbose              Enable verbose debug output
  --help                 Show this help

Examples:
  # Run balanced strategy for 1 hour
  node tools/run-simulation.mjs --strategy balanced --max-time 3600

  # Run ROI-first speedrun strategy
  node tools/run-simulation.mjs --strategy speedrun --max-time 600

  # Reach age1 with production strategy
  node tools/run-simulation.mjs --strategy production --objective ageReach --age age1

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

/**
 * Render a game-second count as `1144s (19m 04s)` — the raw seconds *and* the
 * minutes/seconds breakdown together, so a reader never has to convert between
 * them. The old `1h 02m 03s` / `12m 03s` / `03s` switch was the confusion; hours
 * fold into the minutes here and the leading raw-second count keeps long runs exact.
 */
function formatGameTimeBoth(seconds) {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${total}s (${minutes}m ${String(secs).padStart(2, "0")}s)`;
}

/**
 * The labelled block [SNAPSHOT] and [EVENT] share, so an event reads exactly
 * like a snapshot: Time (dual format), Population, Resources, Production. Age
 * and Researches print only when the source carries them — snapshots do, events
 * do not — which is why the event skips them rather than reusing a fuller shape.
 * Snapshot-only fields (buildings, units, battles, timing) follow this call.
 */
function printSummaryBlock(data) {
  console.log(`  Time: ${formatGameTimeBoth(data.time ?? data.timestamp)}`);
  console.log(`  Age: ${data.age}`);
  console.log(`  Population: ${formatExpoNumber(data.population)}`);
  const researchList = data.researches?.length
    ? data.researches.join(", ")
    : "none";
  console.log(`  Researches: [${researchList}]`);
  const resourceList = Object.entries(data.resources ?? {})
    .map(([key, value]) => `${key}: ${formatExpoNumber(value)}`)
    .join(", ");
  console.log(`  Resources: { ${resourceList || "none"} }`);
  const productionList = Object.entries(data.productionRates ?? {})
    .map(([key, value]) => `${key}: ${formatExpoNumber(value)}/s`)
    .join(", ");
  console.log(`  Production: { ${productionList || "none"} }`);
  const buildingList = (data.buildings ?? [])
    .map((b) => `${b.building} x${b.count}`)
    .join(", ");
  console.log(`  Buildings: [${buildingList}] (${data.totalBuildings} total)`);
  const unitList = (data.units ?? [])
    .map((u) => `${u.unit} x${formatExpoNumber(u.count)}`)
    .join(", ");
  console.log(`  Units: [${unitList || "none"}]`);
  console.log(`  Battles Won: ${data.battlesWon}`);
  if (data.militaryPower) {
    console.log(`  Military Power: ${formatExpoNumber(data.militaryPower)}`);
  }
}

async function main() {
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

  const actionsPerSecond = Number.parseInt(options.actionsPerSecond, 10);
  if (!Number.isInteger(actionsPerSecond) || actionsPerSecond < 1) {
    console.error("--actions-per-second must be a positive integer");
    process.exit(1);
  }

  const snapshotInterval = Number.parseInt(options.snapshotInterval, 10);
  if (!Number.isInteger(snapshotInterval) || snapshotInterval < 1) {
    console.error("--snapshot-interval must be a positive integer");
    process.exit(1);
  }

  // Build config
  const config = {
    objective,
    gatherClicksPerAction: 10,
    actionsPerSecond,
    maxGameTime: parseInt(options.maxTime, 10),
    recordSnapshots: options.snapshots,
    snapshotIntervalSeconds: snapshotInterval,
    verbose: options.verbose,
    // A save is a mid-game state: the from-scratch prologue must not run.
    fromScratch: options.save === null,
    onEvent: (event) => {
      console.log(`\n[EVENT] ${event.type}: ${event.id}`);
      printSummaryBlock(event);
    },
    onSnapshot: (snapshot) => {
      const timing = snapshot.timing;
      // Periodic rows print "Snapshot N" on the interval grid (periodicIndex
      // counts periodic rows alone); milestones and the closing row get their
      // own label so an off-grid battle/age is no longer mistaken for a
      // mis-timed periodic snapshot.
      const label =
        snapshot.kind === "periodic"
          ? `Snapshot ${snapshot.periodicIndex + 1}`
          : snapshot.kind === "final"
            ? "Final state"
            : snapshot.kind === "age"
              ? `Age ${snapshot.milestoneId}`
              : `Battle ${snapshot.milestoneId}`;
      console.log(`\n[SNAPSHOT] ${label}:`);
      printSummaryBlock(snapshot);
      // The timing sampled at this instant, so a run that starts slowing down
      // shows it snapshot by snapshot rather than only in the end-of-run totals.
      console.log(
        `  Tick timing: ${timing.ticks} ticks, mean ${timing.tickMeanMs.toFixed(4)}ms, max ${timing.tickMaxMs.toFixed(4)}ms`,
      );
      console.log(
        `  Decision timing: ${timing.decisions} decisions, mean ${timing.decisionMeanMs.toFixed(4)}ms, max ${timing.decisionMaxMs.toFixed(4)}ms`,
      );
    },
  };

  // Resolve the entry state: a save when one is named, otherwise a new game.
  // A bad path or malformed document must stop the run, not quietly fall back
  // to a fresh civilization.
  let entry = null;
  if (options.save !== null) {
    try {
      entry = loadSaveEntry(options.save);
    } catch (error) {
      console.error(`Could not load the save: ${error.message}`);
      process.exit(1);
    }
  }

  console.log(`Starting simulation with strategy: ${strategy.name}`);
  console.log(`Objective: ${JSON.stringify(objective)}`);
  if (entry) console.log(describeSaveEntry(entry));
  console.log(
    `Config: ${JSON.stringify({ ...config, onEvent: undefined, onSnapshot: undefined }, null, 2)}`,
  );
  console.log("");

  const startTime = Date.now();
  const result = entry
    ? new GameSimulation(entry.state, strategy, config).run()
    : createSimulationRunner(strategy, config).run();
  const endTime = Date.now();

  console.log("");
  console.log("=== Simulation Results ===");
  console.log(`Success: ${result.success}`);
  console.log(`Objective Reached: ${result.objectiveReached}`);
  console.log(
    `Game Time: ${result.gameTime}s (${(result.gameTime / 60).toFixed(1)} minutes)`,
  );
  console.log(`Real Time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
  console.log(`Termination Reason: ${result.terminationReason}`);
  console.log(`Objective Met: ${result.objectiveMet || "None"}`);
  console.log(`Snapshots Recorded: ${result.snapshots.length}`);

  const finalProductionList = Object.entries(result.finalProductionRates ?? {})
    .map(([key, value]) => `${key}: ${formatExpoNumber(value)}/s`)
    .join(", ");
  console.log(`Final Production: { ${finalProductionList || "none"} }`);

  const tickTiming = result.tickTiming ?? {
    ticks: 0,
    totalMs: 0,
    meanMs: 0,
    maxMs: 0,
  };
  console.log("");
  console.log("=== Tick Timing ===");
  console.log(`  Ticks: ${tickTiming.ticks}`);
  console.log(`  Total: ${tickTiming.totalMs.toFixed(2)}ms`);
  console.log(`  Mean (avg/tick): ${tickTiming.meanMs.toFixed(4)}ms`);
  console.log(`  Max: ${tickTiming.maxMs.toFixed(2)}ms`);

  const decisionTiming = result.decisionTiming ?? {
    decisions: 0,
    totalMs: 0,
    meanMs: 0,
    maxMs: 0,
  };
  console.log("");
  console.log("=== Strategy Decision Timing ===");
  console.log(`  Decisions: ${decisionTiming.decisions}`);
  console.log(`  Total: ${decisionTiming.totalMs.toFixed(2)}ms`);
  console.log(`  Mean (avg/decision): ${decisionTiming.meanMs.toFixed(4)}ms`);
  console.log(`  Max: ${decisionTiming.maxMs.toFixed(2)}ms`);

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

  // Write the outcome back out as a real save so it can be opened in the game,
  // or fed straight back in as a later `--save`. Resuming a save and writing one
  // out keeps the same guid, so the pair is one continuous save-file.
  if (options.saveOut !== null) {
    try {
      const written = writeSaveEntry(
        options.saveOut,
        result.finalState,
        entry ? { from: entry } : {},
      );
      console.log(
        `\nSave written: ${written.path} (${written.format}, v${written.version}, guid ${written.guid})`,
      );
    } catch (error) {
      console.error(`Could not write the save: ${error.message}`);
      process.exit(1);
    }
  }

  process.exit(result.success ? 0 : 1);
}

(async () => {
  await main();
})();
