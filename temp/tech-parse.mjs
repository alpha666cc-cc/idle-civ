// Scratch: lenient-parse `temp/tech tree-v2-effects.json` and aggregate its
// effect taxonomy so the research converter can be authored precisely.
import fs from "node:fs";

const raw = fs.readFileSync("./temp/tech tree-v2-effects.json", "utf8");
// Fix missing commas between adjacent objects: `}\n      {` → `},\n      {`.
const fixed = raw.replace(/}\s*\n(\s*)\{/g, "},\n$1{");
let techs;
try {
  techs = JSON.parse(fixed);
} catch (error) {
  console.error("still invalid:", error.message);
  const where = /position (\d+)/.exec(error.message);
  if (where) {
    const line = fixed.slice(0, Number(where[1])).split("\n").length;
    console.error("near line", line);
    console.error(fixed.split("\n").slice(line - 3, line + 2).join("\n"));
  }
  process.exit(1);
}

console.log("techs =", techs.length);
const fields = new Map();
const types = new Map();
const byType = new Map();
const units = new Set();
for (const tech of techs) {
  for (const field of Object.keys(tech)) {
    fields.set(field, (fields.get(field) ?? 0) + 1);
  }
  for (const effect of tech.effects ?? []) {
    types.set(effect.type, (types.get(effect.type) ?? 0) + 1);
    const key = `${effect.type} | ${effect.target}`;
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  for (const unit of tech.unlockedUnits ?? []) units.add(unit);
}
console.log("--- fields ---");
for (const [field, count] of [...fields.entries()].sort()) {
  console.log(`${field}: ${count}`);
}
console.log("--- effect types ---");
for (const [type, count] of [...types.entries()].sort()) {
  console.log(`${type}: ${count}`);
}
console.log("--- distinct type|target pairs ---");
for (const [key, count] of [...byType.entries()].sort()) {
  console.log(`${key}: ${count}`);
}
console.log("--- unlockedUnits (across techs) ---");
console.log([...units].sort().join(", "));

// Values seen per type (small/medium/big distribution).
const valuesByType = new Map();
for (const tech of techs) {
  for (const effect of tech.effects ?? []) {
    const set = valuesByType.get(effect.type) ?? new Map();
    set.set(effect.value, (set.get(effect.value) ?? 0) + 1);
    valuesByType.set(effect.type, set);
  }
}
console.log("--- values per type ---");
for (const [type, values] of [...valuesByType.entries()].sort()) {
  console.log(`${type}: ${[...values.entries()].map(([v, c]) => `${v} x${c}`).join(", ")}`);
}

// Ages + categories for sanity.
const ages = new Map();
for (const tech of techs) {
  const bucket = ages.get(tech.age) ?? { count: 0, cats: new Map() };
  bucket.count += 1;
  bucket.cats.set(tech.category, (bucket.cats.get(tech.category) ?? 0) + 1);
  ages.set(tech.age, bucket);
}
console.log("--- ages ---");
for (const [age, bucket] of [...ages.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(
    `age ${age}: ${bucket.count} — ${[...bucket.cats.entries()].map(([c, n]) => `${c}:${n}`).join(", ")}`,
  );
}

// Prerequisite sanity: unknown prereq ids.
const ids = new Set(techs.map((tech) => tech.id));
const unknown = [];
for (const tech of techs) {
  for (const prerequisite of tech.prerequisites ?? []) {
    if (!ids.has(prerequisite)) unknown.push(`${tech.id} → ${prerequisite}`);
  }
}
console.log("--- unknown prerequisites ---");
console.log(unknown.length === 0 ? "(none)" : unknown.join("\n"));

// Distinct targets per type (the full conversion surface).
const targetsByType = new Map();
for (const tech of techs) {
  for (const effect of tech.effects ?? []) {
    const set = targetsByType.get(effect.type) ?? new Set();
    set.add(effect.target);
    targetsByType.set(effect.type, set);
  }
}
console.log("--- distinct targets per type ---");
for (const [type, targets] of [...targetsByType.entries()].sort()) {
  console.log(`${type}: ${[...targets].sort().join(", ")}`);
}
