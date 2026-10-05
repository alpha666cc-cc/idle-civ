/**
 * Stage 2: with the winner from stage 1 (economy + player order, 2626s), try to
 * beat it by changing the ORDER itself.
 *
 * Variants are principled rather than random permutations: the age-1 gate is
 * First Fire, Wolf Pack and Troy, so anything that unlocks a bronze unit or
 * feeds the bonuses those fights scale on should surface early, and anything
 * only payable much later should not sit in the ladder blocking a cheaper tech
 * behind it.
 */
import { ExpNumber } from "../src/game/expNumber.js";
import type { CivilizationState } from "../src/game/civilizationState.js";
import {
  GameSimulation,
  createInitialState,
  type SimulationAction,
} from "../tools/simulation.js";
import { EconomyStrategy } from "../tools/strategies.js";

class OrderProbe extends PlayerStrategy {
  expose(): readonly string[] {
    return this.getPlayerResearchOrder();
  }
}
const PLAYER_ORDER = [...new OrderProbe().expose()];

const gateOpen = (state: CivilizationState): boolean => {
  if (!state.defeatedEncounters.includes("age0_1_first_fire")) return false;
  return !(
    state.isResearchBought("pottery") &&
    state.population.lt(ExpNumber.fromNumber(200))
  );
};

/** Move `ids` to the front of `order`, keeping their relative order. */
const front = (order: string[], ids: string[]): string[] => {
  const set = new Set(ids);
  return [...ids.filter((id) => order.includes(id)),
    ...order.filter((id) => !set.has(id))];
};
const without = (order: string[], ids: string[]): string[] => {
  const set = new Set(ids);
  return order.filter((id) => !set.has(id));
};
const prefix = (order: string[], n: number): string[] => order.slice(0, n);

const BRONZE = ["bronze_smelting", "bronze_casting"];
const BOWS = ["composite_bowcraft"];

const VARIANTS: Record<string, readonly string[]> = {
  "player order (baseline)": PLAYER_ORDER,
  "drop naval+wheel tail": without(PLAYER_ORDER, ["galley_design", "torsion_physics"]),
  "drop wheel+galley+torsion": without(PLAYER_ORDER, [
    "wheel_axle",
    "galley_design",
    "torsion_physics",
  ]),
  "bronze first": front(PLAYER_ORDER, BRONZE),
  "bronze+bows first": front(PLAYER_ORDER, [...BRONZE, ...BOWS]),
  "bronze+bows, drop tail": without(
    front(PLAYER_ORDER, [...BRONZE, ...BOWS]),
    ["galley_design", "torsion_physics"],
  ),
  "prefix 8": prefix(PLAYER_ORDER, 8),
  "prefix 12": prefix(PLAYER_ORDER, 12),
  "prefix 16": prefix(PLAYER_ORDER, 16),
  "reversed": [...PLAYER_ORDER].reverse(),
  "writing+sling early": front(PLAYER_ORDER, ["pottery", "writing", "sling_throwing"]),
};

const time = (order: readonly string[]): number => {
  class Tuned extends EconomyStrategy {
    protected getResearchAction(
      state: CivilizationState,
    ): SimulationAction | null {
      if (!gateOpen(state)) return null;
      const next = order.find(
        (id) => state.isResearchUnlocked(id) && !state.isResearchBought(id),
      );
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

const rows: { name: string; t: number }[] = [];
for (const [name, order] of Object.entries(VARIANTS)) {
  const t = time(order);
  rows.push({ name, t });
  console.log(`${name.padEnd(26)} ${String(t).padStart(5)}s  (${order.length} techs)`);
}
rows.sort((a, b) => a.t - b.t);
console.log(`\nBEST ${rows[0].name} ${rows[0].t}s vs baseline ${time(PLAYER_ORDER)}s`);