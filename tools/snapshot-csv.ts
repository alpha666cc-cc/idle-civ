/**
 * Full state dump for a headless simulation, one row per snapshot.
 *
 * Every column a balance pass needs, on a single line per snapshot:
 *   - the economy at a glance, before the research columns: for every building
 *     that takes workers, its owned count, its workers, and the per-second
 *     production of the resource it feeds
 *   - per building: next cost (per resource), the effect bonus that count
 *     currently grants, the four cost-reduction factors, and the actual
 *     (post-reduction) growth factor
 *   - the next research price
 *   - per unit: owned count, next cost (blank while locked), and unit power
 *   - cumulative resources spent, per resource
 *   - the running lists of achievements, upgrades and research
 *
 * Usage:
 *   tsx tools/snapshot-csv.ts <strategy...> [--horizon=3600] [--interval=60] [--out=dir]
 *
 * Writes one CSV per simulation plus a combined ODS workbook with a sheet per
 * simulation. Kept as a tool because it is the fastest way to diff two runs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { GameSimulation, createInitialState } from "./simulation.js";
import { getStrategy, getStrategyNames } from "./strategies.js";
import { buildingDefinitions, type BuildingKey, type BuildingCost } from "../src/game/buildings.js";
import { emptyWorkerAssignments, producerResourceKeys } from "../src/game/attributes.js";
import { unitDefinitions, isBuyableUnit, unitPower } from "../src/game/units.js";
import type { CivilizationState } from "../src/game/civilizationState.js";
import { ExpNumber } from "../src/game/expNumber.js";

const flag = (name: string, fallback: string): string => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const horizon = Number(flag("horizon", "3600"));
const interval = Number(flag("interval", "60"));
const outDir = flag("out", "temp");
const seed = Number(flag("seed", "42"));
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const strategies = named.length > 0 ? named : getStrategyNames();

const UNITS = unitDefinitions.filter((unit) => isBuyableUnit(unit));
const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;

/**
 * The resource each building feeds that workers can actually be assigned to, or
 * `null` when there is none. Read off the definition's `effects` rather than
 * matched on the key, so adding a building cannot silently mislabel its column.
 *
 * Eligibility comes from `emptyWorkerAssignments()` — the record the engine
 * actually fills — because `producerResourceKeys` is the wider set of resources
 * that accrue per tick (it also holds science/military/metalwork/trade, which
 * AGENTS.md §9 notes are out of step with the `ProductionResourceKey` union).
 *
 * `people`, `house` and `town-hall` resolve to nothing: they take no workers and
 * feed no resource, so they are absent from the summary block entirely.
 */
const WORKER_KEYS = new Set(Object.keys(emptyWorkerAssignments()));

const WORKER_RESOURCES = new Map<BuildingKey, string>(
  buildingDefinitions.flatMap((building) => {
    const candidates = [
      ...(building.effects.additiveMultiplier ?? []),
      ...(building.effects.resourceProduction ?? []),
    ];
    const hit = candidates.find(({ resource }) => WORKER_KEYS.has(resource));
    return hit ? [[building.key, hit.resource] as const] : [];
  }),
);

/** The buildings the summary block reports on: those that take workers. */
const WORKER_BUILDINGS = buildingDefinitions.filter(({ key }) =>
  WORKER_RESOURCES.has(key),
);

/**
 * The live per-second production of the resource a building feeds — the number
 * `computeResourceRate` already reports for that resource, so the column reads
 * as "food per second right now" rather than a re-derived per-building figure.
 * Workerless buildings have no resource, hence no cell here at all.
 */
const rateCell = (state: CivilizationState, key: BuildingKey): string => {
  const resource = WORKER_RESOURCES.get(key);
  return resource ? factor(state.computeResourceRate(resource)) : "";
};

/** Workers on the resource a building boosts. */
const workerCell = (state: CivilizationState, key: BuildingKey): string => {
  const resource = WORKER_RESOURCES.get(key);
  if (!resource) return "";
  // The assignment record carries more keys than `ProductionResourceKey` admits,
  // so read it through a widened view and tolerate an absent entry.
  const assigned = (state.workers as Record<string, ExpNumber | undefined>)[
    resource
  ];
  return String(Math.floor(assigned?.toNumber() ?? 0));
};

/** `military=150|food=5000` — the cost list flattened for one cell. */
const costCell = (costs: readonly BuildingCost[]): string =>
  costs.map((c) => `${c.resource}=${c.base.toString()}`).join("|");

/** Compact, still-readable factor: 4 significant-ish digits. */
const factor = (value: ExpNumber | number | undefined): string => {
  if (value === undefined) return "";
  const n = typeof value === "number" ? value : value.toNumber();
  if (!Number.isFinite(n)) return String(value);
  return n.toPrecision(6).replace(/\.?0+$/, "");
};

/**
 * The effect bonus `count` buildings of one key currently grant, as `key=value`
 * pairs joined by `|` (the same shape `costCell` uses, so both read alike).
 *
 * `getBuildingEffects(key, count)` is the engine's own fold of count × power,
 * so this is the real bonus, not the per-building base. The units are explicit
 * because the four effect kinds are not commensurable:
 *   - `additiveMultiplier` → `food=+210%` (it feeds `1 + Σ`, so it is a share)
 *   - `resourceProduction`  → `military=+2/s` (a flat per-second rate)
 *   - `resourceDrain`       → `food=-3/s` (consumption, hence the sign)
 *   - `capacityProvided`    → `houseCapacity=+30` (flat, not per second)
 *
 * A building can drive several things at once — town-hall provides five
 * capacities, barracks produces military *and* multiplies it — so the entries
 * are listed rather than summed into one lossy number.
 */
const bonusCell = (
  state: CivilizationState,
  key: BuildingKey,
  count: number,
): string => {
  if (count === 0) return "";
  const effects = state.getBuildingEffects(key, count);
  const parts: string[] = [];
  for (const effect of effects.additiveMultiplier ?? []) {
    // `mul` takes an ExpNumber, so the 100 has to be wrapped or it reads as NaN.
    const percent = effect.perBuilding.mul(ExpNumber.fromNumber(100));
    parts.push(`${effect.resource}=+${factor(percent)}%`);
  }
  for (const effect of effects.resourceProduction ?? []) {
    parts.push(`${effect.resource}=+${factor(effect.amount)}/s`);
  }
  for (const effect of effects.resourceDrain ?? []) {
    parts.push(`${effect.resource}=-${factor(effect.amount)}/s`);
  }
  for (const effect of effects.capacityProvided ?? []) {
    parts.push(`${effect.building}Capacity=+${factor(effect.perBuilding)}`);
  }
  return parts.join("|");
};

/* ------------------------------------------------------------------ header */

const header: string[] = [
  "sim_seconds",
  "clock",
  "age",
  "population",
  "people_capacity",
  "total_buildings",
  "battles_won",
];
// The economy at a glance, before the research block. Only buildings that take
// workers appear here — `people`, `house` and `town-hall` would be three columns
// of blanks, so they live in the cost block below instead.
for (const building of WORKER_BUILDINGS) {
  header.push(
    `bld.${building.key}.count`,
    `bld.${building.key}.workers`,
    `bld.${building.key}.production`,
  );
}
header.push(
  "research_bought",
  "research_cost_next",
  "research_cost_next_factor",
  "army_power_total",
);
for (const building of buildingDefinitions) {
  header.push(
    `bld.${building.key}.next_cost`,
    `bld.${building.key}.bonus`,
    `bld.${building.key}.red_base`,
    `bld.${building.key}.red_factor`,
    `bld.${building.key}.red_percent`,
    `bld.${building.key}.red_flat`,
    `bld.${building.key}.scale_factor`,
  );
}
for (const unit of UNITS) {
  header.push(
    `unit.${unit.key}.count`,
    `unit.${unit.key}.next_cost`,
    `unit.${unit.key}.power_each`,
  );
}
// Cumulative spend per resource, from `statistics.resourcesSpent`. The keys are
// the per-tick resources, which is the set a cost list can actually name; the
// engine only records a key once something has been paid for it, so an untouched
// resource reads 0 rather than blank.
for (const resource of producerResourceKeys) {
  header.push(`spent.${resource}`);
}
header.push("achievements_done", "upgrades_done", "research_done");

/* -------------------------------------------------------------------- rows */

const row = (state: CivilizationState, t: number): string[] => {
  const cells: string[] = [
    String(t),
    clock(t),
    state.getCurrentAge()?.key ?? "",
    state.population.toString(),
    state.resources.peopleCapacity.toString(),
    String(
      Object.values(state.builtBuildings).reduce((sum, count) => sum + (count ?? 0), 0),
    ),
    String(state.defeatedEncounters.length),
  ];

  for (const building of WORKER_BUILDINGS) {
    const key = building.key as BuildingKey;
    cells.push(
      String(state.getBuildingCount(key)),
      workerCell(state, key),
      rateCell(state, key),
    );
  }

  cells.push(
    String(state.boughtResearch.length),
    costCell(state.getResearchNextCost()),
    factor(state.getResearchNextCost()[0]?.factor ?? 0),
    state.getArmyPower().toString(),
  );

  for (const building of buildingDefinitions) {
    const key = building.key as BuildingKey;
    const count = state.getBuildingCount(key);
    const parameters = state.getBuildingCostParameters(key);
    cells.push(
      state.isBuildingAvailable(key) ? costCell(state.getBuildingCost(key, count, 1)) : "",
      bonusCell(state, key, count),
      factor(parameters[0]?.reductions.base ?? 0),
      factor(parameters[0]?.reductions.factor ?? 0),
      factor(parameters[0]?.reductions.percent ?? 0),
      factor(parameters[0]?.reductions.flat ?? 0),
      parameters.map((p) => factor(p.unitFactor)).join("|"),
    );
  }

  for (const unit of UNITS) {
    const owned = state.getUnitCount(unit.key);
    const available = state.isUnitAvailable(unit.key);
    const stats = available ? state.getUnitStats(unit.key) : undefined;
    cells.push(
      owned.sign > 0 ? owned.toString() : "0",
      // Blank while the unit is locked, exactly as asked.
      available ? costCell(state.getUnitCost(unit.key, 1)) : "",
      stats ? factor(unitPower(stats)) : "",
    );
  }

  for (const resource of producerResourceKeys) {
    cells.push(
      (state.statistics.resourcesSpent[resource] ?? ExpNumber.ZERO).toString(),
    );
  }

  cells.push(
    state.earnedAchievements.join("|"),
    state.boughtUpgrades.join("|"),
    state.boughtResearch.join("|"),
  );
  return cells;
};

/** CSV escaping: quote when the cell contains a comma, quote or newline. */
const csvCell = (value: string): string =>
  /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const csvLine = (cells: string[]): string => cells.map(csvCell).join(",");

type Sheet = { name: string; header: string; rows: string[] };

/* ---------------------------------------------------- run one strategy */

/** Runs a strategy and returns one CSV line per `interval` simulated seconds. */
const runStrategy = (name: string): { sheet: Sheet; wall: number } | null => {
  const strategy = getStrategy(name);
  if (!strategy) return null;
  const started = Date.now();

  // The capture rides on the strategy hook, so it sees exactly the state the
  // runner would have snapshotted at that second.
  const rows: string[][] = [];
  let nextAt = 0;
  const capture = {
    name: strategy.name,
    description: strategy.description,
    decideAction: (
      state: CivilizationState,
      context: { gameTime: number; snapshots: never[] },
    ) => {
      if (context.gameTime >= nextAt) {
        rows.push(row(state, context.gameTime));
        nextAt = context.gameTime + interval;
      }
      return strategy.decideAction(state, {
        gameTime: context.gameTime,
        snapshots: context.snapshots,
      });
    },
  };

  const result = new GameSimulation(createInitialState(), capture, {
    seed,
    objective: { type: "timeLimit", seconds: horizon },
    gatherClicksPerAction: 10,
    maxGameTime: horizon,
    recordSnapshots: true,
    snapshotIntervalSeconds: interval,
  }).run();

  const finalRow = row(result.finalState, result.gameTime);
  if (rows.length === 0 || rows[rows.length - 1][0] !== finalRow[0]) rows.push(finalRow);
  const lines = rows.map(csvLine);
  return {
    sheet: { name, header: csvLine(header), rows: lines },
    wall: Math.round((Date.now() - started) / 1000),
  };
};

/* ------------------------------------------------- minimal ODS (zip) writer */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Build a ZIP container from named string entries (deflate, or stored). */
const zip = (entries: { name: string; data: Buffer; store?: boolean }[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const deflated = entry.store ? raw : deflateRawSync(raw);
    const method = entry.store ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, deflated);
    centrals.push(central);
    offset += local.length + deflated.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
};

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const writeWorkbook = (sheets: Sheet[], columns: number): void => {
  if (sheets.length === 0) return;
  const ods = zip([
    {
      name: "mimetype",
      data: Buffer.from("application/vnd.oasis.opendocument.spreadsheet", "utf8"),
      store: true,
    },
    { name: "META-INF/manifest.xml", data: Buffer.from(manifest(sheets), "utf8") },
    { name: "content.xml", data: Buffer.from(odsContent(sheets), "utf8") },
    ...sheets.map((sheet, i) => ({
      name: `sim-${i + 1}.csv`,
      data: Buffer.from([sheet.header, ...sheet.rows].join("\n") + "\n", "utf8"),
    })),
  ]);
  const file = `${outDir}/simulations.ods`;
  writeFileSync(file, ods);
  console.log(
    `\nworkbook: ${file}  (${sheets.length} sheets: ${sheets.map((s) => s.name).join(", ")})`,
  );
  console.log(`columns per sheet: ${columns}`);
};

/** One ODS sheet per simulation. Values are written as strings, which is what a
 *  balance sheet wants anyway: ExpNumber strings and `a|b` lists stay readable. */
const odsContent = (sheets: Sheet[]): string => {
  const body = sheets
    .map((sheet) => {
      const rows = [sheet.header, ...sheet.rows]
        .map(
          (line) =>
            `<table:table-row>${line
              .split(",")
              .map((cell) => {
                // A quoted CSV cell is already escaped; keep the quotes literal.
                const value = cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell;
                return `<table:table-cell office:value-type="string"><text:p>${xml(value)}</text:p></table:table-cell>`;
              })
              .join("")}</table:table-row>`,
        )
        .join("");
      return `<table:table table:name="${xml(sheet.name)}">${rows}</table:table>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:spreadsheet>${body}</office:spreadsheet></office:body>
</office:document-content>`;
};

const manifest = (sheets: Sheet[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
${sheets
  .map(
    (_, i) =>
      `<manifest:file-entry manifest:full-path="sim-${i + 1}.csv" manifest:media-type="text/csv"/>`,
  )
  .join("")}
</manifest:manifest>`;

/* ------------------------------------------------------------------ main */

/**
 * `--merge` rebuilds the workbook from the `sim-*.csv` files already on disk, so
 * a long sweep does not have to be run twice just to get one .ods. Declared
 * after the writers above, which it calls.
 */
if (process.argv.includes("--merge")) {
  const { readdirSync, existsSync } = await import("node:fs");
  const dir = existsSync(outDir) ? outDir : "temp";
  const merged: Sheet[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.startsWith("sim-") || !file.endsWith(".csv")) continue;
    const lines = readFileSync(`${dir}/${file}`, "utf8").split("\n").filter(Boolean);
    if (lines.length < 2) continue;
    merged.push({
      name: file.replace(/^sim-/, "").replace(/\.csv$/, ""),
      header: lines[0],
      rows: lines.slice(1),
    });
  }
  if (merged.length > 0) writeWorkbook(merged, header.length);
  process.exit(0);
}

const sheets: Sheet[] = [];
mkdirSync(outDir, { recursive: true });
for (const name of strategies) {
  const result = runStrategy(name);
  if (!result) continue;
  const file = `${outDir}/sim-${name}.csv`;
  writeFileSync(
    file,
    [result.sheet.header, ...result.sheet.rows].join("\n") + "\n",
    "utf8",
  );
  sheets.push(result.sheet);
  console.log(
    `${name.padEnd(10)} ${String(result.sheet.rows.length).padStart(4)} rows x ${header.length} cols  ->  ${file}  (${result.wall}s)`,
  );
}

writeWorkbook(sheets, header.length);
;


