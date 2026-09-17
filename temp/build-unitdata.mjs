/**
 * Scratch generator for the battle milestone (temp/, never imported by src/).
 *
 * - normalizes temp/unit100-v3.json into src/game/data/units.json
 *   (`power` -> `attack`, costs kept as authored, one entry per line)
 * - reports the roster shape (ages, tags, domains, enemy-only units)
 * - validates that every unit id referenced by temp/campaign_v2.json exists
 *
 * Run: .\tools\node\node.exe temp\build-unitdata.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const units = JSON.parse(readFileSync("temp/unit100-v3.json", "utf8"));
const campaign = JSON.parse(readFileSync("temp/campaign_v2.json", "utf8"));

const normalized = units.map((unit) => ({
  id: unit.id,
  name: unit.name,
  age: unit.age,
  hp: unit.hp,
  attack: unit.power,
  armor: unit.armor,
  range: unit.range,
  speed: unit.speed,
  accuracy: unit.accuracy,
  domain: unit.domain,
  tags: unit.tags,
  canHit: unit.canHit,
  bonusVs: unit.bonusVs ?? [],
  locked: unit.locked,
  costs: (unit.costs ?? []).map(({ resource, base, factor }) => ({
    resource,
    base,
    factor,
  })),
}));

const byAge = new Map();
const tags = new Set();
const domains = new Set();
for (const unit of normalized) {
  byAge.set(unit.age, (byAge.get(unit.age) ?? 0) + 1);
  for (const tag of unit.tags) tags.add(tag);
  domains.add(unit.domain);
}
const enemyOnly = normalized.filter(({ costs }) => costs.length === 0);
const unlocked = normalized.filter(({ locked }) => !locked);

console.log("units:", normalized.length);
console.log("by age:", [...byAge.entries()].sort((a, b) => a[0] - b[0]));
console.log("tags:", [...tags].sort());
console.log("domains:", [...domains].sort());
console.log("unlocked at start:", unlocked.map(({ id }) => id));
console.log("enemy-only (no costs):", enemyOnly.map(({ id }) => id));
console.log(
  "cost resources:",
  [...new Set(normalized.flatMap(({ costs }) => costs.map(({ resource }) => resource)))].sort(),
);

const known = new Set(normalized.map(({ id }) => id));
const missing = new Set();
for (const battle of campaign) {
  for (const entry of [...(battle.enemyArmy ?? []), ...(battle.playerArmy ?? [])]) {
    if (!known.has(entry.id)) missing.add(`${battle.id}: ${entry.id}`);
  }
}
console.log("missing campaign unit ids:", [...missing]);

console.log("\n--- roster by age ---");
for (const age of [...byAge.keys()].sort((a, b) => a - b)) {
  const roster = normalized
    .filter((unit) => unit.age === age)
    .map(
      (unit) =>
        `${unit.id}${unit.costs.length === 0 ? "(enemy)" : ""}[${unit.tags.join(",")}/${unit.domain}]`,
    );
  console.log(`age ${age}: ${roster.join(" ")}`);
}

console.log("\n--- campaign v2 enemy armies ---");
for (const battle of campaign) {
  const enemies = (battle.enemyArmy ?? [])
    .map((entry) => `${entry.id}x${entry.count}`)
    .join(", ");
  console.log(
    `${battle.id} | age ${battle.age} | ${battle.year} | boss=${battle.isBoss} | ${enemies}`,
  );
}

console.log("\n--- campaign v2 descriptions ---");
for (const battle of campaign) {
  console.log(`${battle.id}: ${battle.description}`);
}

const ids = normalized.map(({ id }) => id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
console.log("duplicate ids:", duplicates);

writeFileSync(
  "src/game/data/units.json",
  `${JSON.stringify(normalized, null, 2)}\n`,
  "utf8",
);
console.log("wrote src/game/data/units.json");