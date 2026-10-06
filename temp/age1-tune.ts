/**
 * Hill-climb the Age-1 research order for `player`.
 *
 * The order is module-private in `strategies.ts`, so it is swapped in by
 * overriding `getPlayerResearchOrder` on a `PlayerStrategy` subclass — that
 * keeps worker split, opening, building priorities and every other dial
 * untouched, so any score difference is attributable to the order alone.
 *
 * The evaluation mirrors `snapshot-csv.ts` exactly (same horizon, objective,
 * `gatherClicksPerAction`, `fromScratch`, and the same metric expressions) so a
 * score here is comparable with the AGENTS §7.2 sweep rather than a proxy.
 *
 *   tsx temp/age1-tune.ts --eval          one run, metrics for the current order
 *   tsx temp/age1-tune.ts --sweeps=3      adjacent-swap hill climb
 */
import { ageDefinitions } from "../src/game/ages.js";
import type { CivilizationState } from "../src/game/civilizationState.js";
import { researchDefinitions } from "../src/game/research.js";
import { GameSimulation, createInitialState } from "../tools/simulation.js";
import { PlayerStrategy } from "../tools/strategies.js";

const flag = (name: string, fallback: string): string => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const hasFlag = (name: string): boolean =>
  process.argv.some((arg) => arg === `--${name}`);

const HORIZON = Number(flag("horizon", "7200"));

/**
 * The order as it stands in `strategies.ts`. Kept in sync by hand — the harness
 * only ever proposes a replacement, never writes one.
 */
const CURRENT: readonly string[] = [
  "alphabet",
  "philosophy_fundamentals",
  "currency",
  "mathematics",
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
  "code_of_laws",
  "masonry",
  "road_networks",
  "metallurgy_prep",
  "shipbuilding_principles",
  "engineered_siegecraft",
  "coastal_forts",
  "berserker_warbands",
];

const isAge1 = (researchId: string): boolean =>
  researchDefinitions.find(({ key }) => key === researchId)?.age === 1;

/** Prerequisites that are themselves age-1: age-0 ones are bought before entry. */
const prereqs = new Map<string, readonly string[]>(
  researchDefinitions.map((research) => [
    research.key,
    (research.prerequisites ?? []).filter(isAge1),
  ]),
);

/**
 * A legal purchase sequence. Anything else stalls forever: a dependent listed
 * before its prerequisite can never unlock, so `isResearchUnlocked` refuses it
 * and `getResearchAction` waits on a tech that will never become available.
 */
const isValid = (order: readonly string[]): boolean => {
  const seen = new Set<string>();
  for (const key of order) {
    if (!prereqs.get(key)?.every((need) => seen.has(need))) return false;
    seen.add(key);
  }
  return (
    order.length === CURRENT.length &&
    seen.size === CURRENT.length &&
    CURRENT.every((key) => seen.has(key))
  );
};

/** Move one tech earlier or later — the minimal edit that changes timing. */
const neighbours = (order: readonly string[]): readonly string[][] => {
  const out: string[][] = [];
  for (let from = 0; from < order.length; from += 1) {
    for (let to = from + 1; to < order.length; to += 1) {
      const next = [...order];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      if (isValid(next)) out.push(next);
    }
  }
  return out;
};

class Probe extends PlayerStrategy {
  private readonly order: readonly string[];

  constructor(order: readonly string[]) {
    super();
    this.order = order;
  }

  protected getPlayerResearchOrder(
    state?: CivilizationState,
  ): readonly string[] {
    const base = super.getPlayerResearchOrder(state);
    if (!state) return this.order;
    const age = state.getCurrentAge();
    const index = age
      ? ageDefinitions.findIndex(({ key }) => key === age.key)
      : 0;
    return index === 1 ? this.order : base;
  }
}

type Score = {
  pop: number;
  population: string;
  buildings: number;
  battles: number;
  research: number;
  army: string;
  age: string;
};

/** The metrics `compare-bench.ts` reads, taken with `snapshot-csv`'s expressions. */
const evaluate = (order: readonly string[]): Score => {
  const { finalState } = new GameSimulation(
    createInitialState(),
    new Probe(order),
    {
      objective: { type: "timeLimit", seconds: HORIZON },
      gatherClicksPerAction: 10,
      maxGameTime: HORIZON,
      recordSnapshots: false,
      fromScratch: true,
    },
  ).run();
  return {
    pop: finalState.population.toNumber(),
    population: finalState.population.toString(),
    buildings: Object.values(finalState.builtBuildings).reduce(
      (sum, count) => sum + (count ?? 0),
      0,
    ),
    battles: finalState.defeatedEncounters.length,
    research: finalState.boughtResearch.length,
    army: finalState.getArmyPower().toString(),
    age: finalState.getCurrentAge()?.key ?? "",
  };
};

const show = (label: string, order: readonly string[], score: Score): void => {
  console.log(
    `${label.padEnd(20)} pop=${score.population.padEnd(8)} bld=${String(
      score.buildings,
    ).padStart(6)} army=${score.army.padEnd(7)} res=${score.research} ` +
      `battles=${score.battles} age=${score.age}`,
  );
  console.log(`  ${order.join(" ")}`);
};

const main = (): void => {
  if (!isValid(CURRENT)) throw new Error("CURRENT order is not valid");

  const started = Date.now();
  const baseline = evaluate(CURRENT);
  show("baseline", CURRENT, baseline);
  console.log(`  one run took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (hasFlag("eval")) return;

  let best = [...CURRENT];
  let bestScore = baseline;
  const sweeps = Number(flag("sweeps", "3"));

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const candidates = neighbours(best);
    console.log(`\nsweep ${sweep + 1}/${sweeps}: ${candidates.length} neighbours`);
    let improved = false;
    let rank = 0;
    for (const candidate of candidates) {
      rank += 1;
      const score = evaluate(candidate);
      if (score.pop > bestScore.pop) {
        show(`  #${rank} better`, candidate, score);
        best = candidate;
        bestScore = score;
        improved = true;
      }
    }
    console.log(`best after sweep ${sweep + 1}: pop=${bestScore.population}`);
    if (!improved) {
      console.log("no improvement — stopping");
      break;
    }
  }

  console.log("\n=== winner ===");
  show("best", best, bestScore);
  console.log(
    `\nbaseline bld ${baseline.buildings} -> ${bestScore.buildings}; ` +
      `army ${baseline.army} -> ${bestScore.army}; ` +
      `research ${baseline.research} -> ${bestScore.research}`,
  );
  console.log(
    `paste into playerAge1ResearchOrder:\n  ${best
      .map((id) => `"${id}"`)
      .join(",\n  ")}`,
  );
};

main();
