/** Temporary stall diagnostic for the age-1 policy (scratch; deleted after use). */
import { GameSimulation, createInitialState } from "../tools/simulation/simulation.js";
import { AgeOnePolicy, defaultPolicy } from "../tools/simulation/age1-policy.js";

const policy = new AgeOnePolicy(defaultPolicy());
const counts = new Map<string, number>();

const realDecide = policy.decideAction.bind(policy);
policy.decideAction = (state, context) => {
  const action = realDecide(state, context);
  const key = action === null ? "null" : action.type;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return action;
};

const simulation = new GameSimulation(createInitialState(), policy, {
  seed: 42,
  objective: { type: "ageReach", ageId: "age1" },
  gatherClicksPerAction: 10,
  actionsPerSecond: 5,
  maxGameTime: 20000,
  recordSnapshots: true,
  snapshotIntervalSeconds: 600,
  onSnapshot: (snapshot) => {
    console.log(
      `t=${String(snapshot.timestamp).padStart(6)} pop=${String(snapshot.population).padStart(5)} buildings=${String(snapshot.totalBuildings).padStart(5)} battles=${snapshot.battlesWon} research=${snapshot.researches.length} army=${snapshot.militaryPower}`,
    );
  },
});

const result = simulation.run();
console.log("reached:", result.objectiveReached, "time:", result.gameTime);
console.log("action tally:", [...counts.entries()].sort((a, b) => b[1] - a[1]));