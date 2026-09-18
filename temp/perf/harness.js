const { CivilizationState } = require("./civilizationState.js");
const { gamepedia } = require("./gamepedia.js");
const { findAchievementDefinition, chainFamilyForId } = require("./achievements.js");
const { emptyResourceAmounts } = require("./attributes.js");
const { ExpNumber } = require("./expNumber.js");

const makeState = (nBuildings) => {
  const resources = emptyResourceAmounts();
  resources.food = ExpNumber.fromNumber(1e30);
  resources.wood = ExpNumber.fromNumber(1e30);
  return new CivilizationState(resources, undefined, new Array(nBuildings).fill("farm"));
};
const time = (fn, runs) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / runs;
};

console.log("=== 1) avg tick (ms) vs building count ===");
for (const n of [10, 1000, 100000]) {
  let s = makeState(n);
  for (let i = 0; i < 5; i++) s = s.tick();
  const ms = time(() => { s = s.tick(); }, 200);
  console.log(`  buildings=${String(n).padStart(6)}  tick=${ms.toFixed(3)} ms  farmCount=${s.buildingCount("farm")}`);
}

console.log("=== 2) recompute only when something changed ===");
let s = makeState(1000).tick();
const a = s.activeBonuses();
const b = s.activeBonuses();
const c = s.tick().activeBonuses();
console.log("  repeat call same array:", a === b);
console.log("  survives tick (no source change):", a === c);
console.log(`  1e5 cached activeBonuses calls: ${time(() => s.activeBonuses(), 1e5).toFixed(4)} ms/call`);

console.log("=== 2.5) cache preserved on no-op tick (low resources, no achievements) ===");
let s2 = makeState(10);
const a2 = s2.activeBonuses();
const b2 = s2.activeBonuses();
const c2 = s2.tick().activeBonuses();
const d2 = s2.tick().activeBonuses();
console.log("  repeat call same array:", a2 === b2);
console.log("  survives 1 no-op tick:", a2 === c2);
console.log("  survives 2 no-op ticks:", a2 === d2);

console.log("=== 3) hoarder tiers aggregate into one bonus ===");
s = makeState(10).tick();
const earned = s.earnedAchievements.filter((id) => chainFamilyForId(id) === "food-hoarder");
let sum = ExpNumber.ZERO;
for (const id of earned) {
  for (const bn of findAchievementDefinition(id).bonuses) {
    if (bn.destination === "food" && bn.type === "attributeFlat") sum = sum.add(bn.value);
  }
}
console.log("  earned tiers:", earned.length, "->", earned.join(","));
const fh = s.activeBonuses().filter((e) => JSON.stringify(e).includes("food-hoarder"));
console.log("  bonus entries for family:", fh.length);
const e0 = fh[0];
const src = e0.sourceId ?? e0.source;
const val = (e0.bonus ?? e0).value;
console.log("  source:", src, " value:", val.toString());
console.log("  expected sum:", sum.toString(), " match:", typeof val.eq === "function" ? val.eq(sum) : val.toString() === sum.toString());

console.log("=== 4) gamepedia registers one aggregate record ===");
gamepedia.ensureAchievementEntry(findAchievementDefinition(earned[0]));
console.log("  aggregate record present:", gamepedia.get("food-hoarder-total") !== undefined);
console.log("  per-tier records present:", gamepedia.get("food-hoarder-e12") !== undefined);

console.log("=== 5) buildingCount direct cost ===");
s = makeState(100000);
s.buildingCount("farm");
console.log(`  1e6 buildingCount calls: ${time(() => s.buildingCount("farm"), 1e6).toFixed(4)} ms/call`);
