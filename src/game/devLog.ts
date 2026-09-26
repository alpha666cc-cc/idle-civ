/**
 * Dev-mode run log.
 *
 * Mirrors the headless simulator's timeline (`tools/simulation.ts`) so a real
 * session can be lined up against a simulation: remarkable events on the same
 * game-second clock, plus a periodic snapshot. The document is pure data, so it
 * travels in the save's dev section and survives a reload; writing it to
 * `saves/auto/` is the transport's job, not this module's.
 */
import { buildingDefinitions } from "./buildings";
import type { ResourceKey } from "./attributes";
import { ExpNumber } from "./expNumber";
import type { CivilizationState } from "./civilizationState";

/** Bump when the log document's shape changes. */
export const DEV_LOG_VERSION = 1;

/** Snapshots land on this cadence, matching the simulator's default. */
export const DEFAULT_DEV_LOG_SNAPSHOT_SECONDS = 300;

export type DevLogEventType =
  | "age"
  | "battle"
  | "upgrade"
  | "research"
  | "achievement"
  | "load"
  | "reset";

/** One remarkable thing that happened, at the game-second it happened. */
export type DevLogEvent = {
  readonly time: number;
  readonly type: DevLogEventType;
  readonly id: string;
  /** Free text: where a save came from, how much offline time it credited. */
  readonly detail?: string;
  readonly population: string;
  readonly resources: Record<string, string>;
  readonly productionRates: Record<string, string>;
};

/** A full state reading, on the same cadence the simulator uses. */
export type DevLogSnapshot = {
  readonly time: number;
  readonly age: string;
  readonly population: string;
  readonly resources: Record<string, string>;
  readonly productionRates: Record<string, string>;
  readonly buildings: { readonly building: string; readonly count: string }[];
  readonly units: { readonly unit: string; readonly count: string }[];
  readonly researches: string[];
  readonly battlesWon: number;
  readonly totalBuildings: string;
  readonly militaryPower: string;
};

export type DevLogDocument = {
  readonly version: number;
  /** Identifies the run, and names the file under `saves/auto`. */
  readonly runId: string;
  /**
   * The file this log lives in, decided once when the run starts and then
   * carried in the save. Keeping it here — rather than re-deriving it — is what
   * makes a log survive closing and reopening the browser: every session writes
   * back to the path the save remembers, and only a reset picks a new one.
   */
  readonly fileName: string;
  readonly startedAtMs: number;
  readonly snapshotIntervalSeconds: number;
  readonly events: DevLogEvent[];
  readonly snapshots: DevLogSnapshot[];
};

const toStrings = (
  values: Partial<Record<ResourceKey, ExpNumber>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value.toString()]),
  );

/**
 * The log's clock: game seconds since the run started. `runTimeMs` advances one
 * second per tick, so it lines up with the simulator's `gameTime`.
 */
export const devLogGameSeconds = (state: CivilizationState): number =>
  state.statistics.runTimeMs / 1000;

export const createDevLog = (
  runId: string,
  startedAtMs: number = Date.now(),
  snapshotIntervalSeconds: number = DEFAULT_DEV_LOG_SNAPSHOT_SECONDS,
): DevLogDocument => ({
  version: DEV_LOG_VERSION,
  runId,
  startedAtMs,
  snapshotIntervalSeconds:
    Number.isFinite(snapshotIntervalSeconds) && snapshotIntervalSeconds > 0
      ? snapshotIntervalSeconds
      : DEFAULT_DEV_LOG_SNAPSHOT_SECONDS,
  fileName: devLogFileName(runId, startedAtMs),
  events: [],
  snapshots: [],
});

/** The resource/rate reading every event and snapshot carries. */
const reading = (state: CivilizationState) => ({
  population: state.population.toString(),
  resources: toStrings(state.resources),
  productionRates: toStrings(state.getProductionRates()),
});

export const buildDevLogEvent = (
  state: CivilizationState,
  type: DevLogEventType,
  id: string,
  time: number,
  detail?: string,
): DevLogEvent => ({
  time,
  type,
  id,
  ...(detail === undefined ? {} : { detail }),
  ...reading(state),
});

export const buildDevLogSnapshot = (
  state: CivilizationState,
  time: number,
): DevLogSnapshot => ({
  time,
  age: state.getCurrentAge()?.key ?? "none",
  ...reading(state),
  buildings: buildingDefinitions
    .map((building) => ({
      building: building.key,
      count: state.getBuildingCount(building.key).toString(),
    }))
    .filter(({ count }) => count !== "0"),
  units: Object.entries(state.unitCounts)
    .filter(([, count]) => count.gt(ExpNumber.ZERO))
    .map(([unit, count]) => ({ unit, count: count.toString() })),
  researches: [...state.boughtResearch],
  battlesWon: state.defeatedEncounters.length,
  totalBuildings: state.statistics.buildingsBuilt.toString(),
  militaryPower: state.getArmyPower().toString(),
});

/**
 * New ids in an append-only progression list. The length check is a fast path:
 * these lists only ever grow, so an unchanged length means nothing was added.
 */
const addedIds = (before: readonly string[], after: readonly string[]): string[] => {
  if (after.length <= before.length) return [];
  const seen = new Set(before);
  return after.filter((id) => !seen.has(id));
};

/** The remarkable events between two states, in a stable order. */
export const diffDevLogEvents = (
  before: CivilizationState,
  after: CivilizationState,
  time: number,
): DevLogEvent[] => {
  const events: DevLogEvent[] = [];
  const add = (type: DevLogEventType, ids: string[]) => {
    for (const id of ids) events.push(buildDevLogEvent(after, type, id, time));
  };
  add("age", addedIds(before.enteredAges, after.enteredAges));
  add("battle", addedIds(before.defeatedEncounters, after.defeatedEncounters));
  add("upgrade", addedIds(before.boughtUpgrades, after.boughtUpgrades));
  add("research", addedIds(before.boughtResearch, after.boughtResearch));
  add(
    "achievement",
    addedIds(before.earnedAchievements, after.earnedAchievements),
  );
  return events;
};

/** Whether the snapshot cadence has come due again. Always fires the first one. */
export const isDevLogSnapshotDue = (log: DevLogDocument, time: number): boolean => {
  const last = log.snapshots[log.snapshots.length - 1];
  if (!last) return true;
  return time - last.time >= log.snapshotIntervalSeconds;
};

/** Appends an event, ignoring one already recorded (events are id-unique). */
export const appendDevLogEvent = (
  log: DevLogDocument,
  event: DevLogEvent,
): DevLogDocument => {
  if (log.events.some((entry) => entry.type === event.type && entry.id === event.id)) {
    return log;
  }
  return { ...log, events: [...log.events, event] };
};

export const appendDevLogSnapshot = (
  log: DevLogDocument,
  snapshot: DevLogSnapshot,
): DevLogDocument => ({ ...log, snapshots: [...log.snapshots, snapshot] });

/** `idle-civ-run-<run prefix>-<date>.json`, written under `saves/auto`. */
export const devLogFileName = (
  runId: string,
  startedAtMs: number,
): string => {
  const date = new Date(startedAtMs).toISOString().replace(/[:.]/g, "-");
  return `idle-civ-run-${runId.slice(0, 8)}-${date}.json`;
};

/** The log as it is written to disk, pretty-printed so it stays diffable. */
export const serializeDevLog = (log: DevLogDocument): string =>
  JSON.stringify(log, null, 2);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read a log back out of a save. A missing or malformed section yields `null`
 * rather than throwing: the log is a diagnostic, so a broken one must never
 * stop a save from loading.
 */
export const devLogFromSave = (value: unknown): DevLogDocument | null => {
  if (!isRecord(value)) return null;
  if (typeof value.runId !== "string" || value.runId.length === 0) return null;
  if (typeof value.startedAtMs !== "number") return null;
  if (!Array.isArray(value.events) || !Array.isArray(value.snapshots)) return null;
  const interval = value.snapshotIntervalSeconds;
  return {
    version: typeof value.version === "number" ? value.version : DEV_LOG_VERSION,
    runId: value.runId,
    // A log written before the path was stored keeps the name it would have had.
    fileName:
      typeof value.fileName === "string" && value.fileName.length > 0
        ? value.fileName
        : devLogFileName(value.runId, value.startedAtMs),
    startedAtMs: value.startedAtMs,
    snapshotIntervalSeconds:
      typeof interval === "number" && interval > 0
        ? interval
        : DEFAULT_DEV_LOG_SNAPSHOT_SECONDS,
    events: value.events as DevLogEvent[],
    snapshots: value.snapshots as DevLogSnapshot[],
  };
};
