/**
 * Applies the -0.5 shift to every unit cost factor in `src/game/data/units.json`
 * (5 -> 4.5, 4 -> 3.5, 3 -> 2.5). A targeted textual edit, NOT a re-serialise:
 * AGENTS.md forbids running JSON.stringify over a file with mixed compact and
 * expanded formatting, because it silently rewrites every short form.
 * Writes CRLF back, since the file is CRLF on disk.
 */
import { readFileSync, writeFileSync } from "node:fs";

const UNITS = "src/game/data/units.json";
const DELTA = -0.5;
const raw = readFileSync(UNITS, "utf8");
const crlf = raw.includes("\r\n");
const lf = crlf ? raw.replace(/\r\n/g, "\n") : raw;

const tally = new Map<string, { count: number; next: string }>();
const next = lf.replace(/"factor": ([0-9.]+)/g, (_all, value: string) => {
  const shifted = Math.round((Number(value) + DELTA) * 100) / 100;
  const key = `"factor": ${value}`;
  const seen = tally.get(key) ?? { count: 0, next: String(shifted) };
  seen.count += 1;
  tally.set(key, seen);
  return `"factor": ${shifted}`;
});

if (next === lf) {
  console.log("NO MATCHES - units.json left untouched");
  process.exitCode = 1;
} else {
  writeFileSync(UNITS, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log(`unit cost factors shifted by ${DELTA}:`);
  for (const [from, info] of tally) {
    console.log(`  ${from.padEnd(14)} -> "factor": ${info.next.padEnd(6)} (${info.count} entries)`);
  }
  const total = [...tally.values()].reduce((n, i) => n + i.count, 0);
  console.log(`  ${total} cost entries updated`);
}