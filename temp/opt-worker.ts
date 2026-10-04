/**
 * Scratch worker: evaluate a batch of worker-ratio candidates for one strategy
 * and print `name\tindex\ttime` per line. Spawned by the coordinator; one
 * process per core.
 */
import { GameSimulation, createInitialState } from "../tools/simulation.js";
import { getStrategy } from "../tools/strategies.js";

type R = {
  food: number;
  wood: number;
  stone: number;
  gold: number;
  science: number;
};

const target = process.argv[2];
const batch: R[] = JSON.parse(process.argv[3]) as R[];

for (const [index, ratios] of batch.entries()) {
  const Parent = getStrategy(target)!.constructor as new () => unknown;
  class Tuned extends (Parent as new () => { getWorkerRatios?: () => R }) {
    protected getWorkerRatios(): R {
      return ratios;
    }
  }
  const res = new GameSimulation(createInitialState(), new Tuned() as never, {
    objective: { type: "ageReach", ageId: "age1" },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: 20000,
    recordSnapshots: false,
  }).run();
  const time = res.objectiveReached ? res.gameTime : 999999;
  console.log(`${target}\t${index}\t${time}`);
}