/**
 * Research-path search: which topological order of the 23 age-0 techs reaches
 * the Iron Age fastest?
 *
 * ## Why this is a clean problem
 *
 * `getResearchCostForCount` prices the i-th tech of the current age at
 * `base * factor^(sqrt(i) - 1)` — the *ordinal*, not the identity. So any path
 * that buys all 23 techs costs exactly the same 10 131 950 science, and the
 * entire research decision collapses to sequencing. There is no cost/benefit
 * tradeoff to model, which is what makes local search over orders viable when it
 * was hopeless over the ~1.9M prerequisite-closed subsets.
 *
 * The payoff is bigger than a faster age-1 time. `docs/age1-optimization.md`
 * §8.4 shows four of the ten shipped strategies share one hardcoded order, so the
 * AGENTS.md §7.2 benchmark cannot detect a research-ordering regression at all —
 * every balance number is conditioned on one order that is demonstrably ~2x off.
 *
 * Usage:
 *   tsx tools/age1-tech-search.ts --factorial
 *   tsx tools/age1-tech-search.ts --seeds --budget=60 --base=economy
 *
 * `--factorial` runs the 2x2 that attributes a speed difference between two
 * strategies to research order versus worker split, holding one fixed at a time.
 * That separation is the first thing to establish: it says how much of the
 * remaining headroom an order search can even reach.
 */
import { GameSimulation, createInitialState } from "./simulation.js";
import { getStrategy, getStrategyNames } from "./strategies.js";
import type { SimulationAction, SimulationContext, SimulationStrategy } from "./simulation.js";
import type { CivilizationState } from "../src/game/civilizationState.js";
import { researchDefinitions } from "../src/game/research.js";

const flag = (name: string, fallback: string): string => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const hasFlag = (name: string): boolean =>
  process.argv.some((arg) => arg === `--${name}`);

export type TechOrder = readonly string[];

const age0 = researchDefinitions.filter((r) => r.age === 0);
const prereqsOf = new Map<string, string[]>(
  age0.map((r) => [r.key, (r.prerequisites ?? []).filter((p) => age0.some((x) => x.key === p))]),
);

/**
 * A valid order buys every prerequisite strictly before its dependent. Anything
 * else can never be purchased — `isResearchUnlocked` would refuse it forever and
 * the run would silently stall — so every neighbour is checked before it is
 * allowed to compete.
 */
export const isValidOrder = (order: TechOrder): boolean => {
  const seen = new Set<string>();
  for (const key of order) {
    for (const need of prereqsOf.get(key) ?? []) {
      if (!seen.has(need)) return false;
    }
    seen.add(key);
  }
  return order.length === age0.length && seen.size === age0.length;
};

/**
 * Neighbourhood: promote one tech earlier, or demote it later. Both are the
 * minimal edits that change *when* a tech lands without changing the set, which
 * is all that matters given ordinal pricing. Orders that violate a prerequisite
 * are rejected rather than repaired, so every candidate is a legal purchase
 * sequence by construction.
 */
export const neighboursOf = (order: TechOrder): TechOrder[] => {
  const out: TechOrder[] = [];
  for (let from = 0; from < order.length; from += 1) {
    for (let to = 0; to < order.length; to += 1) {
      if (from === to) continue;
      const next = [...order];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      if (isValidOrder(next)) out.push(next);
    }
  }
  return out;
};
/** The order every shipped strategy except `player`/`speedrun` converges on. */
const advisorOrder: TechOrder = [
  "agriculture", "pottery", "writing", "mining", "stone_working",
  "tribal_organization", "sling_throwing", "animal_husbandry", "forestry",
  "weaving", "domestication", "bronze_smelting", "bronze_casting", "calendar",
  "city_planning", "archery_mechanics", "flint_knapping", "trapping",
  "woodcraft_hulls", "wheel_axle", "composite_bowcraft", "galley_design",
  "torsion_physics",
];

/** The hand-authored `player` order, reproduced for the factorial. */
const playerOrder: TechOrder = [
  "agriculture", "pottery", "writing", "sling_throwing", "tribal_organization",
  "woodcraft_hulls", "forestry", "mining", "stone_working", "city_planning",
  "domestication", "trapping", "animal_husbandry", "weaving", "calendar",
  "archery_mechanics", "flint_knapping", "bronze_smelting", "bronze_casting",
  "wheel_axle", "galley_design", "composite_bowcraft", "torsion_physics",
];

for (const [name, order] of [
  ["advisor", advisorOrder],
  ["player", playerOrder],
] as const) {
  if (!isValidOrder(order)) {
    throw new Error(`${name} order is not a valid topological order`);
  }
}

/**
 * A strategy that follows a fixed research order, wrapping a base strategy for
 * everything else (workers, buildings, battles, upgrades).
 *
 * The interception is at `decideAction`, not at `getResearchAction`: the base
 * ladder can also buy tech through the battle simulator's advisor path, so
 * overriding only the research hook leaves a second buyer that ignores the order
 * entirely. Measured: a budget cap installed at `getResearchAction` still ended
 * up buying all 23 techs.
 */
class OrderedResearch implements SimulationStrategy {
  readonly name: string;
  readonly description: string;
  private readonly base: SimulationStrategy;
  private readonly order: TechOrder;

  constructor(base: SimulationStrategy, order: TechOrder) {
    this.base = base;
    this.order = order;
    this.name = `${base.name}+order`;
    this.description = `follows a fixed research order on top of ${base.name}`;
  }

  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    const action = this.base.decideAction(state, context);
    if (action?.type !== "buyResearch") return action;

    const wanted = this.order.find(
      (id) => !state.isResearchBought(id) && state.isResearchUnlocked(id),
    );
    if (!wanted) return null;
    if (wanted === action.researchId) return action;
    // The order's next tech is not what the base wanted. Buy it if affordable,
    // otherwise refuse the purchase and let the ladder do something else — an
    // out-of-order tech would advance the price curve and make every later tech
    // dearer, which is exactly what this search exists to avoid.
    return state.canBuyResearch(wanted)
      ? { type: "buyResearch", researchId: wanted }
      : null;
  }

  onMilestone(
    event: Parameters<NonNullable<SimulationStrategy["onMilestone"]>>[0],
    state: CivilizationState,
  ): void {
    this.base.onMilestone?.(event, state);
  }
}

const evaluate = (strategy: SimulationStrategy, horizon: number) =>
  new GameSimulation(createInitialState(), strategy, {
    objective: { type: "ageReach", ageId: "age1" },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: horizon,
    recordSnapshots: false,
  }).run();

const clock = (seconds: number): string => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
};
// ---------------------------------------------------------------------------
// Mode 1 — the factorial: is the gap research order, or worker split?
// ---------------------------------------------------------------------------

/**
 * `economy` (3371s) and `player` (1963s) differ in two things at once: the
 * research order AND the worker ratios. Running the 2x2 attributes the gap.
 * This is the first thing to establish, because it bounds how much an order
 * search can possibly recover before any of it is run.
 */
const runFactorial = (horizon: number) => {
  const bases = ["economy", "player", "fast-age"];
  const orders: [string, TechOrder][] = [
    ["advisor", advisorOrder],
    ["player", playerOrder],
  ];
  console.log("=== factorial: base strategy x research order ===");
  console.log(`horizon ${horizon}s\n`);
  const results = new Map<string, number>();
  for (const base of bases) {
    for (const [orderName, order] of orders) {
      const strategy = getStrategy(base);
      if (!strategy) continue;
      const wrapped = new OrderedResearch(strategy, order);
      const result = evaluate(wrapped, horizon);
      const time = result.objectiveReached ? result.gameTime : Infinity;
      results.set(`${base}|${orderName}`, time);
      console.log(
        `  ${base.padEnd(10)} + ${orderName.padEnd(8)} ${result.objectiveReached ? `${String(time).padStart(6)}s` : "not reached"}  techs=${result.finalState.boughtResearch.length}`,
      );
    }
  }
  console.log("\n--- attribution (only where both cells are finite) ---");
  for (const base of bases) {
    const a = results.get(`${base}|advisor`);
    const p = results.get(`${base}|player`);
    if (a === undefined || p === undefined || !Number.isFinite(a) || !Number.isFinite(p)) continue;
    const delta = a - p;
    console.log(
      `  ${base.padEnd(10)} order effect: ${delta >= 0 ? "+" : ""}${delta}s (${((delta / a) * 100).toFixed(1)}%)`,
    );
  }
  // Cross-base with the order held fixed: what is the worker-split effect?
  console.log("\n--- worker-split effect, order held fixed ---");
  for (const [orderName] of orders) {
    const cells = bases
      .map((base) => results.get(`${base}|${orderName}`))
      .filter((t): t is number => t !== undefined && Number.isFinite(t));
    if (cells.length < 2) continue;
    const best = Math.min(...cells);
    const worst = Math.max(...cells);
    console.log(
      `  order=${orderName.padEnd(8)} spread ${worst - best}s across bases (${((worst / best - 1) * 100).toFixed(1)}%)`,
    );
  }
};
// ---------------------------------------------------------------------------
// Mode 2 — local search over topological orders
// ---------------------------------------------------------------------------

/**
 * Best-improvement hill climbing with a fixed evaluation budget, restarted from
 * both known orders.
 *
 * Each candidate is one full simulation, so the budget is a wall-clock budget as
 * much as an iteration count. The neighbourhood is ~250 valid moves per order,
 * which is far too many to enumerate at 5s apiece, so each sweep samples a
 * bounded random subset and keeps the best — random-restart best-improvement
 * rather than exhaustive best-improvement, because the sampling is what makes it
 * affordable.
 */
const runSearch = (baseName: string, budget: number, horizon: number) => {
  const base = getStrategy(baseName);
  if (!base) throw new Error(`unknown base strategy: ${baseName}`);

  const seeds: [string, TechOrder][] = [
    ["advisor", advisorOrder],
    ["player", playerOrder],
  ];

  let spent = 0;
  const cache = new Map<string, number>();
  const score = (order: TechOrder): number => {
    const key = order.join(",");
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const result = evaluate(new OrderedResearch(base, order), horizon);
    const time = result.objectiveReached ? result.gameTime : Infinity;
    cache.set(key, time);
    spent += 1;
    return time;
  };

  console.log(`=== order search: base=${baseName}, budget=${budget} evals ===`);
  const overall: { order: TechOrder; time: number; seed: string }[] = [];

  for (const [seedName, seedOrder] of seeds) {
    let current = seedOrder;
    let currentScore = score(current);
    console.log(
      `\nseed "${seedName}": ${Number.isFinite(currentScore) ? `${currentScore}s` : "not reached"}`,
    );
    overall.push({ order: current, time: currentScore, seed: seedName });

    let sweep = 0;
    while (spent < budget) {
      sweep += 1;
      const neighbours = neighboursOf(current);
      if (neighbours.length === 0) break;
      // Deterministic stride-sample so a sweep is reproducible and each sweep
      // explores a different part of the neighbourhood.
      const stride = Math.max(1, Math.floor(neighbours.length / 12));
      const sampled = neighbours.filter((_, i) => i % stride === 0).slice(0, 12);
      let bestNeighbour: TechOrder | null = null;
      let bestScore = currentScore;
      for (const neighbour of sampled) {
        if (spent >= budget) break;
        const value = score(neighbour);
        if (value < bestScore) {
          bestScore = value;
          bestNeighbour = neighbour;
        }
      }
      if (!bestNeighbour) {
        console.log(`  sweep ${sweep}: no improvement in ${sampled.length} sampled moves`);
        break;
      }
      const improved = currentScore - bestScore;
      current = bestNeighbour;
      currentScore = bestScore;
      console.log(`  sweep ${sweep}: ${currentScore}s (-${improved}s)`);
      overall.push({ order: current, time: currentScore, seed: seedName });
    }
  }

  const best = overall.filter((r) => Number.isFinite(r.time)).sort((a, b) => a.time - b.time)[0];
  console.log(`\n--- best order found (${spent} evaluations) ---`);
  if (!best) {
    console.log("no candidate reached the Iron Age");
    return;
  }
  console.log(`seed=${best.seed}  time=${best.time}s  (${clock(best.time)})`);
  console.log(best.order.join(" -> "));
  return best;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const horizon = Math.max(60, Number(flag("horizon", "12000")));
const baseName = flag("base", "economy");
const budget = Math.max(4, Number(flag("budget", "60")));

console.log(`age-0 techs: ${age0.length}   horizon: ${horizon}s   seed: 42`);
console.log(`registered strategies: ${getStrategyNames().join(", ")}\n`);

if (hasFlag("factorial")) {
  runFactorial(horizon);
} else {
  runSearch(baseName, budget, horizon);
}