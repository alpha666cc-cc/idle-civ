// Quick wall-clock probe: one strategy for 1h of sim time, from the age2-start save.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toUrl = (p) => pathToFileURL(resolve(root, p)).href;
const simModule = await import(toUrl(resolve(root, "tools/simulation/simulation.js")));
const strategiesModule = await import(toUrl(resolve(root, "tools/simulation/strategies.js")));
const saveEntry = await import(toUrl(resolve(root, "tools/simulation/saveEntry.js")));

const entry = saveEntry.loadSaveEntry("saves/age2-start-26109.json");
const strategy = strategiesModule.strategyRegistry["balanced"];
if (!strategy) throw new Error("strategy not found");

const start = Date.now();
const sim = new simModule.GameSimulation(
  entry.state,
  strategy,
  {
    objective: { type: "timeLimit", seconds: 3600 },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: 3600,
    recordSnapshots: true,
    snapshotIntervalSeconds: 60,
    verbose: false,
    fromScratch: false,
  },
);
const result = sim.run();

console.log(
  `probe: 1h sim (strategy=balanced) wall ${((Date.now() - start) / 1000).toFixed(1)}s, sim ${(result.gameTime / 3600).toFixed(2)}h, battles ${result.finalState.defeatedEncounters.length}, age ${result.finalState.getCurrentAge()?.key}`,
);
