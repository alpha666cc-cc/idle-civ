/**
 * Guards against a strategy or balance edit silently producing a *wrong number*
 * rather than a wrong-looking one.
 *
 * Every test here exists because that exact mistake got made and shipped
 * unchallenged. The recurring shape is the same each time: a plausible value was
 * read off the wrong field, or recomputed by hand, and nothing failed. So these
 * assert against the engine's own output and against each other, not against
 * prose.
 */
import { describe, expect, it } from "vitest";
import { GameSimulation, createInitialState } from "../simulation";
import { getStrategy, getStrategyNames } from "../strategies";
import { researchDefinitions } from "../../../src/game/research";
import { ExpNumber } from "../../../src/game/expNumber";

const RUN = {
  objective: { type: "timeLimit", seconds: 2000 },
  gatherClicksPerAction: 10,
  actionsPerSecond: 5,
  maxGameTime: 2000,
  recordSnapshots: false,
};

type RunConfig = typeof RUN & { maxGameTime: number; objective: object };

const run = (name: string, config: RunConfig = RUN as RunConfig) =>
  new GameSimulation(
    createInitialState(),
    getStrategy(name)!,
    config as never,
  ).run();

const fingerprint = (result: ReturnType<typeof run>) => {
  const state = result.finalState;
  return JSON.stringify({
    time: result.gameTime,
    resources: Object.fromEntries(
      Object.entries(state.resources).map(([k, v]) => [k, v.toString()]),
    ),
    workers: Object.fromEntries(
      Object.entries(state.workers).map(([k, v]) => [k, v.toString()]),
    ),
    buildings: state.builtBuildings,
    research: state.boughtResearch,
    battles: state.defeatedEncounters,
  });
};

// Each test below runs one or more real simulations, which take 5–60 s. Vitest's
// default 5 s timeout fails them all as "timed out" â€” an infrastructure failure
// that reads exactly like a correctness failure, so the timeouts are explicit.
const SLOW = 60_000;
const VERY_SLOW = 180_000;

describe("strategy runs are deterministic", () => {
  // A strategy change that makes a run order-dependent would otherwise show up
  // only as noise between two benchmark runs.
  it("replays identically", () => {
    expect(fingerprint(run("balanced"))).toBe(fingerprint(run("balanced")));
  }, SLOW);

  it("produces finite numbers for every resource rate", () => {
    const state = run("balanced").finalState;
    for (const key of ["food", "wood", "stone", "gold"] as const) {
      const rate = state.computeResourceRate(key);
      expect(Number.isNaN(rate.toNumber())).toBe(false);
      expect(rate.toNumber()).toBeGreaterThanOrEqual(0);
    }
  }, SLOW);
});

describe("every registered strategy runs", () => {
  // `getStrategyNames()` rather than a hand-written list: a hardcoded list
  // silently omitted `economy` and `player` once already, which let two reports
  // name the wrong strategy as the thing to beat.
  for (const name of getStrategyNames()) {
    it(`${name} completes a 2000 s run`, () => {
      const result = run(name);
      // The loop breaks *after* the tick that reaches the horizon, so the final
      // game time is the limit or one past it â€” not exactly the limit.
      expect(result.gameTime).toBeGreaterThanOrEqual(2000);
      expect(result.finalState.population.gte(ExpNumber.ZERO)).toBe(true);
      for (const bought of result.finalState.boughtResearch) {
        expect(typeof bought).toBe("string");
      }
    }, SLOW);
  }
});

describe("research is bought in purchase order", () => {
  /**
   * `boughtResearch` is appended as purchases happen, so it is the ONLY field
   * that records purchase sequence. Re-filtering `researchDefinitions` yields the
   * *data file* order instead, which put `writing` 9th for every strategy and
   * was mistaken for the dynamic order burying it.
   *
   * `writing` is the Age-0 keystone â€” science x10 and -50% on every building â€”
   * so "bought third" is a real balance property, not an incidental detail.
   */
  const age0 = new Set(
    researchDefinitions.filter((r) => r.age === 0).map((r) => r.key),
  );

  for (const name of ["balanced", "research", "player"]) {
    it(`${name} buys writing third`, () => {
      // 4000 s, not 2000: `research` and `player` have bought fewer than three
      // techs by 2000 s, so the shorter horizon tested a horizon, not the order.
      const bought = run(name, {
        ...RUN,
        objective: { type: "timeLimit", seconds: 4000 },
        maxGameTime: 4000,
      })
        .finalState.boughtResearch.filter((k) => age0.has(k));
      expect(bought.slice(0, 3)).toEqual([
        "agriculture",
        "pottery",
        "writing",
      ]);
    }, SLOW);
  }

  it("has agriculture and pottery as writing's prerequisites", () => {
    const writing = researchDefinitions.find((r) => r.key === "writing");
    expect(writing?.prerequisites).toEqual(["pottery"]);
    expect(
      researchDefinitions.find((r) => r.key === "pottery")?.prerequisites,
    ).toEqual(["agriculture"]);
  });
});

describe("building multipliers are exponent-scaled", () => {
  /**
   * `additiveMultiplier` is `(perBuilding x count) ^ buildingPower`, NOT
   * `perBuilding x count`. Reading it linearly put a farm's contribution out by a
   * factor of ~1760 in a real Age-1 state.
   */
  it("raises the per-building bonus to the building's power", () => {
    const result = new GameSimulation(
      createInitialState(),
      getStrategy("balanced")!,
      {
        objective: { type: "ageReach", ageId: "age1" },
        gatherClicksPerAction: 10,
        actionsPerSecond: 5,
        maxGameTime: 12000,
        recordSnapshots: false,
      } as never,
    ).run();
    const state = result.finalState;
    const farms = state.getBuildingCount("farm");
    if (farms === 0) return; // nothing to assert before the first farm lands

    const power = state.buildingPower("farm").toNumber();
    expect(power).toBeGreaterThan(1);

    const factors = state.getFactors("food");
    // `ResourceFactor` is a `[source, value]` tuple, hence `entry[1]`.
    for (const [, value] of factors.additiveMultiplier) {
      expect(value.toNumber()).toBeCloseTo(Math.pow(0.1 * farms, power), 4);
    }
  }, VERY_SLOW);
});
