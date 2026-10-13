/**
 * Experiment: give every strategy `player`'s hardcoded research ORDER while
 * leaving everything else — worker ratios, buying logic, opening — untouched.
 *
 * This isolates the order from the worker split on purpose. `player` bundles the
 * two (a science-heavy split *and* the `pottery`/pop-200 pause *and* the fixed
 * order), so copying `player` wholesale cannot say which one earns its 37m.
 *
 * `playerResearchOrder` is module-private, so the list is read back off a real
 * `PlayerStrategy` rather than copied — a copy would silently drift the moment
 * the list is edited.
 */
import { ExpNumber } from "../src/game/expNumber.js";
import type { CivilizationState } from "../src/game/civilizationState.js";
import {
  GameSimulation,
  createInitialState,
  type SimulationAction,
} from "../tools/simulation/simulation.js";
import { PlayerStrategy, getStrategy } from "../tools/simulation/strategies.js";

class OrderProbe extends PlayerStrategy {
  expose(): readonly string[] {
    return this.getPlayerResearchOrder();
  }
}
const PLAYER_ORDER = new OrderProbe().expose();

/** `PlayerStrategy`'s research pause, reproduced from its private helper. */
const gateOpen = (state: CivilizationState): boolean => {
  if (!state.defeatedEncounters.includes("age0_1_first_fire")) return false;
  return !(
    state.isResearchBought("pottery") &&
    state.population.lt(ExpNumber.fromNumber(200))
  );
};

type Base = {
  getResearchAction(state: CivilizationState): SimulationAction | null;
};
type Ctor = new () => Base;

const swapped = (name: string) => {
  const Parent = getStrategy(name)!.constructor as unknown as Ctor;
  return class extends Parent {
    protected getResearchAction(
      state: CivilizationState,
    ): SimulationAction | null {
      if (!gateOpen(state)) return null;
      const next = PLAYER_ORDER.find(
        (id) => state.isResearchUnlocked(id) && !state.isResearchBought(id),
      );
      if (!next || !state.canBuyResearch(next)) return null;
      return { type: "buyResearch", researchId: next };
    }
  };
};

const time = (strategy: unknown): number => {
  const res = new GameSimulation(
    createInitialState(),
    strategy as never,
    {
      objective: { type: "ageReach", ageId: "age1" },
      gatherClicksPerAction: 10,
      actionsPerSecond: 5,
      maxGameTime: 20000,
      recordSnapshots: false,
    },
  ).run();
  return res.objectiveReached ? res.gameTime : 999999;
};

// Age-1 benchmark times, from the validated wb-before/wb-after2 pair.
const BASELINE: Record<string, number> = {
  cheapest: 3120,
  trader: 4080,
  balanced: 3600,
  production: 3480,
  economy: 3180,
  "fast-age": 3660,
  military: 4080,
  research: 3240,
  player: 2220,
  speedrun: 4920,
};

for (const name of Object.keys(BASELINE)) {
  if (name === "player") continue;
  const base = time(getStrategy(name));
  const swappedTime = time(new (swapped(name))());
  const delta = ((swappedTime - base) / base) * 100;
  console.log(
    `${name.padEnd(11)} base ${String(base).padStart(5)}s  ` +
      `playerOrder ${String(swappedTime).padStart(5)}s  ` +
      `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`,
  );
}