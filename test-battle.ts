import { CivilizationState } from "./src/game/civilizationState";
import { ExpNumber } from "./src/game/expNumber";

// Check if 8 warriors can win
let state = new CivilizationState();
const addResources = (s: CivilizationState) =>
  (s as any).withResources({
    ...s.resources,
    food: ExpNumber.fromNumber(999999),
    wood: ExpNumber.fromNumber(999999),
    stone: ExpNumber.fromNumber(999999),
    gold: ExpNumber.fromNumber(999999),
    military: ExpNumber.fromNumber(9999),
    science: ExpNumber.fromNumber(9999),
  });

state = addResources(state);
state = state.build("town-hall", 1);
for (let i = 0; i < 10; i++) {
  state = addResources(state);
  state = state.build("house", 1);
}
for (let i = 0; i < 90; i++) {
  state = addResources(state);
  state = state.build("people", 1);
}
state = addResources(state);
state = state.build("barracks", 1);
state = addResources(state);

for (let n = 1; n <= 15; n++) {
  state = addResources(state);
  state = state.buyUnit("warrior", 1);
  const battle = state.simulateEncounter("age0_1_first_fire");
  const cost1 = state.getUnitCost("warrior", 1);
  const militaryCost =
    cost1.find((c) => c.resource === "military")?.base.toString() ?? "?";
  const foodCost =
    cost1.find((c) => c.resource === "food")?.base.toString() ?? "?";
  console.log(
    `${n} warriors: battle=${battle?.outcome}, next warrior costs military=${militaryCost}, food=${foodCost}`,
  );
  if (battle?.outcome === "player") break;
}
