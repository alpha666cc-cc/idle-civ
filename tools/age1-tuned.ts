/**
 * A parameterized, shippable descendant of the hand-authored `player` strategy.
 *
 * ## Why this exists
 *
 * `docs/age1-optimization.md` §8.4 established that four of the ten shipped
 * strategies share one hardcoded research order, so the AGENTS.md §7.2 benchmark
 * cannot detect a research-ordering regression at all. The factorial in
 * `tools/age1-tech-search.ts` then showed the research *order* is worth only ~5 %
 * (and is actively worse than the shipped advisor order on `fast-age`) while the
 * *base strategy* is worth ~100 %.
 *
 * The base strategy is where the headroom is, and `player` already encodes two
 * ideas the shipped strategies lack:
 *
 *   1. a **science-heavy worker split** applied on every gather
 *      (`focusWorkersForGather` reassigns via `getResearchWorkerRatios` each turn),
 *   2. a **research pause** — hold research until First Fire is won and
 *      population passes 200.
 *
 * Both were written together by hand, so their contributions are confounded.
 * This class exposes them as knobs so the attribution can be measured rather than
 * guessed, and so the winning combination ships as one reusable strategy.
 *
 * Usage:
 *   tsx tools/age1-tuned.ts --grid       # science-share x gate attribution
 *   tsx tools/age1-tuned.ts --sweep=24   # CEM over the knobs, seeded from `player`
 *   tsx tools/age1-tuned.ts --best       # print the best parameter set found
 */
import {
  GameSimulation,
  createInitialState,
  type SimulationResult,
  type SimulationStrategy,
} from "./simulation.js";
import { PlayerStrategy, getSimulatorBattlePlan } from "./strategies.js";
import { ExpNumber } from "../src/game/expNumber.js";
import type { CivilizationState } from "../src/game/civilizationState.js";
import type { SimulationAction } from "./simulation.js";

const flag = (name: string, fallback: string): string => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const hasFlag = (name: string): boolean =>
  process.argv.some((arg) => arg === `--${name}`);

/**
 * When research is allowed to be bought.
 *
 * `always` — no pause; buy the moment it is affordable.
 * `fire`   — hold until First Fire is won (the barracks gate at 90 people).
 * `pop200` — the hand-authored rule: First Fire won *and* pottery bought with
 *            population at 200.
 */
export type ResearchGate = "always" | "fire" | "pop200";

export type TunedParams = {
  /** Share of workers on science while research is incomplete. */
  scienceShare: number;
  /** Share of workers on metalwork once a smithy exists. */
  metalworkShare: number;
  /** Share of workers on food; wood/stone/gold take the remainder. */
  foodShare: number;
  /** Research gate, see {@link ResearchGate}. */
  gate: ResearchGate;
  /** Population threshold for the `pop200` gate. */
  gatePop: number;
};

/** The hand-authored `player` parameters. */
export const playerParams = (): TunedParams => ({
  scienceShare: 0.5,
  metalworkShare: 0.174,
  foodShare: 0.15,
  gate: "pop200",
  gatePop: 200,
});
/**
 * `PlayerStrategy` with its two innovations exposed as numbers.
 *
 * `getResearchWorkerRatios` and `getPlayerResearchOrder` are protected, so both
 * can be re-derived without editing `strategies.ts` — which matters, because that
 * file is the live balance baseline and §7.2 treats every edit to it as a balance
 * change. The private `isResearchPaused` cannot be overridden, so the gate is
 * reimplemented over the three protected hooks it feeds.
 */
export class TunedPlayer extends PlayerStrategy {
  readonly name: string;
  readonly description: string;
  private readonly params: TunedParams;

  constructor(params: TunedParams) {
    super();
    this.params = params;
    this.name = "tuned";
    this.description = `player with science=${params.scienceShare} gate=${params.gate}`;
  }

  getParams(): TunedParams {
    return this.params;
  }

  /** Whether research is currently allowed to be bought. */
  private gateOpen(state: CivilizationState): boolean {
    if (this.params.gate === "always") return true;
    if (!state.defeatedEncounters.includes("age0_1_first_fire")) return false;
    if (this.params.gate === "fire") return true;
    return !(
      state.isResearchBought("pottery") &&
      state.population.lt(ExpNumber.fromNumber(this.params.gatePop))
    );
  }

  protected getResearchAction(
    state: CivilizationState,
  ): SimulationAction | null {
    if (!this.gateOpen(state)) return null;
    const next = this.getPlayerResearchOrder().find(
      (id) => !state.isResearchBought(id),
    );
    if (!next || !state.canBuyResearch(next)) return null;
    return { type: "buyResearch", researchId: next };
  }

  /**
   * While the gate is shut the battle simulator must still be allowed to buy
   * *units*, or the settlement stops preparing for the very battle the gate is
   * waiting on. The hand-authored strategy keeps unit purchases and drops only
   * the research ones, which is what this reproduces.
   */
  protected getSimulatorActions(state: CivilizationState): SimulationAction[] {
    if (this.gateOpen(state)) return super.getSimulatorActions(state);
    const plan = getSimulatorBattlePlan(state);
    if (!plan) return [];
    const actions: SimulationAction[] = [];
    for (const [unitId, count] of plan.composition) {
      if (count <= 0 || !state.isUnitAvailable(unitId)) continue;
      const affordable = Math.min(count, state.getMaxAffordableUnits(unitId));
      if (affordable > 0) {
        actions.push({ type: "buyUnit", unitId, count: affordable });
      }
    }
    return actions;
  }

  protected getSimulatorGather(
    state: CivilizationState,
  ): SimulationAction | null {
    return this.gateOpen(state) ? super.getSimulatorGather(state) : null;
  }

  protected getResearchWorkerRatios(state: CivilizationState) {
    const hasSmithy = state.isBuildingAvailable("smithy");
    const researchComplete = this.getPlayerResearchOrder().every((id) =>
      state.isResearchBought(id),
    );
    const science = researchComplete ? 0 : this.params.scienceShare;
    const metalwork = hasSmithy ? this.params.metalworkShare : 0;
    // Wood/stone/gold share whatever is left, in the hand-authored proportion
    // (14 : 10.5 : 2.5). `military` is part of the fixed budget and must be
    // subtracted too — leaving it out made the shares sum to 1.025, which
    // `assignWorkersByRatio` then silently renormalised and shifted every
    // resource by ~2 % (1998s against the 1963s the hand-authored run achieves).
    const military = 0.025;
    const rest = Math.max(
      0.0001,
      1 - science - metalwork - this.params.foodShare - military,
    );
    const tail = 0.14 + 0.105 + 0.025;
    return {
      food: this.params.foodShare,
      wood: (rest * 0.14) / tail,
      stone: (rest * 0.105) / tail,
      gold: (rest * 0.025) / tail,
      military,
      science,
      metalwork,
      trade: 0,
    };
  }
}

const evaluate = (
  strategy: SimulationStrategy,
  horizon: number,
): SimulationResult =>
  new GameSimulation(createInitialState(), strategy, {
    objective: { type: "ageReach", ageId: "age1" },
    gatherClicksPerAction: 10,
    actionsPerSecond: 5,
    maxGameTime: horizon,
    recordSnapshots: false,
  }).run();

const clock = (seconds: number): string => {
  const t = Math.round(seconds);
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m${String(t % 60).padStart(2, "0")}s`;
};

/** Arrival time for a parameter set, or null if it never arrives. */
const timeOf = (params: TunedParams, horizon: number): number | null => {
  const result = evaluate(new TunedPlayer(params), horizon);
  return result.objectiveReached ? result.gameTime : null;
};
// ---------------------------------------------------------------------------
// Mode: --grid  the science-share x research-gate attribution
// ---------------------------------------------------------------------------

/**
 * `player` writes a science-heavy worker split and a research pause together, so
 * the two cannot be told apart from the hand-authored run alone. Crossing them
 * independently attributes the 1963s.
 *
 * The `science=0` row is the control: it is the shipped ladder with no science
 * workers at all, which is what every other shipped strategy does.
 */
const runGrid = (horizon: number) => {
  const base = playerParams();
  const scienceValues = flag("science", "0,0.25,0.5,0.7")
    .split(",")
    .map(Number);
  const foodValues = flag("food", "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  const metalValues = flag("metal", "")
    .split(",")
    .filter(Boolean)
    .map(Number);
  const foods = foodValues.length > 0 ? foodValues : [base.foodShare];
  const metals = metalValues.length > 0 ? metalValues : [base.metalworkShare];
  const gates = flag("gate", "always,fire,pop200")
    .split(",")
    .filter(Boolean) as ResearchGate[];

  console.log("=== grid: science share x research gate ===");
  console.log(`horizon ${horizon}s   food=${foods.join("/")}  metal=${metals.join("/")}\n`);

  const table = new Map<string, number | null>();
  for (const food of foods) {
    for (const metal of metals) {
      for (const science of scienceValues) {
        const cells: string[] = [];
        for (const gate of gates) {
          const params: TunedParams = {
            ...base,
            foodShare: food,
            metalworkShare: metal,
            scienceShare: science,
            gate,
          };
          const time = timeOf(params, horizon);
          table.set(`${food}|${metal}|${science}|${gate}`, time);
          cells.push((time === null ? "not reached" : `${time}s`).padEnd(12));
        }
        console.log(
          `food=${food} metal=${metal} science=${String(science).padEnd(5)} ${cells.join("")}`,
        );
      }
    }
  }

  console.log("\n--- best cells ---");
  const ranked = [...table.entries()]
    .filter(([, t]) => t !== null && t !== undefined)
    .sort((a, b) => (a[1] as number) - (b[1] as number))
    .slice(0, 5);
  for (const [key, time] of ranked) {
    const [food, metal, science, gate] = key.split("|");
    console.log(
      `  food=${food} metal=${metal} science=${science} gate=${gate}  ${time}s (${clock(time as number)})`,
    );
  }
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const horizon = Math.max(60, Number(flag("horizon", "12000")));

if (hasFlag("grid")) {
  runGrid(horizon);
} else if (hasFlag("best")) {
  console.log(JSON.stringify(playerParams(), null, 2));
  const time = timeOf(playerParams(), horizon);
  console.log(`\nhand-authored parameters: ${time === null ? "not reached" : `${time}s (${clock(time)})`}`);
} else {
  console.log("usage:");
  console.log("  tsx tools/age1-tuned.ts --grid");
  console.log("  tsx tools/age1-tuned.ts --best");
  console.log(`horizon default ${horizon}s`);
}