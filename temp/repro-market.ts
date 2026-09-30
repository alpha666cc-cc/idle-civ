import { loadSaveEntry } from "../tools/saveEntry.js";
import { buildingDefinitions } from "../src/game/buildings.js";

const entry = loadSaveEntry("saves/bug-but1e-14market.xml");
const state = entry.state;

let bad = 0;
for (const building of buildingDefinitions) {
  const count = state.getBuildingCount(building.key);
  const maxAffordable = state.getMaxAffordableBuildings(building.key);
  if (!Number.isInteger(count) || !Number.isInteger(maxAffordable)) {
    bad += 1;
    console.log(
      `STILL FRACTIONAL ${building.key}: count=${count} maxAffordable=${maxAffordable}`,
    );
  }
}
console.log(bad === 0 ? "PASS: every count and MAX is whole" : `FAIL: ${bad}`);

// The reported symptom: a full market must read as MAX 0, never a fraction.
console.log("market MAX =", state.getMaxAffordableBuildings("market"));
console.log("market at capacity =", state.isBuildingAtCapacity("market"));

// A fractional purchase must be refused, not written into the count.
const afterFraction = state.build("market", 5.68e-14);
console.log(
  "build(5.68e-14) is a no-op =",
  afterFraction === state,
  "| count still",
  afterFraction.getBuildingCount("market"),
);

// autoBuyBuildings() must not drift the count either.
const afterAuto = state.autoBuyBuildings();
console.log(
  "autoBuy is a no-op =",
  afterAuto === state,
  "| market count still",
  afterAuto.getBuildingCount("market"),
);

