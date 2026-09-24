const cp = require("child_process");
const fs = require("fs");
const oldRaw = cp
  .execSync("git show HEAD:src/game/data/research.json", {
    maxBuffer: 100 * 1024 * 1024,
  })
  .toString();
const oldData = JSON.parse(oldRaw);
const newData = JSON.parse(fs.readFileSync("src/game/data/research.json", "utf8"));
const oldByKey = new Map(oldData.map((t) => [t.key, t]));
const norm = (o) => JSON.stringify(o);
let changedCount = 0;
for (const t of newData) {
  const old = oldByKey.get(t.key);
  if (!old) {
    console.log("NEW ENTRY: " + t.key);
    changedCount++;
    continue;
  }
  const strip = ({ guid: _guid, ...rest }) => rest;
  if (norm(strip(old)) !== norm(strip(t))) {
    changedCount++;
    const fields = [];
    for (const f of ["description", "prerequisites", "costs", "bonuses", "unlocks", "conversions", "ignored", "name", "age", "category"]) {
      if (norm(old[f]) !== norm(t[f])) fields.push(f);
    }
    console.log("CHANGED: " + t.key + " [" + fields.join(", ") + "]");
    for (const f of fields) {
      if (f === "bonuses" || f === "costs") {
        console.log("  old " + f + ": " + norm(old[f]).slice(0, 400));
        console.log("  new " + f + ": " + norm(t[f]).slice(0, 400));
      } else {
        console.log("  old " + f + ": " + norm(old[f]));
        console.log("  new " + f + ": " + norm(t[f]));
      }
    }
    // cost check
    if (norm(old.costs) !== norm(t.costs)) console.log("  !!! COST CHANGED !!!");
  }
}
console.log("TOTAL CHANGED=" + changedCount + " of " + newData.length);
// order check
const oldOrder = oldData.map((t) => t.key).join(",");
const newOrder = newData.map((t) => t.key).join(",");
console.log("ORDER IDENTICAL: " + (oldOrder === newOrder));
