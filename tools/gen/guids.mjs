// Static per-entry GUID generator for the definition data files (save system).
//
// Every entry of every `src/game/data/*.json` file gets a `guid` property as its
// first key. GUIDs are UUID v5 values derived deterministically from the file
// name plus the entry's identity (`key`, or `id` for units), so:
//   * running this script twice never changes an existing GUID,
//   * an entry's GUID survives renaming its key — that is the point: a save can
//     still resolve the entry it meant even after the id changed,
//   * a new entry gets a new GUID without touching its neighbours.
//
// The insertion is line-based on purpose: the data files are hand-authored and
// partly compact, so a `JSON.stringify` round-trip would reflow every array.
// This script only ever adds `"guid": "…",` lines.
//
// Run: node tools/gen/guids.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const dataDir = path.join(root, "src", "game", "data");

/** Files that hold one definition per array entry. */
const dataFiles = [
  "ages.json",
  "buildings.json",
  "upgrades.json",
  "encounters.json",
  "achievements.json",
  "units.json",
  "stats.json",
];

/** Fixed namespace so GUIDs are stable across machines and runs. */
const namespace = Buffer.from("9f1c3d5e7a2b4c6d8e0f1a3b5c7d9e2f", "hex");

/** RFC 4122 UUID v5 (SHA-1, name-based) — deterministic and collision-safe. */
const uuidV5 = (name) => {
  const hash = crypto
    .createHash("sha1")
    .update(Buffer.concat([namespace, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

/** A top-level entry opens with a bare "  {" line; nested objects sit deeper. */
const entryOpener = "  {";
const guidLine = (guid) => `    "guid": "${guid}",`;

let added = 0;
let kept = 0;

for (const file of dataFiles) {
  const filePath = path.join(dataDir, file);
  const text = fs.readFileSync(filePath, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const entries = JSON.parse(text);
  if (!Array.isArray(entries)) {
    throw new Error(`${file} does not hold an array of entries`);
  }

  const openers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === entryOpener) openers.push(index);
  }
  if (openers.length !== entries.length) {
    throw new Error(
      `${file}: found ${openers.length} entry openers for ${entries.length} entries`,
    );
  }

  const derived = entries.map((entry) => {
    const identity = entry.key ?? entry.id;
    if (typeof identity !== "string" || identity.length === 0) {
      throw new Error(`${file}: entry without a key/id`);
    }
    return uuidV5(`${file}:${identity}`);
  });

  const seen = new Set(derived);
  if (seen.size !== derived.length) {
    throw new Error(`${file}: duplicate guid derived`);
  }

  const out = [];
  let entryIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    out.push(lines[index]);
    if (lines[index] !== entryOpener) continue;
    entryIndex += 1;
    const guid = entries[entryIndex].guid ?? derived[entryIndex];
    if (typeof entries[entryIndex].guid === "string") {
      kept += 1;
    } else {
      added += 1;
    }
    const already = /^\s*"guid":/.test(lines[index + 1] ?? "");
    if (!already) out.push(guidLine(guid));
  }

  const nextText = out.join(eol);
  const reparsed = JSON.parse(nextText);
  for (let index = 0; index < entries.length; index += 1) {
    const expected = entries[index].guid ?? derived[index];
    if (reparsed[index].guid !== expected) {
      throw new Error(`${file}: guid mismatch at entry ${index}`);
    }
  }

  if (nextText !== text) fs.writeFileSync(filePath, nextText, "utf8");
  console.log(`${file}: ${entries.length} entries`);
}

console.log(`guids added: ${added}, already present: ${kept}`);
