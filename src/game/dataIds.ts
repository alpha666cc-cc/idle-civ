import achievementsData from "./data/achievements.json";
import agesData from "./data/ages.json";
import buildingsData from "./data/buildings.json";
import encountersData from "./data/encounters.json";
import statsData from "./data/stats.json";
import unitsData from "./data/units.json";
import upgradesData from "./data/upgrades.json";

/**
 * Static content GUIDs (save system).
 *
 * Every entry of every `src/game/data/*.json` file carries a `guid` written by
 * `tools/gen/guids.mjs`. The GUID is derived from the file name plus the entry's
 * identity, so it is stable for the life of the project and does **not** change
 * when an entry is renamed. Saves store an id-list plus a `referencedGuids`
 * snapshot (id → guid), which is what lets a future migration find the entry a
 * save meant after its id changed: look the old id's guid up here, and the guid
 * points at whatever id carries it now.
 *
 * `entriesMissingGuid` / `duplicateGuids` / `invalidGuids` exist so the save
 * tests can assert the data is intact — an entry without a guid, or two entries
 * sharing one, would silently break migration.
 */

export type DataFileKey =
  | "ages"
  | "buildings"
  | "upgrades"
  | "encounters"
  | "achievements"
  | "units"
  | "stats";

/** The shape the guid registry needs from a data entry. */
export type GuidEntry = {
  readonly guid?: string;
  readonly key?: string;
  readonly id?: string;
};

export const dataFileEntries: Record<DataFileKey, readonly GuidEntry[]> = {
  ages: agesData as unknown as GuidEntry[],
  buildings: buildingsData as unknown as GuidEntry[],
  upgrades: upgradesData as unknown as GuidEntry[],
  encounters: encountersData as unknown as GuidEntry[],
  achievements: achievementsData as unknown as GuidEntry[],
  units: unitsData as unknown as GuidEntry[],
  stats: statsData as unknown as GuidEntry[],
};

export const dataFileKeys: DataFileKey[] = [
  "ages",
  "buildings",
  "upgrades",
  "encounters",
  "achievements",
  "units",
  "stats",
];

/** Entry identity: `key` everywhere except units.json, which uses `id`. */
export const entryIdentity = (entry: GuidEntry): string =>
  entry.key ?? entry.id ?? "";

/** RFC 4122 version-5 GUID, lowercase — what `tools/gen/guids.mjs` writes. */
export const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** id → guid for every entry that has one (ids are globally unique). */
export const entryGuidById: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const file of dataFileKeys) {
    for (const entry of dataFileEntries[file]) {
      const id = entryIdentity(entry);
      if (!id || typeof entry.guid !== "string") continue;
      if (!map.has(id)) map.set(id, entry.guid);
    }
  }
  return map;
})();

/** guid → id, the reverse lookup a save migration reads. */
export const entryIdByGuid: ReadonlyMap<string, string> = new Map(
  [...entryGuidById].map(([id, guid]) => [guid, id]),
);

export type GuidProblem = {
  file: DataFileKey;
  id: string;
  guid: string;
};

/** Entries with no `guid` — the data file was not regenerated. */
export const entriesMissingGuid: GuidProblem[] = (() => {
  const problems: GuidProblem[] = [];
  for (const file of dataFileKeys) {
    for (const entry of dataFileEntries[file]) {
      if (typeof entry.guid === "string" && entry.guid.length > 0) continue;
      problems.push({ file, id: entryIdentity(entry), guid: "" });
    }
  }
  return problems;
})();

/** Entries whose `guid` is not a version-5 GUID. */
export const invalidGuids: GuidProblem[] = (() => {
  const problems: GuidProblem[] = [];
  for (const file of dataFileKeys) {
    for (const entry of dataFileEntries[file]) {
      const guid = entry.guid ?? "";
      if (guid.length === 0) continue;
      if (!guidPattern.test(guid)) {
        problems.push({ file, id: entryIdentity(entry), guid });
      }
    }
  }
  return problems;
})();

/** GUIDs claimed by more than one entry. */
export const duplicateGuids: GuidProblem[] = (() => {
  const firstUse = new Map<string, GuidProblem>();
  const problems: GuidProblem[] = [];
  for (const file of dataFileKeys) {
    for (const entry of dataFileEntries[file]) {
      const guid = entry.guid ?? "";
      if (guid.length === 0) continue;
      const id = entryIdentity(entry);
      const seen = firstUse.get(guid);
      if (seen) {
        problems.push({ file, id, guid });
        continue;
      }
      firstUse.set(guid, { file, id, guid });
    }
  }
  return problems;
})();

/** Total number of data entries the guid registry covers. */
export const dataEntryCount = dataFileKeys.reduce(
  (total, file) => total + dataFileEntries[file].length,
  0,
);

/** The id an entry guid points at today, or `undefined` if it is gone. */
export const resolveEntryId = (guid: string): string | undefined =>
  entryIdByGuid.get(guid);

/** The static guid of an entry id, or `undefined` for unknown content. */
export const findEntryGuid = (id: string): string | undefined =>
  entryGuidById.get(id);

/**
 * id → guid for every id in `ids` that resolves. Saves embed this snapshot so a
 * later rename is still traceable (see the module comment).
 */
export const snapshotGuids = (ids: readonly string[]): Record<string, string> => {
  const snapshot: Record<string, string> = {};
  for (const id of ids) {
    const guid = entryGuidById.get(id);
    if (guid) snapshot[id] = guid;
  }
  return snapshot;
};