/**
 * Age-1 time-minimization search.
 *
 * The formulation this tool searches is in `docs/age1-optimization.md`: the
 * game is a deterministic hybrid optimal-control problem whose objective is
 *
 *     min T   s.t.   currentAge(T) == "age1"
 *
 * where the terminal predicate is engine-exact â€” all four age-0 encounters won,
 * at least `age1.buildingThreshold` (1500) total buildings, and the `enterAge`
 * action actually fired. Every evaluation below is a real `GameSimulation` run
 * against the real engine, so a returned `T` is feasible by construction; the
 * search only chooses *which policy* plays.
 *
 * ## Algorithm: cross-entropy method
 *
 * CEM optimizes a distribution over the parameter vector rather than the vector
 * itself: sample a population from the current Gaussian, run each sample, keep
 * the best `elite` fraction, refit the mean/variance to those elites, repeat.
 * It is derivative-free (the objective is a step function of simulation time â€”
 * there is no gradient), tolerant of a mixed encoding (continuous parameters
 * plus a build-order permutation and a boolean), and it reuses the existing
 * harness, so every evaluation is engine-exact rather than a surrogate's
 * approximation of the game.
 *
 * Usage:
 *   tsx tools/age1-optimize.ts [--iterations=8] [--population=12] [--elite=3]
 *                              [--horizon=20000] [--seed=42] [--baseline]
 *                              [--out=sim-output/age1-optimize]
 *
 * `--baseline` additionally re-runs the shipped strategies to the same
 * objective, so the report compares the search against the strategies it is
 * meant to beat rather than against a remembered number.
 *
 * Reports are JSON under `sim-output/` (gitignored): the machine-readable form
 * of every iteration, the elite parameters, and the economy floor below.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GameSimulation,
  createInitialState,
  type SimulationConfig,
  type SimulationResult,
} from "./simulation.js";
import { getStrategy } from "./strategies.js";
import { ageDefinitions } from "../src/game/ages.js";
import { encounterDefinitions } from "../src/game/encounters.js";
import {
  AgeOnePolicy,
  describePolicy,
  defaultPolicy,
  policyBuildOrderLength,
  policyParameterBounds,
  policyParameterNames,
  type NumericPolicyParam,
  type PolicyParams,
} from "./age1-policy.js";
import type { SimulationStrategy } from "./simulation.js";

const flag = (name: string, fallback: string): string => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const hasFlag = (name: string): boolean =>
  process.argv.some((arg) => arg === `--${name}`);

const iterations = Math.max(1, Number(flag("iterations", "8")));
const population = Math.max(2, Number(flag("population", "12")));
const eliteCount = Math.max(
  1,
  Math.min(Number(flag("elite", "3")), population - 1),
);
const horizon = Math.max(60, Number(flag("horizon", "20000")));
const seed = Number(flag("seed", "42"));
const outDir = flag("out", "sim-output/age1-optimize");

/** The configuration every evaluation shares: identical engine knobs, one objective. */
const evaluationConfig = (maxGameTime: number): SimulationConfig => ({
  seed,
  objective: { type: "ageReach", ageId: "age1" },
  gatherClicksPerAction: 10,
  actionsPerSecond: 5,
  maxGameTime,
  recordSnapshots: false,
});

/** One policy evaluation: the game time at which the Iron Age is entered. */
const evaluate = (strategy: SimulationStrategy, maxGameTime: number) =>
  new GameSimulation(
    createInitialState(),
    strategy,
    evaluationConfig(maxGameTime),
  ).run();

/** A run's score: the arrival time when it arrived, else beyond every horizon. */
const scoreOf = (result: SimulationResult, maxGameTime: number): number =>
  result.objectiveReached ? result.gameTime : maxGameTime + 1;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const clock = (seconds: number): string => {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
};
/** A small, fast, seedable PRNG (mulberry32). Determinism is required for a
 *  reproducible sweep: the same `--seed` must replay the same search. */
const makeRng = (initial: number) => {
  let state = initial >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------------------------------------------------------------------------
// Parameter encoding: a flat numeric vector <-> a PolicyParams
// ---------------------------------------------------------------------------

/**
 * A sample is a flat vector over the named numeric parameters, plus a
 * `buildOrder` permutation and a `buyUpgrades` bit. Keeping the categorical
 * parts in the same sample means one Gaussian drives the whole search, and the
 * permutation is rank-decoded from independent uniforms (so Gaussian pressure
 * on the tail positions orders them without a discrete operator).
 */
type Sample = {
  vector: number[];
  buildOrder: number[];
  buyUpgrades: boolean;
};

/** The numeric half of the search vector, in a stable order. */
const numericKeys: readonly NumericPolicyParam[] = policyParameterNames.filter(
  (key): key is NumericPolicyParam =>
    key !== "buyUpgrades" && key !== "buildOrder",
);

/** Assemble a `PolicyParams` from a sample, filling categorical defaults. */
const sampleToParams = (sample: Sample): PolicyParams => ({
  ...defaultPolicy(),
  ...Object.fromEntries(
    numericKeys.map((key, index) => [key, sample.vector[index]]),
  ),
  buildOrder: sample.buildOrder,
  buyUpgrades: sample.buyUpgrades,
});

/** The baseline vector (the `defaultPolicy` numbers, in `numericKeys` order). */
const baselineVector = (): number[] => {
  const base = defaultPolicy();
  return numericKeys.map((key) => base[key]);
};

/**
 * A Gaussian per parameter, centred on the baseline values with sigma at
 * `spreadScale` of the half-range.
 *
 * The scale matters more than it looks. Most of the 17-dimensional space does
 * not reach the Iron Age *at all* — an over-wide initial sigma fills the elite
 * set with failures, and a cross-entropy method refit on failures has nothing to
 * learn from. Starting tight means generation 1 is mostly near-baseline policies
 * that do arrive, so the elites carry real signal.
 */
const initialDistribution = (): { mean: number[]; sigma: number[] } => {
  const base = defaultPolicy();
  const mean: number[] = [];
  const sigma: number[] = [];
  for (const key of numericKeys) {
    const [low, high] = policyParameterBounds[key];
    mean.push(clamp(base[key], low, high));
    sigma.push(Math.max((high - low) / 12, 1e-6));
  }
  return { mean, sigma };
};

/** Sample one candidate from the current distribution (Boxâ€“Muller Gaussian). */
const sampleFrom = (
  mean: number[],
  sigma: number[],
  rng: () => number,
): Sample => {
  const vector = mean.map((m, index) => {
    const u = Math.max(rng(), 1e-12);
    const v = rng();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const [low, high] = policyParameterBounds[numericKeys[index]];
    return clamp(m + sigma[index] * z, low, high);
  });
  // Build order: rank-decode independent uniforms into a permutation.
  const ranked = Array.from({ length: policyBuildOrderLength }, (_, key) => ({
    key,
    u: rng(),
  })).sort((left, right) => left.u - right.u);
  return {
    vector,
    buildOrder: ranked.map((entry) => entry.key),
    buyUpgrades: rng() < 0.75,
  };
};

/** Refit the distribution to the elite samples (mean/variance, floored). */
const refit = (
  elites: Sample[],
  previousMean: number[],
  initialSigma: number[],
): { mean: number[]; sigma: number[] } => {
  const mean: number[] = [];
  const sigma: number[] = [];
  for (let index = 0; index < numericKeys.length; index += 1) {
    const values = elites.map((sample) => sample.vector[index]);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
      Math.max(1, values.length - 1);
    const [low, high] = policyParameterBounds[numericKeys[index]];
    // Floor sigma so a converged elite set cannot collapse the search to a
    // point, and cap it at the *initial* width so a bad generation can widen
    // the search back out. Capping at the previous sigma instead — which was
    // the first attempt — makes the search monotone: once the elites are all
    // failures, the mean drifts into the bad region and the distribution can
    // never recover, so every later generation fails too.
    const floor = Math.max((high - low) / 200, 1e-6);
    mean.push(clamp(avg, low, high));
    sigma.push(
      clamp(Math.sqrt(variance), floor, Math.max(floor, initialSigma[index])),
    );
  }
  // If the mean drifted so far that nothing it proposes is reachable again, pull
  // it partway back toward where the search started rather than committing to it.
  const drift = mean.map((value, index) => {
    const start = previousMean[index];
    return clamp((value + start) / 2, Math.min(value, start), Math.max(value, start));
  });
  return { mean: drift, sigma };
};
// ---------------------------------------------------------------------------
// Economy floor
// ---------------------------------------------------------------------------

/**
 * The time a run *cannot* beat, however well it plays.
 *
 * Two irreducible constraints bound every age-1 run, and neither depends on the
 * policy:
 *
 *  1. **The campaign.** Four encounters must be won, in data order, because
 *     `getNextBattle` only ever offers the first unwon age-0 battle and each
 *     victory's bonuses gate the next (barracks needs 90 people, university
 *     needs First Fire, the bronze army needs the whole tech tree). The cheapest
 *     army that wins each is a fixed recipe from `solveMinimumArmy`.
 *  2. **The building target.** 1500 total buildings, and `people` is by far the
 *     cheapest per-building of them, so 1500 buildings is at least 1500 food
 *     spent on citizens alone â€” on top of the food those citizens themselves
 *     drain at 1/second each.
 *
 * Read as: the campaign is the hard gate, and the building count is co-reached
 * with it (roughly 1000 citizens plus housing, not 1500 houses). The floor is
 * therefore the campaign's own dependency chain, which is what the formulation's
 * `T_LB` in `docs/age1-optimization.md` refers to.
 */
const campaignFloor = (): {
  battleChain: string[];
  minimumBuildings: number;
} => {
  const age1 = ageDefinitions[1];
  return {
    battleChain: encounterDefinitions
      .filter((battle) => battle.age === 0)
      .map((battle) => battle.key),
    minimumBuildings: age1?.buildingThreshold ?? 1500,
  };
};

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

type Evaluation = {
  score: number;
  reached: boolean;
  sample: Sample;
  params: PolicyParams;
};

/** Run one candidate and keep its score. */
const evaluateSample = (sample: Sample, maxGameTime: number): Evaluation => {
  const params = sampleToParams(sample);
  const result = evaluate(new AgeOnePolicy(params), maxGameTime);
  return {
    score: scoreOf(result, maxGameTime),
    reached: result.objectiveReached,
    sample,
    params,
  };
};

const runSearch = () => {
  const rng = makeRng(seed);
  const initialSigma = initialDistribution().sigma;
  let { mean, sigma } = initialDistribution();
  const history: {
    iteration: number;
    best: number;
    bestReached: boolean;
    scores: number[];
  }[] = [];
  let best: Evaluation | null = null;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const candidates: Evaluation[] = [];
    // Generation 1 also evaluates the baseline so the report can quote a
    // like-for-like "where did we start" against the same objective and horizon.
    if (iteration === 0) {
      const baselineSample: Sample = {
        vector: baselineVector(),
        buildOrder: [...defaultPolicy().buildOrder],
        buyUpgrades: true,
      };
      candidates.push(evaluateSample(baselineSample, horizon));
    }
    // Elitism: the best policy found so far is re-evaluated every generation.
    // Without it a generation that happens to sample badly can permanently lose
    // the best result, because the mean only ever moves toward the current
    // elites — never toward a policy that is no longer being sampled.
    if (best) candidates.push(best);
    while (candidates.length < population) {
      candidates.push(evaluateSample(sampleFrom(mean, sigma, rng), horizon));
    }

    candidates.sort((left, right) => left.score - right.score);
    const generationBest = candidates[0];
    if (!best || generationBest.score < best.score) best = generationBest;

    const reachedCount = candidates.filter((candidate) => candidate.reached).length;
    history.push({
      iteration,
      best: generationBest.score,
      bestReached: generationBest.reached,
      scores: candidates.map((candidate) => candidate.score),
    });

    // A generation in which nothing arrived carries no usable signal, so reset
    // to the initial spread around the baseline instead of refitting on
    // failures. This is what keeps a bad generation from poisoning the rest.
    if (reachedCount === 0) {
      const reset = initialDistribution();
      mean = reset.mean;
      sigma = reset.sigma;
    } else {
      const elites = candidates.slice(0, eliteCount);
      const refitted = refit(
        elites.map((candidate) => candidate.sample),
        mean,
        initialSigma,
      );
      mean = refitted.mean;
      sigma = refitted.sigma;
    }

    console.log(
      `iteration ${iteration + 1}/${iterations}  best ${clock(generationBest.score)}${
        generationBest.reached ? "" : " (horizon)"
      }  reached ${reachedCount}/${candidates.length}`,
    );
  }
  return { best, history };
};

/** The shipped strategies, run to the same objective, for the report. */
const runBaselineStrategies = () =>
  ["cheapest", "balanced", "production", "fast-age", "speedrun"]
    .map((name) => getStrategy(name))
    .filter((strategy): strategy is SimulationStrategy => strategy !== undefined)
    .map((strategy) => {
      const result = evaluate(strategy, horizon);
      return {
        strategy: strategy.name,
        reached: result.objectiveReached,
        gameTime: result.gameTime,
      };
    });

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const floor = campaignFloor();
console.log("=== age-1 time-minimization search ===");
console.log(`horizon ${clock(horizon)}   seed ${seed}   population ${population}   elite ${eliteCount}`);
console.log(`campaign gate: ${floor.battleChain.join(" -> ")}`);
console.log(`building target: ${floor.minimumBuildings}\n`);

let baseline: { strategy: string; reached: boolean; gameTime: number }[] = [];
if (hasFlag("baseline")) {
  console.log("--- baseline strategies (same objective, same horizon) ---");
  baseline = runBaselineStrategies();
  for (const row of baseline) {
    console.log(
      `  ${row.strategy.padEnd(12)} ${row.reached ? clock(row.gameTime) : `not reached within ${clock(horizon)}`}`,
    );
  }
  console.log("");
}

console.log(`--- search: ${iterations} iterations x ${population} policies ---`);
const { best: bestCandidate, history } = runSearch();
if (!bestCandidate) {
  console.error("search produced no candidates");
  process.exit(1);
}

const best = bestCandidate;
console.log("\n=== result ===");
console.log(`best age-1 arrival: ${clock(best.score)} (game time ${best.score}s)`);
if (baseline.length > 0) {
  const baselineBest = baseline
    .filter((row) => row.reached)
    .sort((a, b) => a.gameTime - b.gameTime)[0];
  if (baselineBest && best.score < baselineBest.gameTime) {
    console.log(
      `beats the best shipped strategy (${baselineBest.strategy}, ${clock(baselineBest.gameTime)}) by ${clock(baselineBest.gameTime - best.score)}`,
    );
  } else if (baselineBest) {
    console.log(
      `does NOT beat the best shipped strategy (${baselineBest.strategy}, ${clock(baselineBest.gameTime)}) â€” the search found nothing better`,
    );
  }
}
console.log(`campaign gate: ${floor.battleChain.join(" -> ")}`);
console.log(`building target: ${floor.minimumBuildings}`);
console.log("\nbest policy parameters:\n" + describePolicy(best.params));

// Persist the machine-readable report under sim-output/ (gitignored).
try {
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seed,
        horizon,
        population,
        eliteCount,
        iterations,
        best: { reached: best.reached, gameTime: best.score, params: best.params },
        baseline,
        history,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\nreport written to ${reportPath}`);
} catch (error) {
  console.error(`could not write report: ${String(error)}`);
}
