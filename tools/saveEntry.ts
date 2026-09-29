/**
 * Loading a real save as a simulation entry point.
 *
 * A save is the only faithful way to start a run from a real session: it is the
 * one artefact that carries the whole settlement — resources, workers, every
 * building count, units, bought upgrades, research, achievements, ages and
 * battles already won. Hand-authoring an equivalent `CivilizationState` would
 * drift from the save format the moment either side changes.
 *
 * The loader is deliberately thin. `parseSave` validates the document *and*
 * migrates it in one step (`saveFromJson` calls `migrateSaveData`), so an older
 * save such as `saves/age1.json` (version 4) arrives here already at the current
 * `SAVE_VERSION`. Nothing here re-implements that.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createSaveData,
  detectSaveFormat,
  generateSaveGuid,
  loadSaveData,
  parseSave,
  SaveFormatError,
  serializeSave,
  type SaveFormat,
} from "../src/game/saveSystem.js";
import type { CivilizationState } from "../src/game/civilizationState.js";

export type SaveEntry = {
  /** The path as the caller named it, for echoing back. */
  readonly path: string;
  /** The interchange encoding detected from the file's contents, not its name. */
  readonly format: SaveFormat;
  /** The live state, ready to hand to a `GameSimulation`. */
  readonly state: CivilizationState;
  /** Version the engine loaded, i.e. after migration. */
  readonly version: number;
  /**
   * The save's own identity. A run that resumes a save and then writes one back
   * carries both of these across, so the output is recognisably the same
   * save-file rather than a fresh document that merely looks similar.
   */
  readonly guid: string;
  readonly createdAtMs: number;
  /**
   * Game seconds the save had already played (`statistics.runTimeMs`). The run's
   * own clock still starts at 0, so this is the offset to add when lining the
   * simulation up against the save's `devLog` timeline.
   */
  readonly elapsedSeconds: number;
};

/**
 * Read a save file and turn it into a simulation entry point.
 *
 * Throws `SaveFormatError` with a message meant for the terminal: an unreadable
 * path, an unrecognised encoding, or a document the save system rejects. Every
 * failure is explicit — silently falling back to a fresh civilization would make
 * a typo in a path look like a successful run.
 */
export const loadSaveEntry = (path: string): SaveEntry => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new SaveFormatError(`Could not read the save file: ${path}`);
  }

  // Detection reads the contents, so a `.json` file holding XML (or Base64
  // pasted into a `.txt`) still loads.
  const format = detectSaveFormat(text);
  if (!format) {
    throw new SaveFormatError(
      `Could not tell what format ${path} is in. A save is JSON, XML or Base64.`,
    );
  }

  const data = parseSave(text, format);
  const state = loadSaveData(data);
  return {
    path,
    format,
    state,
    version: data.version,
    guid: data.guid,
    createdAtMs: data.createdAtMs,
    elapsedSeconds: Math.floor(state.statistics.runTimeMs / 1000),
  };
};

/** A save written out by a run, as reported back to the caller. */
export type WrittenSave = {
  readonly path: string;
  readonly format: SaveFormat;
  readonly version: number;
  readonly guid: string;
};

/**
 * The encoding to write, taken from the file's extension. `.xml` and `.json`
 * are the two the game itself produces (`fileExtensionFor` maps Base64 to
 * `.json`); `.b64`/`.txt` are accepted here so a Base64 document can be aimed at
 * a file of its own. Anything else defaults to JSON, and because the loader
 * sniffs content rather than trusting the extension, a mislabelled file still
 * reads back correctly.
 */
const formatForPath = (path: string): SaveFormat => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".b64") || lower.endsWith(".txt")) return "base64";
  return "json";
};

/**
 * Write a run's final state out as a real save, so the simulation's outcome can
 * be opened in the game and picked up again by a later `--save`.
 *
 * Passing `from` carries the source save's `guid` and `createdAtMs`, which is
 * what `createSaveData` documents for an autosave: the same save-file identity
 * with a new `savedAtMs`, rather than an unrelated new document.
 */
export const writeSaveEntry = (
  path: string,
  state: CivilizationState,
  options: { readonly from?: SaveEntry } = {},
): WrittenSave => {
  const format = formatForPath(path);
  const data = createSaveData(
    state,
    options.from?.guid ?? generateSaveGuid(),
    options.from?.createdAtMs ?? Date.now(),
  );
  writeFileSync(path, serializeSave(data, format), "utf8");
  return { path, format, version: data.version, guid: data.guid };
};

/** A short multi-line report of what a save entry starts from, for a CLI header. */
export const describeSaveEntry = (entry: SaveEntry): string => {
  const { state } = entry;
  const hours = Math.floor(entry.elapsedSeconds / 3600);
  const minutes = Math.floor((entry.elapsedSeconds % 3600) / 60);
  const played =
    hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${entry.elapsedSeconds % 60}s`;
  return [
    `Save:            ${entry.path} (${entry.format}, v${entry.version})`,
    `Already played:  ${played} (${entry.elapsedSeconds}s)`,
    `Age:             ${state.getCurrentAge()?.key ?? "unknown"}`,
    `Population:      ${state.population.toString()}`,
    `Battles won:     ${state.defeatedEncounters.length}`,
    `Buildings:       ${Object.values(state.builtBuildings).reduce(
      (sum, count) => sum + (count ?? 0),
      0,
    )}`,
    `Units owned:     ${Object.keys(state.unitCounts).length}`,
    `Upgrades:        ${state.boughtUpgrades.length}`,
    `Research:        ${state.boughtResearch.length}`,
    `Achievements:    ${state.earnedAchievements.length}`,
  ].join("\n");
};
