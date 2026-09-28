/**
 * Headline comparison between two `snapshot-csv.ts` output directories.
 *
 * §7.2 of AGENTS.md requires a simulation change to be benchmarked before and
 * after, and the before/after numbers to be reported. This reads two runs that
 * were produced with identical `--horizon`, `--interval` and `--seed`, and prints
 * the columns that matter for pacing, one row per strategy per run, plus the
 * first time each strategy reached `age-1`.
 *
 * Usage:
 *   tsx tools/compare-bench.ts <beforeDir> <afterDir> [--age=age-1]
 *
 * Both directories must contain the same `sim-*.csv` files. A strategy present
 * in only one run is reported as `missing` rather than silently dropped, so a
 * run that crashed halfway cannot read as "no change".
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";

const flag = (name: string, fallback: string): string => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const [beforeDir, afterDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!beforeDir || !afterDir) {
  console.error("usage: tsx tools/compare-bench.ts <beforeDir> <afterDir> [--age=age-1]");
  process.exit(1);
}
const targetAge = flag("age", "age-1");

/** Minimal CSV reader: handles the quoted cells the snapshot writer emits. */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

type Summary = {
  readonly name: string;
  readonly rows: number;
  readonly firstAgeSeconds: number | null;
  final: Record<string, string>;
};

const HEADLINE = [
  "age",
  "population",
  "total_buildings",
  "battles_won",
  "research_bought",
  "army_power_total",
] as const;

const readRun = (dir: string): Map<string, Summary> => {
  const out = new Map<string, Summary>();
  if (!existsSync(dir)) {
    console.error(`missing run directory: ${dir}`);
    return out;
  }
  for (const file of readdirSync(dir).sort()) {
    if (!file.startsWith("sim-") || !file.endsWith(".csv")) continue;
    const name = file.slice(4, -4);
    const [header, ...rows] = parseCsv(readFileSync(`${dir}/${file}`, "utf8"));
    if (!header) continue;
    const index = new Map(header.map((column, i) => [column, i]));
    const at = (row: string[], column: string): string =>
      index.has(column) ? (row[index.get(column) as number] ?? "") : "";

    let firstAgeSeconds: number | null = null;
    for (const row of rows) {
      if (at(row, "age") === targetAge) {
        firstAgeSeconds = Number(at(row, "sim_seconds"));
        break;
      }
    }
    const final = rows[rows.length - 1] ?? [];
    out.set(name, {
      name,
      rows: rows.length,
      firstAgeSeconds,
      final: Object.fromEntries(HEADLINE.map((column) => [column, at(final, column)])),
    });
  }
  return out;
};

const before = readRun(beforeDir);
const after = readRun(afterDir);
const names = [...new Set([...before.keys(), ...after.keys()])].sort();

if (names.length === 0) {
  console.error(`no sim-*.csv files in either run`);
  process.exit(1);
}

/** `1.2e+30` -> `1.2e30`, so wide values stay one cell wide. */
const tidy = (value: string): string => value.replace("e+", "e");

const arrow = (left: string, right: string): string => {
  if (left === right) return "=";
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return left === right ? "=" : "?";
  if (b > a) return "+";
  if (b < a) return "-";
  return "=";
};

console.log(`before: ${beforeDir}`);
console.log(`after:  ${afterDir}`);
console.log(`first reach of ${targetAge}: "-" = never reached\n`);

for (const name of names) {
  const b = before.get(name);
  const a = after.get(name);
  console.log(`== ${name} ==`);
  if (!b || !a) {
    console.log(`  ${!b ? "before" : "after"}: MISSING (${!b ? beforeDir : afterDir})`);
    continue;
  }
  const time = (s: Summary) =>
    s.firstAgeSeconds === null ? "never" : `${Math.round(s.firstAgeSeconds / 60)}m`;
  console.log(
    `  ${targetAge.padEnd(9)} ${time(b).padStart(6)} -> ${time(a).padStart(6)}  ${arrow(
      String(b.firstAgeSeconds ?? Infinity),
      String(a.firstAgeSeconds ?? Infinity),
    ) === "-" ? "SLOWER" : arrow(String(b.firstAgeSeconds ?? Infinity), String(a.firstAgeSeconds ?? Infinity))}`,
  );
  for (const column of HEADLINE) {
    const left = tidy(b.final[column] ?? "");
    const right = tidy(a.final[column] ?? "");
    const mark = arrow(left, right);
    console.log(
      `  ${column.padEnd(18)} ${left.padStart(12)} -> ${right.padStart(12)}  ${mark}`,
    );
  }
  console.log("");
}
