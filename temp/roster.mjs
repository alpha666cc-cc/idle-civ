import { readFileSync, writeFileSync } from "node:fs";

const units = JSON.parse(readFileSync("temp/unit100-v3.json", "utf8"));
const lines = units.map(
  (u) =>
    `age ${u.age} | ${u.id} | ${u.name} | ${u.domain} | ${u.tags.join(",")} | hp ${u.hp} atk ${u.power} arm ${u.armor} r ${u.range} spd ${u.speed} acc ${u.accuracy} | costs ${(u.costs ?? [])
      .map((c) => `${c.resource} ${c.base}`)
      .join(", ")}`,
);
writeFileSync("temp/roster.txt", `${lines.join("\n")}\n`, "utf8");
console.log(lines.join("\n"));