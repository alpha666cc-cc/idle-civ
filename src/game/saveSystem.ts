import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  type ProductionResourceKey,
  type ResourceFactor,
  type ResourceFactorMap,
  type ResourceFactors,
  type ResourceKey,
} from "./attributes";
import type { BuildingCost } from "./buildings";
import { snapshotGuids } from "./dataIds";
import { ExpNumber } from "./expNumber";
import { CivilizationState } from "./civilizationState";
import { emptyStatistics, type Statistics } from "./statistics";

/**
 * Save system (roadmap Milestone 3).
 *
 * The save is a versioned document with JSON and XML representations. Every
 * unbounded number is written as the
 * `ExpNumber` scientific-notation string, so a save is readable, diffable and
 * immune to the double-overflow that would come from storing mantissas alone.
 *
 * `SaveData.referencedGuids` is the static-content snapshot (id → guid, §dataIds):
 * a save keeps the guid of every content id it names, so renaming content later
 * can be migrated instead of silently dropping a player's upgrades.
 */

/** Bump when the shape changes; `migrateSaveData` handles older documents. */
export const SAVE_VERSION = 1;

/** How a save travels: the same document, three encodings. */
export type SaveFormat = "base64" | "json" | "xml";

export type SavedActionMultiplier =
  | 1
  | 10
  | 100
  | 1000
  | 10000
  | 100000
  | 1000000
  | 10000000
  | 100000000
  | 1000000000
  | "Max";

/** One save file's identity; stable from creation through import/export. */
export type SaveGuid = string;

/** Offline production runs at 25% of the live rate (roadmap Milestone 3). */
export const OFFLINE_EFFICIENCY = 0.25;

/** Offline accrual is capped at 12 hours, per the roadmap. */
export const MAX_OFFLINE_MS = 12 * 60 * 60 * 1000;

/** A cost entry with its `ExpNumber` base flattened to a string. */
export type SerializedBuildingCost = {
  readonly resource: ResourceKey;
  readonly base: string;
  readonly factor: number;
};

/** `[sourceLabel, value]` pairs, the serialized form of `ResourceFactor`. */
export type SerializedFactors = {
  readonly additional: readonly (readonly [string, string])[];
  readonly multiplicative: readonly (readonly [string, string])[];
  readonly drain: readonly (readonly [string, string])[];
};

export type SerializedResourceFactors = Record<string, SerializedFactors>;

export type SerializedStatistics = {
  readonly productionClicks: string;
  readonly uiClicks: string;
  readonly buildingsBuilt: string;
  readonly buildingsBuiltByKey: Record<string, string>;
  readonly playTimeMs: number;
  readonly runTimeMs: number;
  readonly onlineTimeMs: number;
  readonly offlineTimeMs: number;
  readonly longestOfflineMs: number;
  readonly longestActiveMs: number;
  readonly activeStreakMs: number;
  readonly fastestAgeMs: Record<string, number>;
  readonly fastestBattleMs: Record<string, number>;
  readonly wastedResources: string;
};

export type SaveData = {
  readonly version: number;
  /** Created once and carried through every autosave and export. */
  readonly guid: SaveGuid;
  /** When this save file was first created. */
  readonly createdAtMs: number;
  /** When this document was last written — the offline-gain reference point. */
  readonly savedAtMs: number;
  readonly resources: Record<string, string>;
  readonly workers: Record<string, string>;
  /** Legacy v1 field accepted while importing older array-based saves. */
  readonly builtBuildings?: string[];
  /** Building id -> count; order is intentionally not persisted. */
  readonly buildingCounts: Record<string, string>;
  readonly resourceFactors: SerializedResourceFactors;
  readonly buildingCostOverrides: Record<string, SerializedBuildingCost[]>;
  readonly autoClicksPerSecond: number;
  readonly boughtUpgrades: string[];
  readonly defeatedEncounters: string[];
  readonly enteredAges: string[];
  readonly earnedAchievements: string[];
  readonly statistics: SerializedStatistics;
  readonly unitCounts: Record<string, string>;
  readonly devProductionMultiplier: string;
  readonly freeBuildings: boolean;
  readonly freeUnits: boolean;
  readonly freeUpgrades: boolean;
  readonly actionMultiplier: SavedActionMultiplier;
  readonly largeMultiplier: number;
  readonly dismissedAchievements: string[];
  /** Content id → static guid, for every id this save names. */
  readonly referencedGuids: Record<string, string>;
};

export type SaveUiState = {
  readonly actionMultiplier?: SavedActionMultiplier;
  readonly largeMultiplier?: number;
  readonly dismissedAchievements?: readonly string[];
};

/** Raised for anything a save file cannot be trusted to contain. */
export class SaveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveFormatError";
  }
}

/**
 * A new save guid. Prefers `crypto.randomUUID`; the fallback exists only for
 * non-secure contexts and is not a security boundary.
 */
export const generateSaveGuid = (): SaveGuid => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  let guid = "";
  for (const byte of [8, 4, 4, 4, 12]) {
    if (guid.length > 0) guid += "-";
    for (let index = 0; index < byte; index += 1) {
      guid += Math.floor(Math.random() * 16).toString(16);
    }
  }
  return guid;
};

/** The JSON document itself, pretty-printed so a save stays diffable. */
export const saveToJson = (data: SaveData): string =>
  JSON.stringify(data, null, 2);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate the fields a save cannot work without. Returns the reason it is
 * unusable, or `null` when the document is structurally sound. The checks are
 * deliberately shallow: unknown extra keys are allowed (forward compatibility),
 * and ids that no longer exist are reported by `findUnknownContentIds` instead
 * of blocking the load.
 */
export const describeSaveProblem = (value: unknown): string | null => {
  if (!isRecord(value)) return "The save is not a JSON object.";
  if (typeof value.version !== "number") return "The save has no version.";
  if (value.version > SAVE_VERSION) {
    return `The save was written by a newer build (version ${value.version}).`;
  }
  if (typeof value.guid !== "string" || value.guid.length === 0) {
    return "The save has no GUID.";
  }
  if (
    typeof value.savedAtMs !== "number" ||
    !Number.isFinite(value.savedAtMs)
  ) {
    return "The save has no timestamp.";
  }
  if (!isRecord(value.resources)) return "The save has no resources.";
  return null;
};

/** Parse a JSON document into a validated `SaveData`. */
export const saveFromJson = (json: string): SaveData => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SaveFormatError("That text is not valid JSON.");
  }
  const problem = describeSaveProblem(parsed);
  if (problem) throw new SaveFormatError(problem);
  return migrateSaveData(parsed as SaveData);
};

/**
 * Upgrade older documents to the current version. There is nothing to rewrite
 * yet (version 1 is the first), so this is where every migration lands: read the
 * old field, write the new one, bump `version` — and touch nothing else, so
 * unknown-but-valid data survives the trip.
 */
export const migrateSaveData = (data: SaveData): SaveData => {
  if (data.version === SAVE_VERSION) return data;
  if (data.version > SAVE_VERSION) {
    throw new SaveFormatError(
      `The save was written by a newer build (version ${data.version}).`,
    );
  }
  return { ...data, version: SAVE_VERSION };
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};

const xmlAttribute = (value: string): string =>
  escapeXml(value).replaceAll("'", "&apos;");

const xmlValue = (value: unknown): string => {
  if (typeof value === "string") {
    return `<value type="string">${escapeXml(value)}</value>`;
  }
  if (typeof value === "number") {
    return `<value type="number">${value}</value>`;
  }
  if (typeof value === "boolean") {
    return `<value type="boolean">${value}</value>`;
  }
  if (Array.isArray(value)) {
    return `<array>${value.map((item) => `<item>${xmlValue(item)}</item>`).join("")}</array>`;
  }
  if (isRecord(value)) {
    return `<object>${Object.entries(value)
      .map(
        ([key, item]) =>
          `<field name="${xmlAttribute(key)}">${xmlValue(item)}</field>`,
      )
      .join("")}</object>`;
  }
  return `<value type="null" />`;
};

const xmlEntity = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const parseXmlAttributes = (text: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z][\w-]*)\s*=\s*"([^"]*)"/g;
  for (const match of text.matchAll(pattern)) {
    attributes[match[1]] = xmlEntity(match[2]);
  }
  return attributes;
};

const parseXmlTree = (xml: string): XmlNode => {
  const root: XmlNode = {
    name: "root",
    attributes: {},
    children: [],
    text: "",
  };
  const stack = [root];
  const tokens = /<\/?[A-Za-z][^>]*>|[^<]+/g;
  for (const token of xml.matchAll(tokens)) {
    const part = token[0];
    if (part.startsWith("<?") || part.startsWith("<!--")) continue;
    if (!part.startsWith("<")) {
      stack[stack.length - 1].text += xmlEntity(part);
      continue;
    }
    if (part.startsWith("</")) {
      if (stack.length === 1) throw new SaveFormatError("Malformed XML save.");
      stack.pop();
      continue;
    }
    const selfClosing = part.endsWith("/>");
    const tag = part.match(/^<([A-Za-z][\w-]*)([^>]*)>$/);
    if (!tag) throw new SaveFormatError("Malformed XML save.");
    const node: XmlNode = {
      name: tag[1],
      attributes: parseXmlAttributes(tag[2]),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || root.children.length !== 1) {
    throw new SaveFormatError("Malformed XML save.");
  }
  return root.children[0];
};

const parseXmlValue = (node: XmlNode): unknown => {
  if (node.name === "value") {
    if (node.attributes.type === "number") return Number(node.text);
    if (node.attributes.type === "boolean") return node.text === "true";
    if (node.attributes.type === "null") return null;
    return node.text;
  }
  if (node.name === "array") {
    return node.children
      .filter((child) => child.name === "item")
      .map((child) => parseXmlValue(child.children[0]));
  }
  if (node.name === "object") {
    const object: Record<string, unknown> = {};
    for (const field of node.children.filter(
      (child) => child.name === "field",
    )) {
      if (field.children[0])
        object[field.attributes.name] = parseXmlValue(field.children[0]);
    }
    return object;
  }
  throw new SaveFormatError("Malformed XML save value.");
};

/** Serialize a save as typed XML, without embedding JSON or CDATA. */
export const saveToXml = (data: SaveData): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<save version="${data.version}" guid="${xmlAttribute(data.guid)}" createdAtMs="${data.createdAtMs}" savedAtMs="${data.savedAtMs}">`,
    xmlValue({
      ...data,
      version: undefined,
      guid: undefined,
      createdAtMs: undefined,
      savedAtMs: undefined,
    }),
    "</save>",
    "",
  ].join("\n");

/** Parse the typed XML interchange back into `SaveData`. */
export const saveFromXml = (xml: string): SaveData => {
  const root = parseXmlTree(xml);
  if (root.name !== "save")
    throw new SaveFormatError("That XML has no save root.");
  const object = root.children.find((child) => child.name === "object");
  if (!object) throw new SaveFormatError("That XML has no save data.");
  const parsed = parseXmlValue(object) as Record<string, unknown>;
  return saveFromJson(
    JSON.stringify({
      ...parsed,
      version: Number(root.attributes.version),
      guid: root.attributes.guid,
      createdAtMs: Number(root.attributes.createdAtMs),
      savedAtMs: Number(root.attributes.savedAtMs),
    }),
  );
};
/** Base64 over UTF-8 bytes, so a save carrying non-ASCII text survives. */
export const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const fromBase64 = (base64: string): string => {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

export const saveToBase64 = (data: SaveData): string =>
  toBase64(saveToJson(data));

export const saveFromBase64 = (base64: string): SaveData => {
  let json: string;
  try {
    json = fromBase64(base64);
  } catch {
    throw new SaveFormatError("That text is not valid Base64.");
  }
  return saveFromJson(json);
};

/** Encode a save in the chosen interchange format. */
export const serializeSave = (data: SaveData, format: SaveFormat): string => {
  if (format === "base64") return saveToBase64(data);
  if (format === "xml") return saveToXml(data);
  return saveToJson(data);
};

/** Decode a save from the chosen interchange format. */
export const parseSave = (text: string, format: SaveFormat): SaveData => {
  if (format === "base64") return saveFromBase64(text);
  if (format === "xml") return saveFromXml(text);
  return saveFromJson(text);
};

/**
 * Detect the interchange format of a document, used when a file's extension is
 * not trusted and to let a pasted Base64 string work even when the Base64 radio
 * is not the selected one.
 */
export const detectSaveFormat = (text: string): SaveFormat | null => {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) return "xml";
  if (trimmed.startsWith("{")) return "json";
  if (trimmed.length === 0) return null;
  try {
    if (fromBase64(trimmed).trim().startsWith("{")) return "base64";
  } catch {
    // Not Base64 — fall through to "unknown".
  }
  return null;
};

export const fileExtensionFor = (format: SaveFormat): string =>
  format === "xml" ? "xml" : "json";

/** `idle-civ-<guid prefix>-<date>.<ext>` — identifiable in a downloads folder. */
export const saveFileName = (data: SaveData, format: SaveFormat): string => {
  const date = new Date(data.savedAtMs).toISOString().replace(/[:.]/g, "-");
  return `idle-civ-${data.guid.slice(0, 8)}-${date}.${fileExtensionFor(format)}`;
};

/**
 * Content ids a save names that no longer exist in the data files. The UI
 * reports them on import (the engine drops the stale ids, the rest of the save
 * loads), and the save tests assert the list stays empty across data edits.
 */
export const findUnknownContentIds = (
  data: SaveData,
  known: (id: string) => boolean,
): string[] => {
  const ids = new Set<string>([
    ...(data.boughtUpgrades ?? []),
    ...(data.defeatedEncounters ?? []),
    ...(data.enteredAges ?? []),
    ...(data.earnedAchievements ?? []),
    ...Object.keys(
      data.buildingCounts ?? legacyBuildingCounts(data.builtBuildings),
    ),
    ...Object.keys(data.unitCounts ?? {}),
  ]);
  return [...ids].filter((id) => id.length > 0 && !known(id)).sort();
};

const countBuildings = (
  builtBuildings: readonly string[],
): Record<string, string> => {
  const counts: Record<string, number> = {};
  for (const key of builtBuildings) counts[key] = (counts[key] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [key, String(count)]),
  );
};

const legacyBuildingCounts = (
  builtBuildings: readonly string[] | undefined,
): Record<string, string> => countBuildings(builtBuildings ?? []);

const expandBuildingCounts = (counts: Record<string, string>): string[] => {
  const buildings: string[] = [];
  for (const [key, rawCount] of Object.entries(counts)) {
    const count = Math.max(0, Math.floor(Number(rawCount)));
    for (let index = 0; index < count; index += 1) buildings.push(key);
  }
  return buildings;
};

/**
 * Rename repair — what the static GUIDs are for.
 *
 * A save names content by id. When content is renamed between builds the old id
 * no longer resolves, but the save's own `referencedGuids` snapshot still holds
 * that entry's static guid, and the guid still points at the entry under its new
 * id. This re-points the id-lists (and the id-keyed records) accordingly and
 * reports the ids that could not be resolved at all, so the player can be told
 * which content was dropped instead of silently losing it.
 */
export const remapSaveIds = (
  data: SaveData,
  isKnownId: (id: string) => boolean,
  resolveIdByGuid: (guid: string) => string | undefined,
): { data: SaveData; renamed: Record<string, string>; unknown: string[] } => {
  const snapshot = data.referencedGuids ?? {};
  const renames: Record<string, string> = {};
  const unknown: string[] = [];

  const remapId = (id: string): string => {
    if (isKnownId(id)) return id;
    const guid = snapshot[id];
    const replacement = guid ? resolveIdByGuid(guid) : undefined;
    if (replacement && replacement !== id) {
      renames[id] = replacement;
      return replacement;
    }
    if (id.length > 0) unknown.push(id);
    return id;
  };

  const remapList = (ids: readonly string[]): string[] => ids.map(remapId);

  const remapRecord = (
    entries: Record<string, unknown>,
    renameKeys: boolean,
  ): Record<string, unknown> => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entries)) {
      next[renameKeys ? remapId(key) : key] = value;
    }
    return next;
  };

  const repaired: SaveData = {
    ...data,
    buildingCounts: remapRecord(
      data.buildingCounts ?? legacyBuildingCounts(data.builtBuildings),
      true,
    ) as Record<string, string>,
    boughtUpgrades: remapList(data.boughtUpgrades ?? []),
    defeatedEncounters: remapList(data.defeatedEncounters ?? []),
    enteredAges: remapList(data.enteredAges ?? []),
    earnedAchievements: remapList(data.earnedAchievements ?? []),
    unitCounts: remapRecord(data.unitCounts ?? {}, true) as Record<
      string,
      string
    >,
    buildingCostOverrides: remapRecord(
      data.buildingCostOverrides ?? {},
      true,
    ) as SaveData["buildingCostOverrides"],
    statistics: {
      ...data.statistics,
      buildingsBuiltByKey: remapRecord(
        data.statistics?.buildingsBuiltByKey ?? {},
        true,
      ) as Record<string, string>,
    },
  };

  return { data: repaired, renamed: renames, unknown: [...new Set(unknown)] };
};

/**
 * Offline production for a gap of `elapsedMs`, from the live per-resource rates.
 * Rates are `ExpNumber` (a resource can produce 1e30/s) and the whole gain stays
 * in `ExpNumber`, so a long absence cannot overflow a double. The gap is capped
 * at `MAX_OFFLINE_MS` (12 h) and paid at `OFFLINE_EFFICIENCY` (25%).
 */
export const calculateOfflineGain = (
  rates: Partial<Record<ResourceKey, ExpNumber>>,
  elapsedMs: number,
  efficiency = OFFLINE_EFFICIENCY,
): Record<string, ExpNumber> => {
  const gain: Record<string, ExpNumber> = {};
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return gain;
  const cappedMs = Math.min(elapsedMs, MAX_OFFLINE_MS);
  const seconds = ExpNumber.fromNumber(cappedMs / 1000);
  const factor = ExpNumber.fromNumber(efficiency);

  for (const [key, rate] of Object.entries(rates)) {
    if (!rate || !rate.isFinite || rate.sign <= 0) continue;
    const amount = rate.mul(seconds).mul(factor);
    if (amount.isZero || !amount.isFinite) continue;
    gain[key] = amount;
  }
  return gain;
};

/** Total offline time a gap represents after the 12-hour cap, in ms. */
export const cappedOfflineMs = (elapsedMs: number): number =>
  Math.max(0, Math.min(elapsedMs, MAX_OFFLINE_MS));
const serializeFactor = ([source, value]: ResourceFactor): [string, string] => [
  typeof source === "string" ? source : source.id,
  value.toString(),
];

const deserializeFactors = (
  data: SerializedFactors | undefined,
): ResourceFactors => {
  const pair = ([source, value]: readonly [string, string]): ResourceFactor => [
    source,
    ExpNumber.from(value),
  ];
  return {
    additional: (data?.additional ?? []).map(pair),
    multiplicative: (data?.multiplicative ?? []).map(pair),
    drain: (data?.drain ?? []).map(pair),
  };
};

export const serializeFactorMap = (
  factors: ResourceFactorMap,
): SerializedResourceFactors => {
  const serialized: SerializedResourceFactors = {};
  for (const [key, value] of Object.entries(factors)) {
    serialized[key] = {
      additional: value.additional.map(serializeFactor),
      multiplicative: value.multiplicative.map(serializeFactor),
      drain: value.drain.map(serializeFactor),
    };
  }
  return serialized;
};

export const deserializeFactorMap = (
  data: SerializedResourceFactors | undefined,
): ResourceFactorMap => {
  const factors = emptyResourceFactors();
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!(key in factors)) continue;
    factors[key as ResourceKey] = deserializeFactors(value);
  }
  return factors;
};

export const serializeStatistics = (
  statistics: Statistics,
): SerializedStatistics => ({
  productionClicks: statistics.productionClicks.toString(),
  uiClicks: statistics.uiClicks.toString(),
  buildingsBuilt: statistics.buildingsBuilt.toString(),
  buildingsBuiltByKey: Object.fromEntries(
    Object.entries(statistics.buildingsBuiltByKey).map(([key, value]) => [
      key,
      value.toString(),
    ]),
  ),
  playTimeMs: statistics.playTimeMs,
  runTimeMs: statistics.runTimeMs,
  onlineTimeMs: statistics.onlineTimeMs,
  offlineTimeMs: statistics.offlineTimeMs,
  longestOfflineMs: statistics.longestOfflineMs,
  longestActiveMs: statistics.longestActiveMs,
  activeStreakMs: statistics.activeStreakMs,
  fastestAgeMs: { ...statistics.fastestAgeMs },
  fastestBattleMs: { ...statistics.fastestBattleMs },
  wastedResources: statistics.wastedResources.toString(),
});

export const deserializeStatistics = (
  data: SerializedStatistics | undefined,
): Statistics => {
  const base = emptyStatistics();
  if (!data) return base;
  const buildingsBuiltByKey: Record<string, ExpNumber> = {};
  for (const [key, value] of Object.entries(data.buildingsBuiltByKey ?? {})) {
    buildingsBuiltByKey[key] = ExpNumber.from(value);
  }
  return {
    productionClicks: ExpNumber.from(data.productionClicks ?? 0),
    uiClicks: ExpNumber.from(data.uiClicks ?? 0),
    buildingsBuilt: ExpNumber.from(data.buildingsBuilt ?? 0),
    buildingsBuiltByKey,
    playTimeMs: data.playTimeMs ?? 0,
    runTimeMs: data.runTimeMs ?? 0,
    onlineTimeMs: data.onlineTimeMs ?? data.playTimeMs ?? 0,
    offlineTimeMs: data.offlineTimeMs ?? 0,
    longestOfflineMs: data.longestOfflineMs ?? 0,
    longestActiveMs: data.longestActiveMs ?? data.playTimeMs ?? 0,
    activeStreakMs: data.activeStreakMs ?? 0,
    fastestAgeMs: { ...(data.fastestAgeMs ?? {}) },
    fastestBattleMs: { ...(data.fastestBattleMs ?? {}) },
    wastedResources: ExpNumber.from(data.wastedResources ?? 0),
  };
};

const serializeCost = (cost: BuildingCost): SerializedBuildingCost => ({
  resource: cost.resource,
  base: cost.base.toString(),
  factor: cost.factor,
});

const deserializeCost = (cost: SerializedBuildingCost): BuildingCost => ({
  resource: cost.resource,
  base: ExpNumber.from(cost.base),
  factor: cost.factor,
});
/** Every content id the save names, for the `referencedGuids` snapshot. */
export const collectReferencedIds = (state: CivilizationState): string[] => {
  const ids = new Set<string>([
    ...state.boughtUpgrades,
    ...state.defeatedEncounters,
    ...state.enteredAges,
    ...state.earnedAchievements,
    ...Object.keys(countBuildings(state.builtBuildings)),
    ...Object.keys(state.unitCounts),
    ...Object.keys(state.statistics.buildingsBuiltByKey),
    ...Object.keys(state.buildingCostOverrides),
    ...Object.keys(state.resources),
    ...Object.keys(state.resourceFactors),
  ]);
  return [...ids].filter((id) => id.length > 0);
};

/**
 * Snapshot the current state into a save document.
 * `guid` and `createdAtMs` are carried over from the previous document so an
 * autosave writes a new timestamp onto the same save-file identity.
 */
export const createSaveData = (
  state: CivilizationState,
  guid: SaveGuid = generateSaveGuid(),
  createdAtMs: number = Date.now(),
  uiState: SaveUiState = {},
): SaveData => ({
  version: SAVE_VERSION,
  guid,
  createdAtMs,
  savedAtMs: Date.now(),
  resources: Object.fromEntries(
    Object.entries(state.resources).map(([key, value]) => [
      key,
      value.toString(),
    ]),
  ),
  workers: Object.fromEntries(
    Object.entries(state.workers).map(([key, value]) => [
      key,
      value.toString(),
    ]),
  ),
  buildingCounts: countBuildings(state.builtBuildings),
  resourceFactors: serializeFactorMap(state.resourceFactors),
  buildingCostOverrides: Object.fromEntries(
    Object.entries(state.buildingCostOverrides).map(([key, costs]) => [
      key,
      (costs ?? []).map(serializeCost),
    ]),
  ),
  autoClicksPerSecond: state.autoClicksPerSecond,
  boughtUpgrades: [...state.boughtUpgrades],
  defeatedEncounters: [...state.defeatedEncounters],
  enteredAges: [...state.enteredAges],
  earnedAchievements: [...state.earnedAchievements],
  statistics: serializeStatistics(state.statistics),
  unitCounts: Object.fromEntries(
    Object.entries(state.unitCounts).map(([key, value]) => [
      key,
      value.toString(),
    ]),
  ),
  devProductionMultiplier: state.devProductionMultiplier.toString(),
  freeBuildings: state.freeBuildings,
  freeUnits: state.freeUnits,
  freeUpgrades: state.freeUpgrades,
  actionMultiplier: uiState.actionMultiplier ?? 1,
  largeMultiplier: uiState.largeMultiplier ?? 100,
  dismissedAchievements: [...(uiState.dismissedAchievements ?? [])],
  referencedGuids: snapshotGuids(collectReferencedIds(state)),
});

/**
 * Rebuild a `CivilizationState` from a save document. Every value is re-derived
 * into a fresh object, so a loaded state never shares a mutable reference with
 * the parsed document, and an out-of-range key in the file is ignored rather
 * than injected into the state.
 */
export const loadSaveData = (data: SaveData): CivilizationState => {
  const resources = emptyResourceAmounts();
  for (const [key, value] of Object.entries(data.resources ?? {})) {
    if (!(key in resources)) continue;
    resources[key as ResourceKey] = ExpNumber.from(value);
  }

  const workers = emptyWorkerAssignments();
  for (const key of Object.keys(workers) as ProductionResourceKey[]) {
    workers[key] = ExpNumber.from(data.workers?.[key] ?? 0);
  }

  const unitCounts: Record<string, ExpNumber> = {};
  for (const [key, value] of Object.entries(data.unitCounts ?? {})) {
    const count = ExpNumber.from(value);
    if (count.lte(ExpNumber.ZERO)) continue;
    unitCounts[key] = count;
  }

  const costOverrides: Record<string, BuildingCost[]> = {};
  for (const [key, costs] of Object.entries(data.buildingCostOverrides ?? {})) {
    costOverrides[key] = (costs ?? []).map(deserializeCost);
  }

  return new CivilizationState(
    resources,
    workers,
    expandBuildingCounts(
      data.buildingCounts ?? legacyBuildingCounts(data.builtBuildings),
    ),
    deserializeFactorMap(data.resourceFactors),
    costOverrides,
    data.autoClicksPerSecond ?? 0,
    [...(data.boughtUpgrades ?? [])],
    [...(data.defeatedEncounters ?? [])],
    [...(data.enteredAges ?? [])],
    [...(data.earnedAchievements ?? [])],
    deserializeStatistics(data.statistics),
    unitCounts,
    ExpNumber.from(data.devProductionMultiplier ?? 1),
    data.freeBuildings ?? false,
    data.freeUnits ?? false,
    data.freeUpgrades ?? false,
  );
};
