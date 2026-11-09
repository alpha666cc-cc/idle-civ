import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const savesDirectory = path.join(root, "saves");
const battleLogDirectory = path.join(savesDirectory, "auto", "battle");
const outputFile = path.join(root, "src", "game", "data", "battleSeeds.json");
const encountersFile = path.join(
  root,
  "src",
  "game",
  "data",
  "encounters.json",
);
const checkpointName =
  /(?:^|[^a-z0-9])b(?:8|9|10|11|12)(?:[^0-9]|$)|age[\s_-]*(?:end|start)/i;
const validFormations = new Set([
  "standard",
  "frontline",
  "backline",
  "rush",
  "turtle",
  "skirmish",
  "shield_wall",
  "pike_square",
]);
const validOrders = new Set([
  "standard",
  "focus_weak",
  "focus_strong",
  "focus_counter",
  "same_tag",
  "protect_ranged",
]);
const maxSeedsPerBattle = 8;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const positiveCount = (value) => {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    return false;
  }
  const mantissa = Number(value.split(/[eE]/)[0]);
  return Number.isFinite(mantissa) && mantissa > 0;
};

const normalizeArmy = (
  entries,
  battleAge,
  formations = {},
  orders = {},
) => {
  if (!Array.isArray(entries)) return undefined;
  const army = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return undefined;
    const unitId = entry.unitId ?? entry.unit;
    const count = entry.count;
    const formation =
      battleAge < 2
        ? "standard"
        : formations[unitId] ?? entry.formation ?? "standard";
    const order =
      battleAge < 3 ? "standard" : orders[unitId] ?? entry.order ?? "standard";
    if (
      typeof unitId !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(unitId) ||
      !positiveCount(count) ||
      !validFormations.has(formation) ||
      !validOrders.has(order)
    ) {
      return undefined;
    }
    army.push({ unitId, count, formation, order });
  }
  return army.length > 0 ? army : undefined;
};

const encounterData = JSON.parse(await readFile(encountersFile, "utf8"));
const encounterAges = new Map(
  encounterData.map(({ key, age }) => [key, age]),
);

const listFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => listFiles(path.join(directory, entry.name))),
  );
  return [
    ...entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(directory, entry.name)),
    ...nested.flat(),
  ];
};

const battleSeeds = new Map();
const signaturesByBattle = new Map();

const addSeed = (battleId, source, playerArmy) => {
  if (!Array.isArray(playerArmy) || playerArmy.length === 0) return;
  const seeds = battleSeeds.get(battleId) ?? [];
  const signatures = signaturesByBattle.get(battleId) ?? new Set();
  const signature = JSON.stringify(playerArmy);
  if (signatures.has(signature)) return;
  signatures.add(signature);
  signaturesByBattle.set(battleId, signatures);
  seeds.push({ source, playerArmy });
  battleSeeds.set(battleId, seeds);
};

const checkpointFiles = (await listFiles(savesDirectory))
  .filter(
    (file) =>
      file.endsWith(".json") &&
      checkpointName.test(path.basename(file)) &&
      !file.startsWith(path.join(root, "src", "game", "data") + path.sep),
  )
  .sort((left, right) => {
    const rank = (file) =>
      Number(path.basename(file).match(/b(8|9|10|11|12)/i)?.[1] ?? 0);
    return rank(right) - rank(left) || right.localeCompare(left);
  });

for (const file of checkpointFiles) {
  try {
    const save = JSON.parse(await readFile(file, "utf8"));
    if (
      !isRecord(save) ||
      !Array.isArray(save.defeatedEncounters) ||
      !isRecord(save.unitCounts)
    ) {
      continue;
    }
    const battleId = save.defeatedEncounters.at(-1);
    const battleAge = encounterAges.get(battleId);
    if (typeof battleId !== "string" || typeof battleAge !== "number") continue;
    const events = isRecord(save.devLog) && Array.isArray(save.devLog.events)
      ? save.devLog.events
      : [];
    const battleEvent = [...events].reverse().find(
      (event) =>
        isRecord(event) &&
        event.type === "battle" &&
        event.id === battleId &&
        Array.isArray(event.units),
    );
    const entries =
      isRecord(battleEvent) && Array.isArray(battleEvent.units)
        ? battleEvent.units
        : Object.entries(save.unitCounts).map(([unitId, count]) => ({
            unitId,
            count,
          }));
    const army = normalizeArmy(
      entries,
      battleAge,
      isRecord(save.unitFormations) ? save.unitFormations : {},
      isRecord(save.unitOrders) ? save.unitOrders : {},
    );
    addSeed(battleId, `checkpoint:${path.basename(file)}`, army);
  } catch (error) {
    console.warn(
      `[battle seeds] skipped checkpoint ${path.basename(file)}: ${error.message}`,
    );
  }
}

const battleLogEntries = await readdir(battleLogDirectory, {
  withFileTypes: true,
}).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
const battleLogs = battleLogEntries
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.startsWith("battle-debug-") &&
      entry.name.endsWith(".json"),
  )
  .map(({ name }) => name)
  .sort()
  .reverse();

for (const name of battleLogs) {
  try {
    const record = JSON.parse(
      await readFile(path.join(battleLogDirectory, name), "utf8"),
    );
    if (
      !isRecord(record) ||
      record.outcome !== "player" ||
      !isRecord(record.setup) ||
      record.setup.schemaVersion !== 1
    ) {
      continue;
    }
    const battleId = name.match(
      /^battle-debug-(.+)-\d{4}-\d{2}-\d{2}T/,
    )?.[1];
    const battleAge = encounterAges.get(battleId);
    if (!battleId || typeof battleAge !== "number") continue;
    const army = normalizeArmy(record.setup.playerArmy, battleAge);
    addSeed(battleId, `battle-log:${name}`, army);
  } catch (error) {
    console.warn(`[battle seeds] skipped log ${name}: ${error.message}`);
  }
}

const seeds = [...battleSeeds.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .flatMap(([battleId, entries]) => {
    const prioritized = [...entries]
      .sort(
        (left, right) =>
          Number(right.source.startsWith("battle-log:")) -
            Number(left.source.startsWith("battle-log:")) ||
          right.source.localeCompare(left.source),
      )
      .slice(0, maxSeedsPerBattle);
    return prioritized.map(({ source, playerArmy }) => ({
      battleId,
      source,
      playerArmy,
    }));
  });
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  seeds,
};
const lines = [
  "{",
  `  "schemaVersion": ${output.schemaVersion},`,
  `  "generatedAt": ${JSON.stringify(output.generatedAt)},`,
  '  "seeds": [',
];
for (const [seedIndex, seed] of output.seeds.entries()) {
  lines.push("    {");
  lines.push(`      "battleId": ${JSON.stringify(seed.battleId)},`);
  lines.push(`      "source": ${JSON.stringify(seed.source)},`);
  lines.push('      "playerArmy": [');
  for (const [unitIndex, unit] of seed.playerArmy.entries()) {
    const comma = unitIndex < seed.playerArmy.length - 1 ? "," : "";
    lines.push(`        ${JSON.stringify(unit)}${comma}`);
  }
  lines.push("      ]");
  lines.push(`    }${seedIndex < output.seeds.length - 1 ? "," : ""}`);
}
lines.push("  ]", "}");
await writeFile(outputFile, `${lines.join("\n")}\n`, "utf8");
console.log(
  `[battle seeds] wrote ${seeds.length} seeds for ${battleSeeds.size} battles to ${path.relative(root, outputFile)}`,
);
