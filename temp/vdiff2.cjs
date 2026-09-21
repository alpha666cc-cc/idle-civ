const fs = require("fs");
const fix = (s) =>
  s
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/}\s*\n(\s*){/g, "},\n$1{")
    .replace(/"\s*\n(\s*)"/g, '",\n$1"');
const load = (f) => JSON.parse(fix(fs.readFileSync(f, "utf8")));
const v3 = load("temp/tech tree-v3-effects.json");
// All distinct effect type/target/value vocab in v3 ages 0-1
const vocab = {};
for (const t of v3) {
  if (t.age !== 0 && t.age !== 1) continue;
  for (const e of t.effects || []) {
    const k = e.type + " | " + e.target + " | " + e.value;
    vocab[k] = (vocab[k] || 0) + 1;
  }
}
for (const k of Object.keys(vocab).sort()) console.log(vocab[k] + "x  " + k);
console.log("--- convert_unit full detail age 0-1 ---");
for (const t of v3) {
  if (t.age !== 0 && t.age !== 1) continue;
  for (const e of t.effects || []) {
    if (e.type === "convert_unit") console.log(t.id + ": " + JSON.stringify(e));
  }
  if (t.unitConversions) console.log(t.id + " unitConversions: " + JSON.stringify(t.unitConversions));
}
console.log("--- prereq changes v2->v3 ---");
const v2 = load("temp/tech tree-v2-effects.json");
const m2 = new Map(v2.map((t) => [t.id, t]));
const norm = (o) => JSON.stringify(o);
for (const t3 of v3) {
  const t2 = m2.get(t3.id);
  if (t2 && norm(t2.prerequisites) !== norm(t3.prerequisites)) {
    console.log(t3.id + ": " + norm(t2.prerequisites) + " -> " + norm(t3.prerequisites));
  }
}
