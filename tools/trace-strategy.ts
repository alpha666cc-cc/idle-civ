/**
 * Trace what a strategy actually decides, so a stall can be diagnosed instead of
 * guessed at. Replays the headless runner and tallies the action types it asked
 * for, plus the first N distinct actions, which is usually enough to see a
 * strategy looping on one purchase.
 *
 * Usage:
 *   tsx tools/trace-strategy.ts <strategy> [--seconds=600] [--show=40]
 */
import { GameSimulation, createInitialState } from "./simulation.js";
import {
  getAgeRouteGrowthAction,
  getStrategy,
} from "./strategies.js";
import { ExpNumber } from "../src/game/expNumber.js";

const flag = (name: string, fallback: string): string => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const name = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!name) {
  console.error("usage: tsx tools/trace-strategy.ts <strategy> [--seconds=600] [--show=40]");
  process.exit(1);
}
const seconds = Number(flag("seconds", "600"));
const show = Number(flag("show", "40"));
const base = getStrategy(name);
if (!base) {
  console.error(`unknown strategy: ${name}`);
  process.exit(1);
}

const counts = new Map<string, number>();
const shown: string[] = [];
const samples: string[] = [];
const probes: string[] = [];
let lastLabel = "";
let nextSample = 0;
let nextProbe = 0;

const label = (action: ReturnType<typeof base.decideAction>): string => {
  if (!action) return "null";
  switch (action.type) {
    case "build":
      return `build ${action.building} x${action.count}`;
    case "buyUnit":
      return `buyUnit ${action.unitId} x${action.count}`;
    case "buyResearch":
      return `buyResearch ${action.researchId}`;
    case "buyUpgrade":
      return `buyUpgrade ${action.upgradeId}`;
    case "assignWorker":
      return `assignWorker ${action.resource} x${action.count}`;
    case "unassignWorker":
      return `unassignWorker ${action.resource} x${action.count}`;
    case "gather":
      return `gather ${action.resource}`;
    case "launchBattle":
      return `launchBattle ${action.encounterId}`;
    case "enterAge":
      return `enterAge ${action.ageId}`;
    case "setTradeRoute":
      return `setTradeRoute ${action.resource} ${action.route.mode}`;
    case "wait":
      return "wait";
  }
};

const tracer = {
  name: base.name,
  description: base.description,
  decideAction: (
    state: Parameters<typeof base.decideAction>[0],
    context: Parameters<typeof base.decideAction>[1],
  ) => {
    const action = base.decideAction(state, context);
    const text = label(action);
    counts.set(text, (counts.get(text) ?? 0) + 1);
    // What did the mandatory route offer this tick, and what is the settlement
    // actually short of? Printed periodically so a stall is attributable to a
    // specific step rather than guessed at.
    if (context.gameTime >= nextProbe) {
      nextProbe = context.gameTime + 300;
      const nextBattle = state.getNextBattle();
      const owned = Object.entries(state.unitCounts)
        .filter(([, count]) => count.gt(ExpNumber.ZERO))
        .map(([key, count]) => `${key}x${count.toString()}`)
        .join(",");
      const costOf = (unitId: string) =>
        state
          .getUnitCost(unitId, 1)
          .map((cost) => `${cost.resource}=${cost.base.toString()}`)
          .join("|");
      const stock = (key: string) =>
        (state.resources as Record<string, ExpNumber | undefined>)[key]?.toString() ??
        "0";
      const outcome = nextBattle
        ? (state.simulateEncounter(nextBattle.key)?.outcome ?? "undef")
        : "-";
      probes.push(
        [
          `t=${context.gameTime}`,
          `route=${JSON.stringify(getAgeRouteGrowthAction(state))}`,
          `pop=${state.population.toNumber()}`,
          `cap=${state.maximumPopulation.toNumber()}`,
          `next=${nextBattle?.key ?? "none"}`,
          `sim=${outcome}`,
          `army=${state.getArmyPower().toString()}`,
          `owned=${owned}`,
          `warrior=${costOf("warrior")}`,
          `barracks=${state.getBuildingCount("barracks")}`,
          `military=${stock("military")}`,
          `milRate=${state.computeResourceRate("military").toString()}`,
        ].join(" "),
      );
    }
    if (context.gameTime >= nextSample) {
      nextSample = context.gameTime + 300;
      const citizen = state
        .getBuildingCost("people", state.getBuildingCount("people"), 1)
        .map((cost) => `${cost.resource}=${cost.base.toString()}`)
        .join("|");
      samples.push(
        `t=${String(context.gameTime).padStart(5)} pop=${String(state.population.toNumber()).padStart(5)} cap=${String(state.maximumPopulation.toNumber()).padStart(5)} food=${state.resources.food.toString().padEnd(9)} houses=${String(state.getBuildingCount("house")).padStart(4)} farms=${String(state.getBuildingCount("farm")).padStart(4)} nextCitizen=${citizen.padEnd(18)} canPeople=${state.canBuild("people")} peopleWhy=${state.getBuildFailureReason("people")} canHouse=${state.canBuild("house")} houseWhy=${state.getBuildFailureReason("house")}`,
      );
    }
    // Only log an action when the decision *changes*, so a stall shows as one
    // repeated line rather than thousands of identical ones.
    if (text !== lastLabel && shown.length < show) {
      shown.push(
        `t=${String(context.gameTime).padStart(5)}  ${text.padEnd(34)} pop=${state.population.toString().padEnd(8)} cap=${state.resources.peopleCapacity.toString().padEnd(8)} bld=${Object.values(state.builtBuildings).reduce((s, n) => s + (n ?? 0), 0)} food=${state.resources.food.toString()}`,
      );
      lastLabel = text;
    }
    return action;
  },
};

const result = new GameSimulation(createInitialState(), tracer, {
  seed: 42,
  objective: { type: "timeLimit", seconds },
  gatherClicksPerAction: 10,
  maxGameTime: seconds,
  recordSnapshots: false,
}).run();

const final = result.finalState;
console.log(`--- ${name}: first ${show} distinct decisions over ${seconds}s ---`);
for (const line of shown) console.log(line);
console.log(`\n--- action tally (${seconds}s) ---`);
[...counts.entries()]
  .sort((left, right) => right[1] - left[1])
  .slice(0, 18)
  .forEach(([text, count]) => console.log(`${String(count).padStart(7)}  ${text}`));
console.log(`\n--- state every 300s ---`);
for (const line of samples) console.log(line);
console.log(`\n--- mandatory steps consulted, every 300s ---`);
for (const line of probes) console.log(line);
console.log(`\nfinal: age=${final.getCurrentAge()?.key} pop=${final.population.toString()} battles=${final.defeatedEncounters.length} research=${final.boughtResearch.length} army=${final.getArmyPower().toString()}`);
