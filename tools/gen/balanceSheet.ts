/**
 * Balance-plan generator — a spreadsheet for pacing work.
 *
 * One row per citizen milestone (10, 20, 50 … 10 B). Per row: the buildings the
 * ratios imply, the workers feeding them, production, the achievement / upgrade /
 * research multipliers in force, and the time to the next building and the next
 * research.
 *
 * Everything the sheet labels "(engine)" is read from the real
 * `CivilizationState`: the state is built with the assumed building counts,
 * workers, ages, research, battles and upgrades, `checkAchievements()` decides the
 * achievement set, and `getModifierSummary()` / `getBuildingCost()` /
 * `getResearchNextCost()` supply the numbers. The "(model)" columns are plain
 * spreadsheet formulas over the `Inputs` and `Data` sheets, so the ratios can be
 * toyed with without re-running this script.
 *
 * Run: npm run gen:balance            (writes temp/balance-plan.fods + .csv)
 *      npm run gen:balance -- --dump  (print the table to the console instead)
 */
import fs from "node:fs";
import path from "node:path";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  productionDefinitions,
  type ProductionResourceKey,
} from "../../src/game/attributes.js";
import { achievementDefinitions } from "../../src/game/achievements.js";
import { ageDefinitions } from "../../src/game/ages.js";
import { buildingDefinitions, type BuildingKey } from "../../src/game/buildings.js";
import { CivilizationState } from "../../src/game/civilizationState.js";
import { encounterDefinitions } from "../../src/game/encounters.js";
import { ExpNumber } from "../../src/game/expNumber.js";
import { researchDefinitions } from "../../src/game/research.js";
import { emptyStatistics } from "../../src/game/statistics.js";
import { upgradeDefinitions } from "../../src/game/upgrades.js";

/** Citizen milestones: 1, 2 and 5 per decade, from 10 up to 10 B. */
const CITIZENS: number[] = [];
for (let exponent = 1; exponent <= 10; exponent += 1)
  for (const lead of [1, 2, 5]) CITIZENS.push(lead * 10 ** exponent);

/** The five resources the plan tracks. */
const TRACKED: ProductionResourceKey[] = ["food", "wood", "stone", "gold", "science"];

type InputRow = { key: string; label: string; value: number | string; note: string };

/** Assumptions; the generated engine columns are measured with these values. */
const INPUTS: InputRow[] = [
  { key: "citizensPerFarm", label: "Citizens per farm", value: 5, note: "farm ≈ citizens / this" },
  { key: "citizensPerLumberYard", label: "Citizens per lumber yard", value: 5, note: "lumber yard ≈ citizens / this" },
  { key: "citizensPerQuarry", label: "Citizens per quarry", value: 5, note: "quarry ≈ citizens / this" },
  { key: "citizensPerGoldMine", label: "Citizens per gold mine", value: 5, note: "gold mine ≈ citizens / this" },
  { key: "citizensPerUniversity", label: "Citizens per university", value: 10, note: "university ≈ citizens / this" },
  { key: "citizensPerBarracks", label: "Citizens per barracks", value: 10, note: "barracks ≈ citizens / this" },
  { key: "citizensPerSmithy", label: "Citizens per smithy", value: 20, note: "smithy ≈ citizens / this" },
  { key: "citizensPerHouse", label: "Citizens per house", value: 10, note: "houses = citizens / this (1 house = 10 people capacity)" },
  { key: "housesPerTownHall", label: "Houses per town hall", value: 10, note: "town halls = houses / this (1 town hall = 10 house capacity)" },
  { key: "shareFood", label: "Worker share: food", value: 0.4, note: "fraction of citizens on food" },
  { key: "shareWood", label: "Worker share: wood", value: 0.2, note: "fraction of citizens on wood" },
  { key: "shareStone", label: "Worker share: stone", value: 0.2, note: "fraction of citizens on stone" },
  { key: "shareGold", label: "Worker share: gold", value: 0.2, note: "fraction of citizens on gold" },
  { key: "shareScience", label: "Worker share: science", value: 0, note: "fraction of citizens on science" },
  { key: "boughtResearchShare", label: "Research bought share", value: 1, note: "0..1 — share of the pre-age research assumed bought" },
  { key: "targetBuilding", label: "Target building", value: "farm", note: "building whose next unit the timing columns price" },
];

const inputValue = (key: string): number =>
  Number(INPUTS.find(({ key: entryKey }) => entryKey === key)?.value ?? 0);
const inputString = (key: string): string =>
  String(INPUTS.find(({ key: entryKey }) => entryKey === key)?.value ?? "");

const productionPerWorker = (resource: ProductionResourceKey): number =>
  productionDefinitions.find(({ key }) => key === resource)?.productionPerWorker ?? 1;

type BuildingInfo = {
  key: BuildingKey;
  name: string;
  multiplier?: { resource: string; factor: number };
  production?: { resource: string; amount: number };
};

const BUILDINGS: BuildingInfo[] = buildingDefinitions.map((building) => {
  const effects = building.effects as unknown as {
    additiveMultiplier?: { resource: string; perBuilding: ExpNumber }[];
    resourceProduction?: { resource: string; amount: ExpNumber }[];
  };
  const multiplier = effects.additiveMultiplier?.[0];
  const production = effects.resourceProduction?.[0];
  return {
    key: building.key,
    name: building.name,
    multiplier: multiplier
      ? {
          resource: multiplier.resource,
          // The sheet model still compounds; perBuilding + 1 rebuilds the factor.
          factor: multiplier.perBuilding.toNumber() + 1,
        }
      : undefined,
    production: production
      ? { resource: production.resource, amount: production.amount.toNumber() }
      : undefined,
  };
});

/** Resource → the building whose count feeds its achievement / upgrade tiers. */
const OWNER_BUILDING: Record<string, BuildingKey> = {
  food: "farm",
  wood: "lumberYard",
  stone: "quarry",
  gold: "goldMine",
  science: "university",
  military: "barracks",
  metalwork: "smithy",
};

type ChainTier = { threshold: number; value: number };

const ACHIEVEMENTS = achievementDefinitions as unknown as {
  key: string;
  family?: string;
  requirement: { count?: number; resource?: string; amount?: unknown };
  bonuses: { value: unknown }[];
}[];

/** Definition fields may be plain numbers or ExpNumber; normalize both. */
const plainNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  const candidate = value as { toNumber?: () => number } | undefined;
  return typeof candidate?.toNumber === "function" ? candidate.toNumber() : 0;
};

/** `‹resource›-multiplier` tiers: buildingCount threshold → ×value. */
const MULTIPLIER_CHAINS: Record<string, ChainTier[]> = {};
/** `‹resource›-hoarder` tiers: held-amount threshold → +flat value. */
const HOARDER_CHAINS: Record<string, ChainTier[]> = {};
for (const entry of ACHIEVEMENTS) {
  const family = entry.family ?? "";
  if (family.endsWith("-multiplier")) {
    const resource = family.slice(0, -"-multiplier".length);
    (MULTIPLIER_CHAINS[resource] ??= []).push({
      threshold: plainNumber(entry.requirement.count),
      value: plainNumber(entry.bonuses[0]?.value) || 1,
    });
  }
  if (family.endsWith("-hoarder")) {
    const resource = family.slice(0, -"-hoarder".length);
    (HOARDER_CHAINS[resource] ??= []).push({
      threshold: plainNumber(entry.requirement.amount),
      value: plainNumber(entry.bonuses[0]?.value),
    });
  }
}
for (const tiers of Object.values(MULTIPLIER_CHAINS))
  tiers.sort((left, right) => left.threshold - right.threshold);
for (const tiers of Object.values(HOARDER_CHAINS))
  tiers.sort((left, right) => left.threshold - right.threshold);

const UPGRADES = upgradeDefinitions.map((upgrade) => ({
  key: upgrade.key,
  building: upgrade.unlock.building as string,
  threshold: upgrade.unlock.threshold,
}));

const RESEARCH = researchDefinitions as unknown as { key: string; age: number }[];
const AGES = ageDefinitions as unknown as {
  key: string;
  name: string;
  populationThreshold: number;
}[];
const ENCOUNTERS = encounterDefinitions as unknown as { id: string; age: number }[];

const ENCOUNTERS_IDS = new Set(ENCOUNTERS.map(({ id }) => id));
const RESEARCH_IDS = new Set(RESEARCH.map(({ key }) => key));
const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map(({ key }) => key));
const UPGRADE_IDS = new Set(UPGRADES.map(({ key }) => key));
const BUILDING_IDS = new Set(BUILDINGS.map(({ key }) => key));

/** Which bonus source a factor belongs to: the sheet's multiplier breakdown. */
const categoryOf = (sourceId: string): string => {
  if (BUILDING_IDS.has(sourceId as BuildingKey)) return "building";
  if (UPGRADE_IDS.has(sourceId)) return "upgrade";
  if (RESEARCH_IDS.has(sourceId)) return "research";
  if (ACHIEVEMENT_IDS.has(sourceId)) return "achievement";
  if (ENCOUNTERS_IDS.has(sourceId)) return "battle";
  if (sourceId.startsWith("age-")) return "age";
  return "other";
};

/** Assumed count of one building at a citizen milestone. */
const countOf = (key: BuildingKey, citizens: number): number => {
  switch (key) {
    case "people":
      return citizens;
    case "house":
      return Math.max(1, Math.ceil(citizens / inputValue("citizensPerHouse")));
    case "townHall":
      return Math.max(
        1,
        Math.ceil(countOf("house", citizens) / inputValue("housesPerTownHall")),
      );
    case "farm":
      return Math.max(1, Math.ceil(citizens / inputValue("citizensPerFarm")));
    case "lumberYard":
      return Math.max(1, Math.ceil(citizens / inputValue("citizensPerLumberYard")));
    case "quarry":
      return Math.max(1, Math.ceil(citizens / inputValue("citizensPerQuarry")));
    case "goldMine":
      return Math.max(1, Math.ceil(citizens / inputValue("citizensPerGoldMine")));
    case "university":
      return Math.max(1, Math.ceil(citizens / inputValue("citizensPerUniversity")));
    case "barracks":
      return Math.max(1, Math.ceil(citizens / inputValue("citizensPerBarracks")));
    case "smithy":
      return Math.max(1, Math.ceil(citizens / inputValue("citizensPerSmithy")));
    default:
      return 0;
  }
};

const buildCounts = (citizens: number): Record<string, number> =>
  Object.fromEntries(
    BUILDINGS.map((building) => [building.key, countOf(building.key, citizens)]),
  );

const ageIndexOf = (citizens: number): number => {
  let index = 0;
  AGES.forEach((age, position) => {
    if (citizens >= age.populationThreshold) index = position;
  });
  return index;
};

type Assumptions = {
  upgrades: string[];
  research: string[];
  encounters: string[];
  ages: string[];
  achievements: string[];
};

const assumedUpgrades = (counts: Record<string, number>): string[] =>
  UPGRADES.filter((upgrade) => (counts[upgrade.building] ?? 0) >= upgrade.threshold).map(
    ({ key }) => key,
  );

const assumedResearch = (ageIndex: number): string[] => {
  const available = RESEARCH.filter((research) => research.age < ageIndex);
  const share = inputValue("boughtResearchShare");
  return available.slice(0, Math.round(available.length * share)).map(({ key }) => key);
};

const workerAssignments = (citizens: number): Record<string, ExpNumber> => {
  const workers = emptyWorkerAssignments() as unknown as Record<string, ExpNumber>;
  for (const resource of Object.keys(workers)) {
    const key = `share${resource.charAt(0).toUpperCase()}${resource.slice(1)}`;
    workers[resource] = ExpNumber.fromNumber(
      Math.floor(citizens * inputValue(key)),
    );
  }
  return workers;
};

/** The engine state for one milestone under the assumption set. */
const makeState = (
  counts: Record<string, number>,
  workers: Record<string, ExpNumber>,
  assumptions: Assumptions,
  stocks: Record<string, number>,
): CivilizationState => {
  const resources = emptyResourceAmounts();
  for (const [resource, amount] of Object.entries(stocks))
    if (amount > 0) resources[resource as keyof typeof resources] = ExpNumber.fromNumber(amount);
  return new CivilizationState(
    resources,
    workers as never,
    counts as never,
    emptyResourceFactors(),
    {},
    0,
    assumptions.upgrades,
    assumptions.encounters,
    assumptions.ages,
    assumptions.achievements,
    emptyStatistics(),
    {},
    ExpNumber.ONE,
    false,
    false,
    false,
    assumptions.research,
  );
};

type Measurement = {
  citizens: number;
  ageIndex: number;
  ageName: string;
  counts: Record<string, number>;
  workers: Record<string, number>;
  rates: Record<string, number>;
  engines: Record<
    string,
    { additional: number; multiplier: number; drain: number; result: number }
  >;
  /** resource → category → product of that category's multipliers. */
  categories: Record<string, Record<string, number>>;
  earned: number;
  boughtUpgrades: number;
  boughtResearch: number;
  nextResearch: { bought: number; science: number; seconds: number };
  target: {
    building: string;
    count: number;
    capacity: number;
    costs: { resource: string; amount: number }[];
    seconds: number;
  };
  /** Per-building price + timing at this milestone, for the Targets sheet. */
  targets: Record<
    string,
    {
      count: number;
      capacity: number;
      costs: { resource: string; amount: number }[];
      seconds: number;
      bottleneck: string;
    }
  >;
  clickPower: number;
};

/** Everything the sheet needs about one citizen milestone, from the real engine. */
const measure = (citizens: number): Measurement => {
  const ageIndex = ageIndexOf(citizens);
  const counts = buildCounts(citizens);
  const workers = workerAssignments(citizens);
  const assumptions: Assumptions = {
    upgrades: assumedUpgrades(counts),
    research: assumedResearch(ageIndex),
    encounters: ENCOUNTERS.filter(({ age }) => age < ageIndex).map(({ id }) => id),
    ages: AGES.slice(0, ageIndex + 1).map(({ key }) => key),
    achievements: [],
  };

  // Pass 1 prices the next purchases; pass 2 assumes that much is in the bank, so
  // the hoarder achievements the player would hold at that moment are earned too.
  const preview = makeState(counts, workers, assumptions, {});
  const previewEarned = preview.checkAchievements().earnedAchievements;
  const targetBuilding = inputString("targetBuilding");
  const targetCount = counts[targetBuilding] ?? 0;
  const targetCosts = preview
    .getBuildingCost(targetBuilding, targetCount, 1)
    .map(({ resource, base: amount }) => ({ resource, amount: amount.toNumber() }));
  const researchScience = preview.getResearchNextCost()[0].base.toNumber();
  const stocks: Record<string, number> = { science: researchScience };
  for (const { resource, amount } of targetCosts)
    stocks[resource] = Math.max(stocks[resource] ?? 0, amount);

  const state = makeState(counts, workers, { ...assumptions, achievements: previewEarned }, stocks);
  const earned = state.checkAchievements().earnedAchievements;

  const engines: Measurement["engines"] = {};
  const categories: Measurement["categories"] = {};
  const rates: Record<string, number> = {};
  for (const resource of [...TRACKED, "military", "metalwork"] as ProductionResourceKey[]) {
    const summary = state.getModifierSummary(resource);
    engines[resource] = {
      additional: summary.additional.toNumber(),
      multiplier: summary.multiplier.toNumber(),
      drain: summary.drain.toNumber(),
      result: summary.result.toNumber(),
    };
    rates[resource] = engines[resource].result;
    const breakdown: Record<string, number> = {};
    const buckets = state.getFactors(resource);
    for (const [sourceId, value] of buckets.multiplicative) {
      const category = categoryOf(sourceId);
      breakdown[category] = (breakdown[category] ?? 1) * value.toNumber();
    }
    for (const [sourceId, value] of buckets.additiveMultiplier) {
      const category = categoryOf(sourceId);
      breakdown[category] = (breakdown[category] ?? 1) * (1 + value.toNumber());
    }
    categories[resource] = breakdown;
  }

  const secondsFor = (costs: { resource: string; amount: number }[]): number =>
    Math.max(
      ...costs.map(({ resource, amount }) => {
        const rate = rates[resource] ?? 0;
        return rate > 0 ? amount / rate : Infinity;
      }),
    );

  const targets: Measurement["targets"] = {};
  for (const building of BUILDINGS) {
    const count = counts[building.key] ?? 0;
    const costs = state
      .getBuildingCost(building.key, count, 1)
      .map(({ resource, base: amount }) => ({
        resource,
        amount: amount.toNumber(),
      }));
    let seconds = -Infinity;
    let bottleneck = "";
    for (const { resource, amount } of costs) {
      const rate = rates[resource] ?? 0;
      const secondsHere = rate > 0 ? amount / rate : Infinity;
      if (secondsHere >= seconds) {
        seconds = secondsHere;
        bottleneck = resource;
      }
    }
    if (costs.length === 0) seconds = Infinity;
    targets[building.key] = {
      count,
      capacity: state.getBuildingMax(building.key).toNumber(),
      costs,
      seconds,
      bottleneck,
    };
  }

  return {
    citizens,
    ageIndex,
    ageName: AGES[ageIndex]?.name ?? `Age ${ageIndex}`,
    counts,
    workers: Object.fromEntries(
      Object.entries(workers).map(([resource, value]) => [resource, value.toNumber()]),
    ),
    rates,
    engines,
    categories,
    targets,
    earned: earned.length,
    boughtUpgrades: assumptions.upgrades.length,
    boughtResearch: assumptions.research.length,
    nextResearch: {
      bought: assumptions.research.length,
      science: researchScience,
      seconds: rates.science > 0 ? researchScience / rates.science : Infinity,
    },
    target: {
      building: targetBuilding,
      count: targetCount,
      capacity: state.getBuildingMax(targetBuilding).toNumber(),
      costs: targetCosts,
      seconds: secondsFor(targetCosts),
    },
    clickPower: state.getAttributeValue("clickPower").toNumber(),
  };
};

const formatSeconds = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return "never";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds < 86400 * 365) return `${(seconds / 86400).toFixed(1)}d`;
  return `${(seconds / (86400 * 365)).toFixed(1)}y`;
};

const compact = (value: number): string => {
  if (!Number.isFinite(value)) return "∞";
  const abs = Math.abs(value);
  if (abs >= 1e6 || (abs > 0 && abs < 0.01)) return value.toExponential(2);
  return value.toFixed(3);
};

// --- flat-ODS writer ---------------------------------------------------------

type Cell =
  | number
  | string
  | null
  | { formula: string; value: number | string }
  | { formula: string; text: string };

const xmlEscape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const cellXml = (cell: Cell): string => {
  if (cell === null || cell === undefined) return "<table:table-cell/>";
  if (typeof cell === "number") {
    if (!Number.isFinite(cell))
      return `<table:table-cell office:value-type="string"><text:p>${cell > 0 ? "inf" : "-inf"}</text:p></table:table-cell>`;
    return `<table:table-cell office:value-type="float" office:value="${cell}"><text:p>${cell}</text:p></table:table-cell>`;
  }
  if (typeof cell === "string")
    return `<table:table-cell office:value-type="string"><text:p>${xmlEscape(cell)}</text:p></table:table-cell>`;
  if ("text" in cell)
    return `<table:table-cell table:formula="of:${xmlEscape(cell.formula)}" office:value-type="string"><text:p>${xmlEscape(cell.text)}</text:p></table:table-cell>`;
  const value = cell.value;
  if (cell.formula === undefined)
    throw new Error(`formula cell without formula: ${JSON.stringify(cell)}`);
  if (typeof value === "string")
    return `<table:table-cell table:formula="of:${xmlEscape(cell.formula)}" office:value-type="string"><text:p>${xmlEscape(value)}</text:p></table:table-cell>`;
  const shown = Number.isFinite(value) ? String(value) : "inf";
  return `<table:table-cell table:formula="of:${xmlEscape(cell.formula)}" office:value-type="float" office:value="${Number.isFinite(value) ? value : 0}"><text:p>${shown}</text:p></table:table-cell>`;
};

const sheetXml = (name: string, rows: Cell[][]): string =>
  `<table:table table:name="${xmlEscape(name)}">` +
  rows
    .map((row) => `<table:table-row>${row.map(cellXml).join("")}</table:table-row>`)
    .join("") +
  "</table:table>";

const FODS_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
].join(" ");

const fodsDocument = (sheets: [string, Cell[][]][]): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<office:document ${FODS_NS} office:mimetype="application/vnd.oasis.opendocument.spreadsheet" office:version="1.3">` +
  '<office:automatic-styles><style:style style:name="bold" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles>' +
  "<office:body><office:spreadsheet>" +
  sheets.map(([name, rows]) => sheetXml(name, rows)).join("") +
  "</office:spreadsheet></office:body></office:document>";

/** Column letter for a 1-based column index (A, B … AA). */
const columnName = (index: number): string => {
  let name = "";
  let remaining = index;
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
};

/** Reference of a cell on another sheet, e.g. `[Inputs.$B$4]`. */
const otherSheetRef = (sheet: string, column: number, row: number): string =>
  `[${sheet}.$${columnName(column)}$${row}]`;

/** Reference of a cell on the sheet being written, e.g. `[.$A3]`. */
const ref = (column: number, row: number): string =>
  `[.${columnName(column)}${row}]`;

const csvCell = (cell: Cell): string => {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number")
    return Number.isFinite(cell) ? String(cell) : cell > 0 ? "inf" : "-inf";
  if (typeof cell === "string") return cell;
  if ("text" in cell) return cell.text;
  return typeof cell.value === "number" ? String(cell.value) : String(cell.value);
};

const csvText = (rows: Cell[][]): string =>
  rows
    .map((row) =>
      row
        .map((cell) => {
          const text = csvCell(cell);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(","),
    )
    .join("\r\n") + "\r\n";

// --- sheets ------------------------------------------------------------------

const TRACKED_CHAIN_RESOURCES = [
  "food",
  "wood",
  "stone",
  "gold",
  "science",
  "military",
  "metalwork",
];
const UPGRADE_BUILDINGS = ["farm", "lumberYard", "quarry", "goldMine"];

/** Row addresses on the reference sheets (filled by the row builders below). */
const BUILDING_ROW = new Map<string, number>();
const DATA = {
  buildingFirstRow: 0,
  buildingCostCol: 3, // slot 1 resource/base/factor, 3 columns per slot
  chainFirstRow: 0,
  chainLastRow: 0,
  chainValueCols: {} as Record<string, number>,
  upgradeRows: {} as Record<string, [number, number]>,
  constants: {} as Record<string, number>,
};

const inputRef = (key: string): string => {
  const index = INPUTS.findIndex((entry) => entry.key === key);
  return otherSheetRef("Inputs", 2, 4 + index);
};
const dataRef = (sheet: string, column: number, row: number): string =>
  otherSheetRef(sheet, column, row);

/** Data rows: engine constants, then the building cost table. */
const constantsRows = (): Cell[][] => {
  const rows: Cell[][] = [
    ["Constants read from the game data", null, "used by"],
    ["key", "label", "value"],
  ];
  const constants: [string, string, number][] = [
    ["ppwFood", "Production per worker: food", productionPerWorker("food")],
    ["ppwWood", "Production per worker: wood", productionPerWorker("wood")],
    ["ppwStone", "Production per worker: stone", productionPerWorker("stone")],
    ["ppwGold", "Production per worker: gold", productionPerWorker("gold")],
    ["ppwScience", "Production per worker: science", productionPerWorker("science")],
    ["universityScience", "Science per university per second", 1],
    ["citizenDrain", "Food eaten per citizen per second", 1],
    ["researchFirstCost", "Science for the first research", 100],
    ["researchCostFactor", "Research price factor on the square-root curve", 10],
    ["upgradeTierMultiplier", "Production per upgrade tier", 2],
  ];
  constants.forEach(([key, label, value], index) => {
    DATA.constants[key] = 3 + index;
    rows.push([key, label, value]);
  });
  return rows;
};

const buildingsRows = (): Cell[][] => {
  const rows: Cell[][] = [
    ["Buildings — costs in the engine's own slot order", null, null, null, null, null, null, null, null, null, null, "own effect", null, "own production", null],
    ["key", "name", "slot 1 resource", "slot 1 base", "slot 1 factor", "slot 2 resource", "slot 2 base", "slot 2 factor", "slot 3 resource", "slot 3 base", "slot 3 factor", "multiplier resource", "multiplier factor", "production resource", "production amount"],
  ];
  BUILDINGS.forEach((building, index) => {
    if (index === 0) DATA.buildingFirstRow = rows.length + 1;
    BUILDING_ROW.set(building.key, rows.length + 1);
    const definition = buildingDefinitions.find(({ key }) => key === building.key);
    const row: Cell[] = [building.key, building.name];
    for (let slot = 0; slot < 3; slot += 1) {
      const cost = definition?.costs[slot];
      row.push(
        cost ? cost.resource : "",
        cost ? cost.base.toNumber() : "",
        cost ? cost.factor : "",
      );
    }
    row.push(
      building.multiplier?.resource ?? "",
      building.multiplier?.factor ?? "",
      building.production?.resource ?? "",
      building.production?.amount ?? "",
    );
    rows.push(row);
  });
  return rows;
};

const chainRows = (): Cell[][] => {
  const maxTiers = Math.max(
    0,
    ...TRACKED_CHAIN_RESOURCES.map(
      (resource) => MULTIPLIER_CHAINS[resource]?.length ?? 0,
    ),
  );
  const rows: Cell[][] = [
    ["Achievement multiplier chains — buildingCount threshold → multiplier", null, null, null, null, null, null, null, null],
    ["tier", "threshold", ...TRACKED_CHAIN_RESOURCES],
  ];
  DATA.chainFirstRow = rows.length + 1;
  TRACKED_CHAIN_RESOURCES.forEach((resource, position) => {
    DATA.chainValueCols[resource] = 3 + position;
  });
  for (let tier = 0; tier < maxTiers; tier += 1) {
    rows.push([
      tier + 1,
      TRACKED_CHAIN_RESOURCES.map(
        (resource) => MULTIPLIER_CHAINS[resource]?.[tier],
      ).find(Boolean)?.threshold ?? "",
      ...TRACKED_CHAIN_RESOURCES.map(
        (resource) => MULTIPLIER_CHAINS[resource]?.[tier]?.value ?? 1,
      ),
    ]);
  }
  DATA.chainLastRow = rows.length;
  return rows;
};

const upgradeRows = (): Cell[][] => {
  const rows: Cell[][] = [
    ["Upgrade tiers — ×2 production each, by building count", null, null],
    ["resource", "tier", "buildingCount threshold"],
  ];
  for (const building of UPGRADE_BUILDINGS) {
    const resource =
      BUILDINGS.find(({ key }) => key === building)?.multiplier?.resource ?? building;
    const thresholds = UPGRADES.filter((upgrade) => upgrade.building === building)
      .map((upgrade) => upgrade.threshold)
      .sort((left, right) => left - right);
    const first = rows.length + 1;
    thresholds.forEach((threshold, index) =>
      rows.push([resource, index + 1, threshold]),
    );
    DATA.upgradeRows[resource] = [first, rows.length];
  }
  return rows;
};

const hoarderRows = (): Cell[][] => [
  ["Hoarder chains — held amount → flat bonus per second", null, null],
  ["resource", "tier", "held amount"],
  ...Object.entries(HOARDER_CHAINS).flatMap(([resource, tiers]) =>
    tiers.map((tier, index) => [resource, index + 1, tier.threshold] as Cell[]),
  ),
];

const agesRows = (): Cell[][] => [
  ["Ages", null, null],
  ["index", "age", "population threshold"],
  ...AGES.map((age, index) => [index, age.name, age.populationThreshold] as Cell[]),
];

const notesRows = (): Cell[][] => [
  ["How to read this workbook"],
  [""],
  ["Plan", "one row per citizen milestone (10 … 10 B). (model) columns are formulas over Inputs + Data; (engine) columns are values read from the real game engine for the assumed build. Change an Inputs value to re-price the model columns — the engine columns stay as measured."],
  ["Targets", "one row per milestone × building: the next unit's cost, the capacity limit and the time to afford it at that milestone's rates."],
  ["Assumed build", "houses = citizens / Inputs.citizensPerHouse; town halls = houses / Inputs.housesPerTownHall; every other building = citizens / its ratio, rounded up. The engine is measured with exactly these counts, so the engine and model columns start in agreement."],
  ["Workers", "citizens × the worker-share inputs, rounded down. Each worker produces 1/s (food, wood, stone, gold) or 0.1/s (science)."],
  ["Production (engine)", "the engine's own rate: (Σ flat) × (Π multipliers) − (Σ drain). Food carries the citizen upkeep, −1/s per citizen."],
  ["Multiplier columns", "building × = the building's own per-unit factor ^ count; achievement × = the ‹resource›-multiplier chain tiers unlocked by that building count; upgrade × = ×2 per enhancer tier passed; other × = research + battle + age bonuses (engine values — edit them to test a different research pace)."],
  ["Times", "next building = the slowest of its cost resources (unit cost / that resource's production). Next research = 100 × 10^(√n − 1), where n is the purchase ordinal. 'Time incl. research' takes the slower of the two, because science and resources accrue in parallel."],
  ["Approximations", "upgrades are assumed bought as soon as their buildingCount threshold is met; research is assumed bought for every earlier age (Inputs.boughtResearchShare trims that); battles are assumed won for every earlier age; resources are assumed held at exactly the next purchase's cost, which is what unlocks the hoarder tiers."],
  ["Reading the balance", "the engine columns are the current data's answer, not a target. Where they explode or stall is what to tune — start with the cost factors on Data and the ratios on Inputs."],
];



// --- Plan / Inputs / Targets rows -------------------------------------------

/** Model-vs-engine multiplier divergences; printed by main() so they get seen. */
const MISMATCHES: string[] = [];

const PLAN_BUILDINGS: BuildingKey[] = [
  "people",
  "house",
  "townHall",
  "farm",
  "lumberYard",
  "quarry",
  "goldMine",
  "university",
  "barracks",
  "smithy",
];
const WORKER_RESOURCES = ["food", "wood", "stone", "gold", "science"];
const PLAN_RESOURCES = ["food", "wood", "stone", "gold", "science", "military", "metalwork"];
const RES_SLOTS = [
  "production",
  "structural",
  "flats",
  "drain",
  "building",
  "achievement",
  "upgrade",
  "other",
  "model",
] as const;

type ResourceModel = {
  structural: number;
  flats: number;
  drain: number;
  building: number;
  achievement: number;
  upgrade: number;
  other: number;
  production: number;
  /** Engine achievement total ÷ chain product: the singular achievements. */
  singulars: number;
};

const ppwKey = (resource: string): string =>
  "ppw" + resource.charAt(0).toUpperCase() + resource.slice(1);

const multiplierBuilding = (resource: string): BuildingInfo | undefined =>
  BUILDINGS.find((building) => building.multiplier?.resource === resource);

const close = (model: number, engine: number): boolean =>
  model === engine || Math.abs(model - engine) <= 1e-6 * Math.max(1, Math.abs(engine));

/** Numeric side of every Plan model column: what the formulas evaluate to. */
const resourceModels = (m: Measurement): Record<string, ResourceModel> => {
  const models: Record<string, ResourceModel> = {};
  for (const resource of PLAN_RESOURCES) {
    const engine = m.engines[resource] ?? { additional: 0, multiplier: 1, drain: 0, result: 0 };
    let structural = 0;
    if (WORKER_RESOURCES.includes(resource))
      structural +=
        (m.workers[resource] ?? 0) * productionPerWorker(resource as ProductionResourceKey);
    for (const building of BUILDINGS)
      if (building.production?.resource === resource)
        structural += (m.counts[building.key] ?? 0) * building.production.amount;
    const flats = engine.additional - structural;
    const owned = multiplierBuilding(resource);
    const buildingX = owned ? owned.multiplier!.factor ** (m.counts[owned.key] ?? 0) : 1;
    const ownerCount = m.counts[OWNER_BUILDING[resource]] ?? 0;
    const chainX = (MULTIPLIER_CHAINS[resource] ?? []).reduce(
      (product, tier) => (ownerCount >= tier.threshold ? product * tier.value : product),
      1,
    );
    const achievementX = m.categories[resource]?.achievement ?? 1;
    const tiersPassed = UPGRADES.filter(
      (upgrade) =>
        upgrade.building === OWNER_BUILDING[resource] && upgrade.threshold <= ownerCount,
    ).length;
    const upgradeX = DATA.upgradeRows[resource] ? 2 ** tiersPassed : 1;
    const categories = m.categories[resource] ?? {};
    const otherX = Object.entries(categories)
      .filter(([key]) => key !== "building" && key !== "upgrade" && key !== "achievement")
      .reduce((product, [, value]) => product * value, 1);
    const engineBuilding = categories.building ?? 1;
    const engineUpgrade = categories.upgrade ?? 1;
    if (!close(buildingX, engineBuilding))
      MISMATCHES.push(`${resource}@${m.citizens}: building ${buildingX} vs engine ${engineBuilding}`);
    if (!close(upgradeX, engineUpgrade))
      MISMATCHES.push(`${resource}@${m.citizens}: upgrade ${upgradeX} vs engine ${engineUpgrade}`);
    models[resource] = {
      structural,
      flats,
      drain: engine.drain,
      building: buildingX,
      achievement: achievementX,
      upgrade: upgradeX,
      other: otherX,
      production: (structural + flats) * buildingX * achievementX * upgradeX * otherX - engine.drain,
      singulars: chainX > 0 ? achievementX / chainX : achievementX,
    };
  }
  return models;
};

const inputsRows = (): Cell[][] => [
  ["Balance inputs", null, null, null],
  ["edit the value column — the Plan and Targets model columns re-price from it"],
  ["label", "value", "key", "note"],
  ...INPUTS.map((entry) => [entry.label, entry.value, entry.key, entry.note] as Cell[]),
];

/** Which ratio input prices each Plan building count. */
const RATIO_INPUT: Record<string, string> = {
  farm: "citizensPerFarm",
  "lumberYard": "citizensPerLumberYard",
  quarry: "citizensPerQuarry",
  "goldMine": "citizensPerGoldMine",
  university: "citizensPerUniversity",
  barracks: "citizensPerBarracks",
  smithy: "citizensPerSmithy",
};

const SLOT_SUFFIX: Record<string, string> = {
  production: "engine",
  structural: "model",
  flats: "engine",
  drain: "engine",
  building: "model",
  achievement: "model",
  upgrade: "model",
  other: "engine",
  model: "model",
};

type PlanCols = {
  citizens: number;
  count: Record<string, number>;
  worker: Record<string, number>;
  res: Record<string, Record<string, number>>;
  targetCount: number;
  targetModelSeconds: number;
  researchBought: number;
  researchModelCost: number;
  researchModelSeconds: number;
  targetSeconds: number;
  researchSeconds: number;
  timeIncl: number;
  modelTimeIncl: number;
  clickPower: number;
  earned: number;
  boughtUpgrades: number;
  groupRow: Cell[];
  headerRow: Cell[];
};

/** Column addresses plus the two header rows of the Plan sheet (1-based). */
const planLayout = (): PlanCols => {
  const cols: PlanCols = {
    citizens: 0,
    count: {},
    worker: {},
    res: {},
    targetCount: 0,
    targetModelSeconds: 0,
    researchBought: 0,
    researchModelCost: 0,
    researchModelSeconds: 0,
    targetSeconds: 0,
    researchSeconds: 0,
    timeIncl: 0,
    modelTimeIncl: 0,
    clickPower: 0,
    earned: 0,
    boughtUpgrades: 0,
    groupRow: [],
    headerRow: [],
  };
  const groups = new Map<string, number>();
  const headers: Cell[] = [];
  let last = 0;
  const push = (group: string, header: string): number => {
    last += 1;
    if (!groups.has(group)) groups.set(group, last);
    headers.push(header);
    return last;
  };
  cols.citizens = push("Milestone", "citizens");
  push("Milestone", "age (engine)");
  for (const key of PLAN_BUILDINGS) cols.count[key] = push("Buildings (model)", key);
  for (const key of WORKER_RESOURCES) cols.worker[key] = push("Workers (model)", key);
  for (const resource of PLAN_RESOURCES) {
    cols.res[resource] = {};
    for (const slot of RES_SLOTS)
      cols.res[resource][slot] = push(
        `Production: ${resource}`,
        `${slot} (${SLOT_SUFFIX[slot]})`,
      );
  }
  push("Time to next building", "target building");
  cols.targetCount = push("Time to next building", "count (model)");
  push("Time to next building", "capacity (engine)");
  cols.targetSeconds = push("Time to next building", "seconds (engine)");
  cols.targetModelSeconds = push("Time to next building", "seconds (model)");
  cols.researchBought = push("Next research", "researches bought");
  push("Next research", "science cost (engine)");
  cols.researchModelCost = push("Next research", "science cost (model)");
  cols.researchSeconds = push("Next research", "seconds (engine)");
  cols.researchModelSeconds = push("Next research", "seconds (model)");
  cols.timeIncl = push("Summary", "time incl research (engine)");
  cols.modelTimeIncl = push("Summary", "time incl research (model)");
  cols.clickPower = push("Summary", "click power (engine)");
  cols.earned = push("Summary", "achievements earned");
  cols.boughtUpgrades = push("Summary", "upgrades bought");
  cols.groupRow = Array.from({ length: last }, () => null as Cell);
  for (const [group, column] of groups) cols.groupRow[column - 1] = group;
  cols.headerRow = headers;
  return cols;
};

/** The nine-cell production block for one resource on one Plan row. */
const planResourceRow = (
  m: Measurement,
  cols: PlanCols,
  models: Record<string, ResourceModel>,
  resource: string,
  n: number,
): Cell[] => {
  const model = models[resource];
  const engine = m.engines[resource];
  const block = cols.res[resource];
  const cells: Cell[] = [];

  cells.push(engine?.result ?? 0); // production (engine)

  const terms: string[] = [];
  if (WORKER_RESOURCES.includes(resource))
    terms.push(
      `${ref(cols.worker[resource], n)}*${dataRef("Data", 3, DATA.constants[ppwKey(resource)])}`,
    );
  for (const building of BUILDINGS) {
    if (building.production?.resource !== resource) continue;
    const buildingRow = BUILDING_ROW.get(building.key);
    const countColumn = cols.count[building.key];
    if (buildingRow === undefined || countColumn === undefined) continue;
    terms.push(`${ref(countColumn, n)}*${dataRef("Buildings", 15, buildingRow)}`);
  }
  cells.push(
    terms.length > 0
      ? { formula: "=" + terms.join("+"), value: model.structural }
      : model.structural,
  ); // structural (model)
  cells.push(model.flats); // flats (engine)
  cells.push(model.drain); // drain (engine)

  const owned = multiplierBuilding(resource);
  const ownedRow = owned ? BUILDING_ROW.get(owned.key) : undefined;
  const ownedColumn = owned ? cols.count[owned.key] : undefined;
  cells.push(
    owned && ownedRow !== undefined && ownedColumn !== undefined
      ? {
          formula: `=POWER(${dataRef("Buildings", 13, ownedRow)};${ref(ownedColumn, n)})`,
          value: model.building,
        }
      : model.building,
  ); // building x (model)

  const ownerColumn = cols.count[OWNER_BUILDING[resource]];
  const tiers = MULTIPLIER_CHAINS[resource] ?? [];
  if (ownerColumn !== undefined && tiers.length > 0) {
    const chain = tiers
      .map((_, index) => {
        const chainRow = DATA.chainFirstRow + index;
        return `IF(${ref(ownerColumn, n)}>=[Chains.$B$${chainRow}];${dataRef("Chains", DATA.chainValueCols[resource], chainRow)};1)`;
      })
      .join("*");
    cells.push(
      Math.abs(model.singulars - 1) < 1e-12
        ? { formula: `=${chain}`, value: model.achievement }
        : { formula: `=(${chain})*${model.singulars}`, value: model.achievement },
    );
  } else cells.push(model.achievement); // achievement x (model)

  const upgradeRange = DATA.upgradeRows[resource];
  if (upgradeRange && ownerColumn !== undefined) {
    const parts: string[] = [];
    for (let upgradeRow = upgradeRange[0]; upgradeRow <= upgradeRange[1]; upgradeRow += 1)
      parts.push(
        `IF(${ref(ownerColumn, n)}>=[Upgrades.$C$${upgradeRow}];${dataRef("Data", 3, DATA.constants.upgradeTierMultiplier)};1)`,
      );
    cells.push({ formula: "=" + parts.join("*"), value: model.upgrade });
  } else cells.push(model.upgrade); // upgrade x (model)

  cells.push(model.other); // other x (engine)

  cells.push({
    formula:
      `=(${ref(block.structural, n)}+${ref(block.flats, n)})` +
      `*${ref(block.building, n)}*${ref(block.achievement, n)}` +
      `*${ref(block.upgrade, n)}*${ref(block.other, n)}` +
      `-${ref(block.drain, n)}`,
    value: model.production,
  }); // production (model)
  return cells;
};

/** One Plan data row: engine truth as numbers, the toyable model as formulas. */
const planData = (
  m: Measurement,
  cols: PlanCols,
  models: Record<string, ResourceModel>,
  n: number,
): Cell[] => {
  const row: Cell[] = [];
  row.push(m.citizens, m.ageName);

  for (const key of PLAN_BUILDINGS) {
    const value = m.counts[key] ?? 0;
    if (key === "people") row.push({ formula: `=${ref(cols.citizens, n)}`, value });
    else if (key === "house")
      row.push({
        formula: `=MAX(1;ROUNDUP(${ref(cols.citizens, n)}/${inputRef("citizensPerHouse")};0))`,
        value,
      });
    else if (key === "townHall")
      row.push({
        formula: `=MAX(1;ROUNDUP(${ref(cols.count.house, n)}/${inputRef("housesPerTownHall")};0))`,
        value,
      });
    else {
      const inputKey = RATIO_INPUT[key];
      const input = inputKey ? inputRef(inputKey) : null;
      row.push(
        input ? { formula: `=MAX(1;ROUNDUP(${ref(cols.citizens, n)}/${input};0))`, value } : value,
      );
    }
  }

  for (const key of WORKER_RESOURCES) {
    const shareKey = `share${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    row.push({
      formula: `=ROUNDDOWN(${ref(cols.citizens, n)}*${inputRef(shareKey)};0)`,
      value: m.workers[key] ?? 0,
    });
  }

  for (const resource of PLAN_RESOURCES)
    row.push(...planResourceRow(m, cols, models, resource, n));

  const sentinel = "POWER(10;307)";
  const targetKey = inputString("targetBuilding");
  const targetDefinition = buildingDefinitions.find(({ key }) => key === targetKey);
  const targetCountColumn = cols.count[targetKey];
  row.push(targetKey);
  row.push(
    targetCountColumn !== undefined
      ? { formula: `=${ref(targetCountColumn, n)}`, value: m.target.count }
      : m.target.count,
  );
  row.push(m.target.capacity);
  row.push(m.target.seconds);

  const slotParts: string[] = [];
  let rawSeconds = 1e307;
  if (targetCountColumn !== undefined && targetDefinition)
    for (const [slot, cost] of targetDefinition.costs.entries()) {
      const rateColumn = cols.res[cost.resource]?.model;
      const buildingRow = BUILDING_ROW.get(targetKey);
      if (rateColumn === undefined || buildingRow === undefined) continue;
      slotParts.push(
        `IF(${ref(rateColumn, n)}>0;${dataRef("Buildings", 4 + 3 * slot, buildingRow)}` +
          `*POWER(${dataRef("Buildings", 5 + 3 * slot, buildingRow)};${ref(targetCountColumn, n)})` +
          `/${ref(rateColumn, n)};${sentinel})`,
      );
      const rate = models[cost.resource]?.production ?? 0;
      const rawCost = cost.base.toNumber() * cost.factor ** m.target.count;
      rawSeconds = Math.max(rawSeconds, rate > 0 ? rawCost / rate : 1e307);
    }
  row.push(
    slotParts.length > 0
      ? { formula: "=MAX(" + slotParts.join(";") + ")", value: rawSeconds }
      : m.target.seconds,
  );

  const modelScienceCost =
    100 * 10 ** (Math.sqrt(m.nextResearch.bought + 1) - 1);
  const scienceRate = models.science.production;
  row.push(m.nextResearch.bought, m.nextResearch.science);
  row.push({
    formula:
      `=${dataRef("Data", 3, DATA.constants.researchFirstCost)}` +
      `*POWER(${dataRef("Data", 3, DATA.constants.researchCostFactor)};` +
      `SQRT(${ref(cols.researchBought, n)}+1)-1)`,
    value: modelScienceCost,
  });
  row.push(m.nextResearch.seconds);
  row.push({
    formula:
      `=IF(${ref(cols.res.science.model, n)}>0;${ref(cols.researchModelCost, n)}` +
      `/${ref(cols.res.science.model, n)};${sentinel})`,
    value: scienceRate > 0 ? modelScienceCost / scienceRate : 1e307,
  });

  row.push(Math.max(m.target.seconds, m.nextResearch.seconds));
  row.push({
    formula: `=MAX(${ref(cols.targetModelSeconds, n)};${ref(cols.researchModelSeconds, n)})`,
    value: Math.max(rawSeconds, scienceRate > 0 ? modelScienceCost / scienceRate : 1e307),
  });
  row.push(m.clickPower, m.earned, m.boughtUpgrades);
  return row;
};

const planRows = (measurements: Measurement[]): { rows: Cell[][]; cols: PlanCols } => {
  const cols = planLayout();
  const rows: Cell[][] = [cols.groupRow, cols.headerRow];
  measurements.forEach((m, index) => rows.push(planData(m, cols, resourceModels(m), 3 + index)));
  return { rows, cols };
};

/** One row per milestone × building: price and timing of that next unit. */
const targetsRows = (measurements: Measurement[], planCols: PlanCols): Cell[][] => {
  const headers: Cell[] = [
    "citizens",
    "building",
    "count (model)",
    "capacity (engine)",
    "slot1 resource",
    "slot1 cost (engine)",
    "slot2 resource",
    "slot2 cost (engine)",
    "slot3 resource",
    "slot3 cost (engine)",
    "bottleneck",
    "seconds (engine)",
    "seconds (model)",
    "fits",
  ];
  const groupRow: Cell[] = [
    "Milestone",
    null,
    null,
    null,
    "Next unit cost (engine)",
    null,
    null,
    null,
    null,
    null,
    "Timing",
    null,
    null,
    null,
  ];
  const rows: Cell[][] = [groupRow, headers];
  measurements.forEach((m, milestone) => {
    const planRow = 3 + milestone;
    const models = resourceModels(m);
    BUILDINGS.forEach((building, index) => {
      const target = m.targets[building.key];
      const definition = buildingDefinitions[index];
      const n = rows.length + 1;
      const countColumn = planCols.count[building.key];
      const cells: Cell[] = [
        m.citizens,
        building.key,
        countColumn !== undefined
          ? { formula: `=${otherSheetRef("Plan", countColumn, planRow)}`, value: target.count }
          : target.count,
        target.capacity,
      ];
      for (let slot = 0; slot < 3; slot += 1) {
        const cost = target.costs[slot];
        cells.push(cost ? cost.resource : "", cost ? cost.amount : null);
      }
      cells.push(target.bottleneck, target.seconds);

      const slotParts: string[] = [];
      let rawSeconds = 1e307;
      for (const [slot, cost] of (definition?.costs ?? []).entries()) {
        const rateColumn = planCols.res[cost.resource]?.model;
        const buildingRow = BUILDING_ROW.get(building.key);
        if (rateColumn === undefined || buildingRow === undefined) continue;
        const rateRef = otherSheetRef("Plan", rateColumn, planRow);
        slotParts.push(
          `IF(${rateRef}>0;${dataRef("Buildings", 4 + 3 * slot, buildingRow)}` +
            `*POWER(${dataRef("Buildings", 5 + 3 * slot, buildingRow)};${ref(3, n)})` +
            `/${rateRef};POWER(10;307))`,
        );
        const rate = models[cost.resource]?.production ?? 0;
        const rawCost = cost.base.toNumber() * cost.factor ** target.count;
        rawSeconds = Math.max(rawSeconds, rate > 0 ? rawCost / rate : 1e307);
      }
      cells.push(
        slotParts.length > 0
          ? { formula: "=MAX(" + slotParts.join(";") + ")", value: rawSeconds }
          : target.seconds,
      );
      cells.push({
        formula: `=IF(${ref(3, n)}<=${ref(4, n)};"ok";"over capacity")`,
        text: target.count <= target.capacity ? "ok" : "over capacity",
      });
      rows.push(cells);
    });
  });
  return rows;
};

const dump = (rows: Measurement[]): void => {
  const header = [
    "citizens".padEnd(10),
    "age".padEnd(16),
    "halls".padStart(6),
    "farm".padStart(6),
    "lumb".padStart(6),
    "quar".padStart(6),
    "gold".padStart(6),
    "uni".padStart(6),
    "food/s".padStart(12),
    "wood/s".padStart(12),
    "sci/s".padStart(12),
    "achXfood".padStart(10),
    "nextFarm".padStart(12),
    "tFarm".padStart(9),
    "tRes".padStart(9),
  ];
  console.log(header.join(" "));
  for (const row of rows) {
    console.log(
      [
        String(row.citizens).padEnd(10),
        row.ageName.padEnd(16),
        String(row.counts["townHall"]).padStart(6),
        String(row.counts.farm).padStart(6),
        String(row.counts["lumberYard"]).padStart(6),
        String(row.counts.quarry).padStart(6),
        String(row.counts["goldMine"]).padStart(6),
        String(row.counts.university).padStart(6),
        compact(row.rates.food).padStart(12),
        compact(row.rates.wood).padStart(12),
        compact(row.rates.science).padStart(12),
        compact(row.categories.food?.achievement ?? 1).padStart(10),
        compact(row.target.costs[0]?.amount ?? 0).padStart(12),
        formatSeconds(row.target.seconds).padStart(9),
        formatSeconds(row.nextResearch.seconds).padStart(9),
      ].join(" "),
    );
  }
};

const main = (): void => {
  const measurements = CITIZENS.map(measure);
  if (process.argv.includes("--dump")) {
    dump(measurements);
    return;
  }

  // Address-bookkeeping builders run first: planRows/targetsRows read their maps.
  const dataSheet = constantsRows();
  const buildingsSheet = buildingsRows();
  const chainsSheet = chainRows();
  const upgradesSheet = upgradeRows();
  const hoardersSheet = hoarderRows();
  const agesSheet = agesRows();
  const { rows: plan, cols } = planRows(measurements);
  const targets = targetsRows(measurements, cols);
  const sheets: [string, Cell[][]][] = [
    ["Plan", plan],
    ["Inputs", inputsRows()],
    ["Targets", targets],
    ["Data", dataSheet],
    ["Buildings", buildingsSheet],
    ["Chains", chainsSheet],
    ["Upgrades", upgradesSheet],
    ["Hoarders", hoardersSheet],
    ["Ages", agesSheet],
    ["Notes", notesRows()],
  ];

  const outDir = path.join(process.cwd(), "temp");
  fs.writeFileSync(path.join(outDir, "balance-plan.fods"), fodsDocument(sheets), "utf8");
  fs.writeFileSync(path.join(outDir, "balance-plan.csv"), csvText(plan), "utf8");
  for (const line of new Set(MISMATCHES)) console.warn(`model vs engine: ${line}`);
  console.log(
    `wrote temp/balance-plan.fods (${sheets.length} sheets) and temp/balance-plan.csv ` +
      `(${measurements.length} milestones, ${plan[1].length} columns)`,
  );
};

main();



