import {
  emptyResourceAmounts,
  emptyWorkerAssignments,
  emptyResourceFactors,
  type ResourceKey,
} from "../src/game/attributes";
import { CivilizationState } from "../src/game/civilizationState";
import { ExpNumber } from "../src/game/expNumber";
import { emptyStatistics } from "../src/game/statistics";
import { getAgeRouteGrowthAction, getStrategy } from "../tools/simulation/strategies";

const amounts = emptyResourceAmounts();
for (const [k, v] of Object.entries({ food: 1e6, wood: 1e6, stone: 1e6, gold: 1e6 })) {
  amounts[k as ResourceKey] = ExpNumber.fromNumber(v);
}
amounts.peopleCapacity = ExpNumber.fromNumber(90);

const workers = emptyWorkerAssignments();
workers.food = ExpNumber.fromNumber(9);
workers.wood = ExpNumber.fromNumber(1);

const state = new CivilizationState(
  amounts,
  workers,
  { townHall: 1, people: 90 },
  emptyResourceFactors(),
  {},
  0,
  [],
  [],
  [],
  [],
  emptyStatistics(),
  {},
);

console.log("pop:", state.population.toNumber(), "maxPop:", state.maximumPopulation.toNumber());
console.log("ageRoute:", getAgeRouteGrowthAction(state));
console.log("decide:", getStrategy("production")?.decideAction(state, { gameTime: 0, snapshots: [] }));
