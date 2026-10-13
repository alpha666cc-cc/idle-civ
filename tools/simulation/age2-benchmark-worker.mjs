/** Run one independent strategy simulation for the Age-2 benchmark. */
import { parentPort, workerData } from "node:worker_threads";
import { loadSaveData } from "../../src/game/saveSystem.js";
import { GameSimulation } from "./simulation.js";
import { getStrategy, setAdaptiveWorkerFunding } from "./strategies.js";

setAdaptiveWorkerFunding(
  workerData.adaptiveWorkerFundingEnabled,
  workerData.adaptiveWorkerFundingStrategies,
);

const strategy = getStrategy(workerData.strategyName);
if (!strategy) {
  throw new Error(`Unknown strategy: ${workerData.strategyName}`);
}

const initialState = loadSaveData(workerData.initialStateData);
const startedAt = Date.now();
const result = new GameSimulation(initialState, strategy, {
  objective: { type: "ageReach", ageId: "age2" },
  gatherClicksPerAction: 10,
  actionsPerSecond: 5,
  maxGameTime: workerData.maxTime,
  recordSnapshots: true,
  snapshotIntervalSeconds: 60,
  verbose: false,
  fromScratch: false,
}).run();
const runTime = Date.now() - startedAt;

const battleEvents = result.events.filter((event) => event.type === "battle");
const battleTimesFromSnapshots = [];
const startingBattleCount = initialState.defeatedEncounters.length;
let lastBattleCount = startingBattleCount;
for (const snapshot of result.snapshots) {
  if (snapshot.battlesWon > lastBattleCount) {
    const newBattles = snapshot.battlesWon - lastBattleCount;
    for (let index = 0; index < newBattles; index += 1) {
      battleTimesFromSnapshots.push({
        timestamp: snapshot.timestamp,
        battleCount: lastBattleCount + index + 1,
      });
    }
    lastBattleCount = snapshot.battlesWon;
  }
}

const battleTimes = result.finalState.defeatedEncounters.map(
  (encounterId, index) => {
    const event = battleEvents.find(({ id }) => id === encounterId);
    const snapshotTime =
      battleTimesFromSnapshots[index - startingBattleCount]?.timestamp;
    return {
      id: encounterId,
      time: event ? event.time : snapshotTime || null,
    };
  },
);

parentPort?.postMessage({
  strategyName: strategy.name,
  result: {
    success: result.success,
    objectiveReached: result.objectiveReached,
    gameTime: result.gameTime,
    terminationReason: result.terminationReason,
    finalAge: result.finalState.getCurrentAge()?.key || "unknown",
    population: result.finalState.population.toString(),
    battlesWon: result.finalState.defeatedEncounters.length,
    upgradesBought: result.finalState.boughtUpgrades.length,
    boughtUpgrades: result.finalState.boughtUpgrades,
  },
  battleTimes,
  runTime,
});
