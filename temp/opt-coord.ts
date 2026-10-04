/**
 * Scratch coordinator: parallel coordinate descent over one strategy's worker
 * ratios, minimising age-1 reach time.
 *
 * Child processes rather than worker_threads: the simulation module graph is
 * large and `tsx`'s loader does not survive being handed to a worker without
 * re-registering. A process per core is less elegant and completely reliable.
 * Each candidate is independent and the simulation is deterministic, so the
 * result does not depend on how the work is split.
 */
import { spawn } from "node:child_process";
import { cpus } from "node:os";

type R = {
  food: number;
  wood: number;
  stone: number;
  gold: number;
  science: number;
};
const WORKER = "temp/opt-worker.ts";

/** Run a batch of candidates across N child processes, resolving times in order. */
const runBatch = (name: string, batch: R[]): Promise<number[]> =>
  new Promise((resolve, reject) => {
    const lanes = Math.max(1, Math.min(cpus().length - 1, 8));
    const chunks = Array.from({ length: lanes }, () => [] as number[]);
    batch.forEach((_, i) => chunks[i % lanes].push(i));
    const times = new Array<number>(batch.length);
    let pending = chunks.filter((c) => c.length).length;
    if (pending === 0) return resolve(times);
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          WORKER,
          name,
          JSON.stringify(chunk.map((i) => batch[i])),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let out = "";
      child.stdout.on("data", (d) => {
        out += String(d);
      });
      child.on("close", () => {
        for (const line of out.split("\n")) {
          const [n, i, t] = line.split("\t");
          if (n !== name) continue;
          times[Number(i)] = Number(t);
        }
        if (--pending === 0) resolve(times);
      });
      child.on("error", reject);
    }
  });

/**
 * `runBatch`, but a candidate whose child process died is retried once on its own.
 *
 * A miss used to be silently dropped: `undefined < x` is false, so a candidate
 * that failed just looked like a bad score and the descent quietly searched an
 * incomplete grid. Under load (8 lanes plus a benchmark on 12 cores) most of a
 * batch was failing, so this surfaced as a plausible-looking RESULT built on
 * missing data. A miss now reports itself instead.
 */
const runBatchChecked = async (name: string, batch: R[]): Promise<number[]> => {
  const times = await runBatch(name, batch);
  // Indexed, NOT `.map()`: `new Array(n)` is sparse and `.map()` skips holes, so
  // the failed candidates — exactly the ones that need looking at — were never
  // visited and the miss count came back zero every single time.
  const missing: number[] = [];
  for (let i = 0; i < batch.length; i += 1) {
    if (!Number.isFinite(times[i])) missing.push(i);
  }
  if (missing.length > 0) {
    console.log(
      `  ${name}: ${missing.length}/${batch.length} candidates failed, retrying serially`,
    );
    for (const i of missing) {
      const solo = await runBatch(name, [batch[i]]);
      times[i] = solo[0];
      if (!Number.isFinite(times[i])) {
        // Surface it rather than letting it masquerade as a slow score.
        console.log(`  ${name}: candidate ${i} FAILED again, discarding`);
        times[i] = 999999;
      }
    }
  }
  return times;
};

const fmt = (r: R): string =>
  `f=${r.food.toFixed(3)} w=${r.wood.toFixed(3)} s=${r.stone.toFixed(3)} ` +
  `g=${r.gold.toFixed(3)} sci=${r.science.toFixed(3)}`;

/** Set one axis and rescale everything else to fill 1, proportionally. */
const setAxis = (base: R, axis: keyof R, value: number): R | null => {
  if (value >= 1) return null;
  const others = (Object.keys(base) as (keyof R)[]).filter((k) => k !== axis);
  const rest = others.reduce((n, k) => n + base[k], 0);
  if (rest <= 0) return null;
  const scale = (1 - value) / rest;
  const out = { ...base, [axis]: value };
  for (const k of others) out[k] = base[k] * scale;
  return out;
};

const GRID: Record<keyof R, number[]> = {
  food: [0.15, 0.2, 0.25, 0.3, 0.35, 0.45],
  wood: [0.1, 0.15, 0.2, 0.25, 0.3, 0.4],
  stone: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3],
  gold: [0.04, 0.07, 0.1, 0.15, 0.2, 0.3],
  science: [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5],
};
const AXES = Object.keys(GRID) as (keyof R)[];

const START: Record<string, R> = {
  cheapest: { food: 0.504, wood: 0.126, stone: 0.27, gold: 0.1, science: 0 },
  trader: { food: 0.225, wood: 0.322, stone: 0.303, gold: 0.15, science: 0 },
  balanced: { food: 0.248, wood: 0.31, stone: 0.162, gold: 0.08, science: 0.2 },
  production: { food: 0.347, wood: 0.223, stone: 0.16, gold: 0.07, science: 0.2 },
  economy: { food: 0.2, wood: 0.276, stone: 0.064, gold: 0.06, science: 0.4 },
  "fast-age": { food: 0.263, wood: 0.198, stone: 0.24, gold: 0.099, science: 0.2 },
  military: { food: 0.35, wood: 0.25, stone: 0.25, gold: 0.15, science: 0 },
};

const name = process.argv[2];
let best: R = { ...START[name] };
let bestTime = (await runBatchChecked(name, [best]))[0];
console.log(`${name} start ${fmt(best)} ${bestTime}`);

for (let pass = 0; pass < 3; pass += 1) {
  for (const axis of AXES) {
    const candidates = GRID[axis]
      .map((v) => setAxis(best, axis, v))
      .filter((c): c is R => c !== null);
    const times = await runBatchChecked(name, candidates);
    let axisBest = bestTime;
    let axisRatios = best;
    candidates.forEach((c, i) => {
      console.log(`  ${name} p${pass} ${axis} ${fmt(c)} ${times[i]}`);
      if (times[i] < axisBest) {
        axisBest = times[i];
        axisRatios = c;
      }
    });
    if (axisBest < bestTime) {
      bestTime = axisBest;
      best = axisRatios;
      console.log(`  ${name} IMPROVED ${axis} -> ${fmt(best)} ${bestTime}`);
    }
  }
}
console.log(`RESULT ${name} ${fmt(best)} ${bestTime}`);
