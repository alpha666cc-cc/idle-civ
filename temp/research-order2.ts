/**
 * Stage 3: with `economy` on the trimmed ladder at a benchmarked 42m, look for a
 * better one. Four families, all derived from the data rather than guessed:
 *
 *  - trim depth: how much of the expensive tail to shed
 *  - skip policy: buy the first *affordable* unlocked tech instead of stalling
 *  - cost-ascending: cheapest tech first, prerequisites respected
 *  - bonus-descending: biggest production multiplier first, prerequisites respected
 */
import { ExpNumber } from "../src/game/expNumber.js";
import type { CivilizationState } from "../src/game/civilizationState.js";
import {
  GameSimulation,
  createInitialState,
  type SimulationAction,
} from "../tools/simulation/simulation.js";
import { EconomyStrategy } from "../tools/simulation/strategies.js";

const LADDER = [
  "agriculture",
  "pottery",
  "writing",
  "sling_throwing",
  "tribal_organization",
  "woodcraft_hulls",
  "forestry",
  "mining",
  "stone_working",
  "city_planning",
  "domestication",
  "trapping",
  "animal_husbandry",
  "weaving",
  "calendar",
  "archery_mechanics",
  "flint_knapping",
  "bronze_smelting",
  "bronze_casting",
  "composite_bowcraft",
];

const gateOpen = (state: CivilizationState): boolean => {
  if (!state.defeatedEncounters.includes("age0_1_first_fire")) return false;
  return !(
    state.isResearchBought("pottery") &&
    state.population.lt(ExpNumber.fromNumber(200))
  );
};

/** Topologically sort `ids` so prerequisites come first, then apply `rank`. */
const prereqSort = (ids: string[], rank: (id: string) => number): string[] => {
  const set = new Set(ids);
  const done = new Set<string>();
  const out: string[] = [];
  const pool = [...ids];
  while (pool.length) {
    // Lowest rank among those whose prerequisites are already placed.
    let bestAt = -1;
    let bestRank = Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const id = pool[i];
      const ok = PRE[id].every((p) => done.has(p) || !set.has(p));
      if (!ok) continue;
      const r = rank(id);
      if (r < bestRank) {
        bestRank = r;
        bestAt = i;
      }
    }
    if (bestAt < 0) {
      out.push(...pool); // dependency cycle: keep the rest in order
      break;
    }
    out.push(pool[bestAt]);
    done.add(pool[bestAt]);
    pool.splice(bestAt, 1);
  }
  return out;
};

const PRE: Record<string, string[]> = {};
const COST = new Map<string, number>();
const BONUS = new Map<string, number>();
{
  const defs = (await import("../src/game/research.js")).researchDefinitions;
  const probe = createInitialState();
  for (const id of LADDER) {
    const def = defs.find((d: { key: string }) => d.key === id);
    PRE[id] = def?.prerequisites ?? [];
    COST.set(id, probe.getResearchCost(id, 0).toNumber());
    BONUS.set(
      id,
      def?.bonuses.reduce(
        (n: number, b: { value: string }) => n + Math.log2(Number(b.value) + 1),
        0,
      ) ?? 0,
    );
  }
}

const run = (order: string[], skipUnaffordable: boolean): number => {
  class Tuned extends EconomyStrategy {
    protected getResearchAction(
      state: CivilizationState,
    ): SimulationAction | null {
      if (!gateOpen(state)) return null;
      const candidates = order.filter(
        (id) => state.isResearchUnlocked(id) && !state.isResearchBought(id),
      );
      if (skipUnaffordable) {
        const affordable = candidates.find((id) => state.canBuyResearch(id));
        if (!affordable) return null;
        return { type: "buyResearch", researchId: affordable };
      }
      const next = candidates[0];
      if (!next || !state.canBuyResearch(next)) return null;
      return { type: "buyResearch", researchId: next };
    }
  }
  const res = new GameSimulation(createInitialState(), new Tuned(), {
    objective: { type: "ageReach", ageId: "age1" },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: 20000,
    recordSnapshots: false,
  }).run();
  return res.objectiveReached ? res.gameTime : 999999;
};

const VARIANTS: { name: string; order: string[]; skip: boolean }[] = [
  { name: "ladder20 (current, 42m)", order: LADDER, skip: false },
  { name: "ladder20 + skip", order: LADDER, skip: true },
  { name: "trim to 16", order: LADDER.slice(0, 16), skip: false },
  { name: "trim to 16 + skip", order: LADDER.slice(0, 16), skip: true },
  { name: "trim to 13", order: LADDER.slice(0, 13), skip: false },
  { name: "trim to 13 + skip", order: LADDER.slice(0, 13), skip: true },
  { name: "trim to 10", order: LADDER.slice(0, 10), skip: false },
  { name: "trim to 10 + skip", order: LADDER.slice(0, 10), skip: true },
  {
    name: "cost ascending",
    order: prereqSort(LADDER, (id) => COST.get(id)!),
    skip: false,
  },
  {
    name: "cost ascending + skip",
    order: prereqSort(LADDER, (id) => COST.get(id)!),
    skip: true,
  },
  {
    name: "bonus descending",
    order: prereqSort(LADDER, (id) => -BONUS.get(id)!),
    skip: false,
  },
  {
    name: "bonus descending + skip",
    order: prereqSort(LADDER, (id) => -BONUS.get(id)!),
    skip: true,
  },
];

const rows: { name: string; t: number; order: string[]; skip: boolean }[] = [];
for (const v of VARIANTS) {
  const t = run(v.order, v.skip);
  rows.push({ ...v, t });
  console.log(`${v.name.padEnd(26)} ${String(t).padStart(5)}s`);
}
rows.sort((a, b) => a.t - b.t);
const best = rows[0];
console.log(`\nBEST ${best.name} ${best.t}s`);
console.log(JSON.stringify(best.order));
