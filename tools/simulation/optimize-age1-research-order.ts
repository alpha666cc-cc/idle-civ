/**
 * Search age-1 research purchase orders for the existing `player` strategy.
 *
 * Candidate research and age-1 prerequisites come from the live research
 * registry. The optimizer changes only the research-order override, leaving the
 * rest of PlayerStrategy's policy unchanged.
 *
 * Usage:
 *   tsx tools/simulation/optimize-age1-research-order.ts [--save=saves/age1-40m.json]
 *     [--budget=200] [--seed=42] [--horizon=18000] [--restarts=4]
 *     [--out=sim-output/age1-research-order.json]
 *     [--checkpoint=sim-output/age1-research-order.checkpoint.json] [--resume]
 *
 * Each candidate resumes the same age-1 save and races to age 2. Search is
 * stochastic best-improvement over valid prerequisite-preserving insertions and
 * swaps; results are best-found, not a proof of a global optimum.
 *
 * A checkpoint is written after every evaluation and on every improvement, so
 * the current best order is always recoverable and a night stop can continue
 * with the same flags plus --resume. Resume requires the same save, horizon,
 * seed, budget and restart count; anything else is rejected loudly.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CivilizationState } from "../../src/game/civilizationState.js";
import { researchDefinitions } from "../../src/game/research.js";
import { loadSaveEntry } from "./saveEntry.js";
import { GameSimulation, type SimulationResult } from "./simulation.js";
import { PlayerStrategy } from "./strategies.js";

const playerOrder = [
  "alphabet",
  "philosophy_fundamentals",
  "shipbuilding_principles",
  "currency",
  "mathematics",
  "code_of_laws",
  "irrigation",
  "horsemanship",
  "trade_routes",
  "ram_hulls",
  "iron_mining",
  "iron_working",
  "howdah_mounting",
  "iron_forging",
  "iron_chariotry",
  "heavy_oar_arrays",
  "iron_shielding",
  "cavalry_formations",
  "masonry",
  "road_networks",
  "metallurgy_prep",
  "engineered_siegecraft",
  "coastal_forts",
  "berserker_warbands",
] as const;

type Order = readonly string[];
type Score = {
  reachedAge2: boolean;
  gameTime: number;
  population: string;
  totalBuildings: number;
  battlesWon: number;
  researchBought: number;
  armyPower: string;
  age: string;
};

const argument = (name: string, fallback: string): string => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const budget = Math.max(1, Math.floor(Number(argument("budget", "200"))));
const horizon = Math.max(1, Math.floor(Number(argument("horizon", "7200"))));
const restarts = Math.max(1, Math.floor(Number(argument("restarts", "4"))));
const seed = Number(argument("seed", "42")) >>> 0;
const savePath = argument("save", "saves/age1-40m.json");
const output = argument("out", "sim-output/age1-research-order.json");
const resume = process.argv.includes("--resume");
const checkpointPath = argument(
  "checkpoint",
  `${output.replace(/\.json$/, "")}.checkpoint.json`,
);

type Checkpoint = {
  version: 1;
  save: string;
  horizon: number;
  seed: number;
  budget: number;
  restarts: number;
  evaluations: number;
  randomState: number;
  baselineOrder: string[];
  baselineScore: Score | null;
  baselineOrderValid: boolean;
  startingOrder: string[];
  bestOrder: string[];
  bestScore: Score | null;
  seeds: string[][];
  restartCursor: number;
  currentOrder: string[] | null;
  currentScore: Score | null;
  cache: Array<[string, Score]>;
};

const readCheckpoint = (): Checkpoint => {
  const raw = readFileSync(checkpointPath, "utf8");
  const parsed = JSON.parse(raw) as Checkpoint;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported checkpoint version in ${checkpointPath}`);
  }
  if (
    parsed.save !== savePath ||
    parsed.horizon !== horizon ||
    parsed.seed !== seed ||
    parsed.budget !== budget ||
    parsed.restarts !== restarts
  ) {
    throw new Error(
      `Checkpoint ${checkpointPath} was written for a different run configuration`,
    );
  }
  return parsed;
};

const writeCheckpoint = (state: Checkpoint): void => {
  mkdirSync(dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, checkpointPath);
};

const age1Research = researchDefinitions.filter(({ age }) => age === 1);
const age1Ids = new Set(age1Research.map(({ key }) => key));
const prerequisites = new Map(
  age1Research.map(({ key, prerequisites: needs }) => [
    key,
    needs.filter((need) => age1Ids.has(need)),
  ]),
);

const isValidOrder = (order: Order): boolean => {
  if (order.length !== age1Ids.size || new Set(order).size !== age1Ids.size) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of order) {
    if (!age1Ids.has(id)) return false;
    if (!(prerequisites.get(id) ?? []).every((need) => seen.has(need))) {
      return false;
    }
    seen.add(id);
  }
  return true;
};

const startingState = loadSaveEntry(savePath).state;
if (startingState.getCurrentAge()?.key !== "age1") {
  throw new Error(
    `Expected an Age 1 save, got ${startingState.getCurrentAge()?.key ?? "no age"}: ${savePath}`,
  );
}
const boughtAge1Research = startingState.boughtResearch.filter((id) =>
  age1Ids.has(id),
);
if (boughtAge1Research.length > 0) {
  throw new Error(
    `Expected an Age 1 start with no Age 1 research already bought; found ${boughtAge1Research.join(", ")}`,
  );
}
const baselineOrder = [...playerOrder];
if (
  baselineOrder.length !== age1Ids.size ||
  new Set(baselineOrder).size !== age1Ids.size ||
  baselineOrder.some((id) => !age1Ids.has(id))
) {
  throw new Error(
    "Copied player baseline does not match live Age 1 research registry",
  );
}
const baselineIndex = new Map<string, number>(
  baselineOrder.map((id, index) => [id, index]),
);
const researchRank = (id: string): number =>
  baselineIndex.get(id) ?? Number.MAX_SAFE_INTEGER;

const topologicalBaseline = (): string[] => {
  const remaining = new Set(age1Research.map(({ key }) => key));
  const result: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) =>
        (prerequisites.get(id) ?? []).every((need) => !remaining.has(need)),
      )
      .sort((left, right) => researchRank(left) - researchRank(right));
    if (ready.length === 0)
      throw new Error("Age-1 prerequisite cycle detected");
    result.push(ready[0]);
    remaining.delete(ready[0]);
  }
  return result;
};
const baselineOrderValid = isValidOrder(baselineOrder);
const startingOrder = baselineOrderValid
  ? baselineOrder
  : topologicalBaseline();

class OrderedPlayer extends PlayerStrategy {
  readonly name: string;
  readonly description: string;
  private readonly order: Order;

  constructor(order: Order) {
    super();
    this.name = "player-age1-order-search";
    this.description = "PlayerStrategy with a searched age-1 research order";
    this.order = order;
  }

  protected getPlayerResearchOrder(state?: CivilizationState): Order {
    return state?.getCurrentAge()?.key === "age1"
      ? this.order
      : super.getPlayerResearchOrder(state);
  }
}

const evaluate = (order: Order): Score => {
  const result: SimulationResult = new GameSimulation(
    startingState,
    new OrderedPlayer(order),
    {
      objective: { type: "ageReach", ageId: "age2" },
      maxGameTime: horizon,
      gatherClicksPerAction: 10,
      actionsPerSecond: 5,
      recordSnapshots: false,
      fromScratch: false,
    },
  ).run();
  const state = result.finalState;
  const population = state.population.toString();
  return {
    reachedAge2: state.getCurrentAge()?.key === "age2",
    gameTime: result.gameTime,
    population,
    totalBuildings: Object.values(state.builtBuildings).reduce(
      (sum, count) => sum + (count ?? 0),
      0,
    ),
    battlesWon: state.defeatedEncounters.length,
    researchBought: state.boughtResearch.length,
    armyPower: state.getArmyPower().toString(),
    age: state.getCurrentAge()?.key ?? "",
  };
};

const isBetter = (candidate: Score, incumbent: Score): boolean => {
  if (candidate.reachedAge2 !== incumbent.reachedAge2) {
    return candidate.reachedAge2;
  }
  if (candidate.reachedAge2) return candidate.gameTime < incumbent.gameTime;
  return Number(candidate.population) > Number(incumbent.population);
};

let randomState = seed;
let evaluations = 0;
const cache = new Map<string, Score>();
let restartCursor = 0;
let currentOrder: string[] | null = null;
let currentScore: Score | null = null;
let resumedFromCheckpoint = false;
const random = (): number => {
  randomState = (randomState + 0x6d2b79f5) >>> 0;
  let value = randomState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const orderKey = (order: Order): string => order.join(",");

const neighbours = (order: Order): string[][] => {
  const found = new Map<string, string[]>();
  for (let from = 0; from < order.length; from += 1) {
    for (let to = 0; to < order.length; to += 1) {
      if (from === to) continue;
      const moved = [...order];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      if (!isValidOrder(moved)) continue;
      found.set(orderKey(moved), moved);
    }
  }
  return [...found.values()];
};

const shuffled = <T>(items: readonly T[]): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};

const sampleIndices = (length: number, maximum: number): number[] => {
  if (length <= maximum) return Array.from({ length }, (_, index) => index);
  const selected = new Set<number>();
  while (selected.size < maximum) {
    selected.add(Math.floor(random() * length));
  }
  return [...selected];
};

const formatScore = (score: Score): string =>
  score.reachedAge2
    ? `reached age2 in ${score.gameTime}s`
    : `did not reach age2 in ${horizon}s (age=${score.age}, population=${score.population})`;

const score = (order: Order): Score => {
  const key = orderKey(order);
  const existing = cache.get(key);
  if (existing) return existing;
  const result = evaluate(order);
  cache.set(key, result);
  evaluations += 1;
  writeCheckpoint(checkpointState());
  return result;
};

const recordImprovement = (order: Order, improved: Score): void => {
  bestOrder = [...order];
  bestScore = improved;
  console.log(`  improve: ${formatScore(improved)}`);
  console.log(`  order: ${[...order].join(" -> ")}`);
  console.log(`  checkpoint: ${checkpointPath}`);
  writeCheckpoint(checkpointState());
};

const loadResumedRun = (): {
  baselineScore: Score | null;
  startingScore: Score;
  bestOrder: string[];
  bestScore: Score;
  seedOrders: Order[];
} => {
  const checkpoint = readCheckpoint();
  if (
    orderKey(checkpoint.baselineOrder) !== orderKey(baselineOrder) ||
    checkpoint.baselineOrderValid !== baselineOrderValid ||
    orderKey(checkpoint.startingOrder) !== orderKey(startingOrder)
  ) {
    throw new Error(
      `Checkpoint ${checkpointPath} does not match the current registry or player order`,
    );
  }
  randomState = checkpoint.randomState;
  evaluations = checkpoint.evaluations;
  restartCursor = checkpoint.restartCursor;
  currentOrder = checkpoint.currentOrder ? [...checkpoint.currentOrder] : null;
  currentScore = checkpoint.currentScore;
  cache.clear();
  for (const [key, value] of checkpoint.cache) cache.set(key, value);
  const seedOrders = checkpoint.seeds.map((order) => [...order]);
  seeds = seedOrders.map((order) => [...order]);
  const restoredBaselineScore = checkpoint.baselineScore;
  const restoredBestScore = checkpoint.bestScore;
  if (!restoredBestScore) {
    throw new Error(`Checkpoint ${checkpointPath} has no best score yet`);
  }
  console.log(
    `resumed from ${checkpointPath}: ${evaluations} evaluations, best ${formatScore(restoredBestScore)}`,
  );
  return {
    baselineScore: restoredBaselineScore,
    startingScore: isValidOrder(checkpoint.startingOrder)
      ? score(checkpoint.startingOrder)
      : restoredBestScore,
    bestOrder: [...checkpoint.bestOrder],
    bestScore: restoredBestScore,
    seedOrders,
  };
};

let baselineScore: Score | null = null;
let startingScore: Score | null = null;
let bestOrder: string[] = [...startingOrder];
let bestScore: Score | null = null;
let seeds: Order[] = [[...startingOrder]];

const checkpointState = (): Checkpoint => ({
  version: 1,
  save: savePath,
  horizon,
  seed,
  budget,
  restarts,
  evaluations,
  randomState,
  baselineOrder: [...baselineOrder],
  baselineScore,
  baselineOrderValid,
  startingOrder: [...startingOrder],
  bestOrder: [...bestOrder],
  bestScore,
  seeds: seeds.map((order) => [...order]),
  restartCursor,
  currentOrder: currentOrder ? [...currentOrder] : null,
  currentScore,
  cache: [...cache.entries()],
});

if (resume) {
  if (!existsSync(checkpointPath)) {
    throw new Error(`No checkpoint to resume at ${checkpointPath}`);
  }
  const restored = loadResumedRun();
  resumedFromCheckpoint = true;
  baselineScore = restored.baselineScore;
  startingScore = restored.startingScore;
  bestOrder = restored.bestOrder;
  if (!restored.bestScore) {
    throw new Error(`Checkpoint ${checkpointPath} has no best score yet`);
  }
  bestScore = restored.bestScore;
  seeds = restored.seedOrders.map((order) => [...order]);
} else {
  seeds = [[...startingOrder]];
  baselineScore = baselineOrderValid ? score(baselineOrder) : null;
  startingScore = baselineOrderValid ? baselineScore! : score(startingOrder);
  bestOrder = [...startingOrder];
  bestScore = startingScore;
  writeCheckpoint(checkpointState());
}

if (!startingScore || !bestScore) {
  throw new Error("Search state was not initialized");
}

console.log(
  `age1 research: ${age1Research.length} technologies; start=${savePath}; objective=reach age2; horizon=${horizon}s; budget=${budget}; restarts=${restarts}; seed=${seed}`,
);
console.log(
  `player order: ${baselineOrderValid ? "valid" : "repaired topologically for evaluation"}`,
);
console.log(
  `baseline: ${baselineScore ? formatScore(baselineScore) : "invalid under current prerequisites"}`,
);
console.log(`search start: ${formatScore(startingScore)}`);
console.log(`checkpoint: ${checkpointPath}${resume ? " (resumed)" : ""}`);

if (!resumedFromCheckpoint) {
  for (let restart = 1; restart < restarts; restart += 1) {
    const completed: string[] = [];
    while (completed.length < age1Ids.size) {
      const ready = shuffled(age1Research.map(({ key }) => key)).filter(
        (id) =>
          !completed.includes(id) &&
          (prerequisites.get(id) ?? []).every((need) =>
            completed.includes(need),
          ),
      );
      if (ready.length === 0) {
        throw new Error("Age-1 prerequisite cycle detected");
      }
      completed.push(ready[0]);
    }
    seeds.push(completed);
  }
  writeCheckpoint(checkpointState());
}

const nonBaselineSeeds = seeds.slice(1).map((order) => ({
  order,
  score: score(order),
}));
nonBaselineSeeds.sort((left, right) =>
  isBetter(left.score, right.score)
    ? -1
    : isBetter(right.score, left.score)
      ? 1
      : 0,
);
const orderedSeeds = [
  { order: startingOrder, score: startingScore },
  ...nonBaselineSeeds,
];

for (
  let restartIndex = restartCursor;
  restartIndex < orderedSeeds.length;
  restartIndex += 1
) {
  restartCursor = restartIndex;
  if (evaluations >= budget) break;
  const seedOrder = orderedSeeds[restartIndex].order;
  if (
    !currentOrder ||
    !currentScore ||
    orderKey(currentOrder) !== orderKey(seedOrder)
  ) {
    currentOrder = [...seedOrder];
    currentScore = orderedSeeds[restartIndex].score;
  }
  const incumbentScore: Score = currentScore;
  let activeOrder: string[] = [...currentOrder];
  let activeScore: Score = incumbentScore;
  if (isBetter(activeScore, bestScore)) {
    recordImprovement(activeOrder, activeScore);
  }
  console.log(`restart ${restartIndex + 1}: ${formatScore(activeScore)}`);
  currentOrder = [...activeOrder];
  currentScore = activeScore;
  writeCheckpoint(checkpointState());

  while (evaluations < budget) {
    const candidateOrders: string[][] = shuffled(neighbours(activeOrder));
    const sampledCandidates: string[][] = sampleIndices(
      candidateOrders.length,
      Math.max(1, Math.min(12, budget - evaluations)),
    ).map((index) => candidateOrders[index]);
    let nextOrder: string[] | null = null;
    let nextScore: Score = activeScore;
    for (const candidate of sampledCandidates) {
      const wasEvaluated = cache.has(orderKey(candidate));
      if (!wasEvaluated && evaluations >= budget) break;
      const candidateScore = score(candidate);
      if (isBetter(candidateScore, nextScore)) {
        nextOrder = candidate;
        nextScore = candidateScore;
      }
    }
    if (!nextOrder || !isBetter(nextScore, activeScore)) break;
    activeOrder = nextOrder;
    activeScore = nextScore;
    currentOrder = [...activeOrder];
    currentScore = activeScore;
    if (isBetter(activeScore, bestScore)) {
      recordImprovement(activeOrder, activeScore);
    } else {
      console.log(`  improve: ${formatScore(activeScore)}`);
      writeCheckpoint(checkpointState());
    }
  }
  restartCursor = restartIndex + 1;
  currentOrder = null;
  currentScore = null;
  writeCheckpoint(checkpointState());
}

const report = {
  generatedAt: new Date().toISOString(),
  horizon,
  requestedBudget: budget,
  uniqueEvaluations: cache.size,
  seed,
  restarts,
  search: "seeded random-restart best-improvement over valid insertions",
  optimality: "best found; local search does not prove a global optimum",
  baseline: baselineScore
    ? { order: baselineOrder, score: baselineScore }
    : { order: baselineOrder, valid: false },
  best: { order: bestOrder, score: bestScore },
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\nbest: ${formatScore(bestScore)}`);
console.log(bestOrder.join(" -> "));
console.log(`evaluations: ${cache.size}; report: ${output}`);
