import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  type ProductionResourceKey,
  type ResourceKey,
} from "../src/game/attributes";
import { type BuildingKey } from "../src/game/buildings";
import { CivilizationState } from "../src/game/civilizationState";
import { encounterDefinitions } from "../src/game/encounters";
import { ExpNumber } from "../src/game/expNumber";
import { researchDefinitions } from "../src/game/research";
import { emptyStatistics } from "../src/game/statistics";
import { getBestRoiAction, getBuyableRoi, getRoiCandidates } from "./roi";
import { getStrategy } from "./strategies";
import type { SimulationContext } from "./simulation";

/**
 * A decision context for a fixture. `SimulationContext.timing` is the run's live
 * counters, which no fixture cares about, so it is a zeroed stand-in rather than
 * a field every call site has to invent.
 */
const zeroTiming: SimulationContext["timing"] = {
  ticks: 0,
  tickMeanMs: 0,
  tickMaxMs: 0,
  decisions: 0,
  decisionMeanMs: 0,
  decisionMaxMs: 0,
};

const richResources: Partial<Record<ResourceKey, number>> = {
  food: 1e12,
  wood: 1e12,
  stone: 1e12,
  gold: 1e12,
  science: 1e12,
  military: 1e12,
  metalwork: 1e12,
  trade: 1e12,
};

const makeState = ({
  people = 0,
  buildings = {},
  resources = richResources,
  workers = {},
  defeatedEncounters = [],
  unitCounts = {},
}: {
  people?: number;
  buildings?: Partial<Record<BuildingKey, number>>;
  resources?: Partial<Record<ResourceKey, number>>;
  workers?: Partial<Record<ProductionResourceKey, number>>;
  defeatedEncounters?: string[];
  unitCounts?: Record<string, number>;
} = {}): CivilizationState => {
  const amounts = emptyResourceAmounts();
  for (const [key, value] of Object.entries(resources)) {
    amounts[key as ResourceKey] = ExpNumber.fromNumber(value);
  }
  const assignments = emptyWorkerAssignments();
  for (const [key, value] of Object.entries(workers)) {
    assignments[key as ProductionResourceKey] = ExpNumber.fromNumber(value);
  }
  return new CivilizationState(
    amounts,
    assignments,
    { townHall: 1, ...buildings, people },
    emptyResourceFactors(),
    {},
    0,
    [],
    defeatedEncounters,
    [],
    [],
    emptyStatistics(),
    Object.fromEntries(
      Object.entries(unitCounts).map(([key, value]) => [
        key,
        ExpNumber.fromNumber(value),
      ]),
    ),
  );
};

describe("simulation ROI evaluation", () => {
  it("measures an enhancer's production and capacity effect", () => {
    const state = makeState({
      people: 100,
      buildings: { farm: 9 },
      workers: { food: 10, wood: 10 },
    });
    const evaluation = getBuyableRoi(state, {
      kind: "upgrade",
      id: "farmEnhancer9",
    });

    expect(evaluation).not.toBeNull();
    expect(evaluation?.metrics.production).toBeGreaterThan(0);
    expect(evaluation?.metrics.capacity).toBeGreaterThan(0);
    expect(evaluation?.benefit).toBeGreaterThan(0);
    expect(evaluation?.reachable).toBe(true);
  });

  it("applies the configurable upgrade preference", () => {
    const state = makeState({
      people: 100,
      buildings: { farm: 9 },
      workers: { food: 10, wood: 10 },
    });
    const normal = getBuyableRoi(
      state,
      { kind: "upgrade", id: "farmEnhancer9" },
      { upgradeMultiplier: 1 },
    );
    const boosted = getBuyableRoi(
      state,
      { kind: "upgrade", id: "farmEnhancer9" },
      { upgradeMultiplier: 4 },
    );

    expect(normal).not.toBeNull();
    expect(boosted).not.toBeNull();
    expect(boosted?.benefit).toBeCloseTo((normal?.benefit ?? 0) * 4, 8);
  });

  it("measures a research purchase through production and cost effects", () => {
    const state = makeState({
      people: 100,
      buildings: { university: 1 },
      workers: { food: 5 },
    });
    const evaluation = getBuyableRoi(state, {
      kind: "research",
      id: "agriculture",
    });

    expect(evaluation).not.toBeNull();
    expect(evaluation?.metrics.production).toBeGreaterThan(0);
    expect(evaluation?.metrics.costSavings).toBeGreaterThan(0);
    expect(evaluation?.action).toEqual({
      type: "buyResearch",
      researchId: "agriculture",
    });
  });

  it("reports acquisition time and a gatherable blocker", () => {
    const state = makeState({
      people: 100,
      buildings: { farm: 9 },
      resources: { food: 0, wood: 0, stone: 0, gold: 0 },
      workers: { food: 5, wood: 5 },
    });
    const evaluation = getBuyableRoi(state, {
      kind: "upgrade",
      id: "farmEnhancer9",
    });

    expect(evaluation?.affordable).toBe(false);
    expect(evaluation?.waitSeconds).toBeGreaterThan(0);
    expect(["food", "wood"]).toContain(evaluation?.gatherResource);
  });

  it("exposes upgrade and unit candidates by default", () => {
    const state = makeState({
      people: 100,
      buildings: { farm: 9 },
      workers: { food: 10, wood: 10 },
    });
    const candidates = getRoiCandidates(state);

    expect(
      candidates.some(
        (candidate) =>
          candidate.buyable.kind === "upgrade" &&
          candidate.buyable.id === "farmEnhancer9",
      ),
    ).toBe(true);
    expect(
      candidates.some((candidate) => candidate.buyable.kind === "unit"),
    ).toBe(true);
    expect(
      getRoiCandidates(state, { includeUnits: false }).some(
        (candidate) => candidate.buyable.kind === "unit",
      ),
    ).toBe(false);
  });

  it("gives a ready age transition overwhelming ROI after its research is complete", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const ready = makeState({
      people: 1000,
      buildings: { farm: 250, university: 1 },
      defeatedEncounters: ageZeroBattles,
    });
    expect(ready.canEnterAge("age0")).toBe(true);

    let researched = ready;
    const ageResearch = researchDefinitions.filter(({ age }) => age === 0);
    for (let pass = 0; pass < ageResearch.length; pass += 1) {
      for (const research of ageResearch) {
        if (
          !researched.isResearchBought(research.key) &&
          researched.canBuyResearch(research.key)
        ) {
          researched = researched.buyResearch(research.key);
        }
      }
    }
    expect(
      ageResearch.every(({ key }) => researched.isResearchBought(key)),
    ).toBe(true);

    const age = getRoiCandidates(researched, { includeUnits: false }).find(
      ({ buyable }) => buyable.kind === "age" && buyable.id === "age0",
    );
    expect(age?.action).toEqual({ type: "enterAge", ageId: "age0" });
    expect(age?.metrics.campaign).toBe(1_000_000);
    expect(age?.score).toBeGreaterThan(20_000_000);
  });

  it("lets Speedrun choose a high-ROI age transition", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    let state = makeState({
      people: 1000,
      buildings: { farm: 250, university: 1 },
      defeatedEncounters: ageZeroBattles,
    });
    const ageResearch = researchDefinitions.filter(({ age }) => age === 0);
    for (let pass = 0; pass < ageResearch.length; pass += 1) {
      for (const research of ageResearch) {
        if (
          !state.isResearchBought(research.key) &&
          state.canBuyResearch(research.key)
        ) {
          state = state.buyResearch(research.key);
        }
      }
    }

    expect(
      getStrategy("speedrun")?.decideAction(state, {
        gameTime: 100,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).toEqual({ type: "enterAge", ageId: "age0" });
  });

  it("scores a capacity-unlocking battle above ordinary purchases", () => {
    const firstBattle = encounterDefinitions[0];
    expect(firstBattle).toBeDefined();
    if (!firstBattle) return;
    const state = makeState({
      people: 100,
      buildings: { house: 10 },
      resources: { ...richResources, peopleCapacity: 100 },
      unitCounts: { warrior: 1_000_000 },
    });
    const evaluation = getBuyableRoi(
      state,
      { kind: "battle", id: firstBattle.key },
      {
        planBattle: () => ({
          composition: new Map(),
          costs: [],
          research: [],
        }),
      },
    );

    expect(evaluation?.metrics.capacity).toBeGreaterThan(0);
    expect(evaluation?.metrics.campaign).toBeGreaterThan(1);
    expect(evaluation?.score).toBeGreaterThan(2_000);
    expect(evaluation?.action).toEqual({
      type: "launchBattle",
      encounterId: firstBattle.key,
    });
    expect(
      getBestRoiAction(state, {
        planBattle: () => ({
          composition: new Map(),
          costs: [],
          research: [],
        }),
      }),
    ).toEqual({ type: "launchBattle", encounterId: firstBattle.key });
  });

  it("rewards production that shortens the next battle's actual bottleneck", () => {
    const state = makeState({
      people: 90,
      buildings: { townHall: 2, barracks: 1, university: 1 },
      resources: { ...richResources, military: 0, farmCapacity: 10 },
      workers: { military: 50 },
    });
    const planBattle = (_candidateState: CivilizationState) => ({
      composition: new Map([["warrior", 10]]),
      costs: [
        {
          resource: "military" as ResourceKey,
          base: ExpNumber.fromNumber(1_000_000),
          factor: 1,
        },
      ],
      research: [],
    });
    const barracks = getBuyableRoi(
      state,
      { kind: "building", id: "barracks" },
      { planBattle },
    );
    const farm = getBuyableRoi(
      state,
      { kind: "building", id: "farm" },
      { planBattle },
    );

    expect(barracks?.metrics.campaignTime).toBeGreaterThan(0);
    expect(farm?.metrics.campaignTime).toBe(0);
    expect(barracks?.score).toBeGreaterThan(farm?.score ?? 0);
  });

  it("registers a speedrun strategy that can return an ROI action", () => {
    const strategy = getStrategy("speedrun");
    expect(strategy?.name).toBe("speedrun");
    expect(strategy).toBeDefined();

    const state = makeState({
      people: 0,
      buildings: { house: 1 },
      workers: { food: 1 },
    });
    const action = getBestRoiAction(state);
    expect(action).not.toBeNull();
  });

  it("gives population growth campaign value until the next milestone", () => {
    const state = makeState({
      people: 0,
      buildings: { house: 1 },
      resources: { ...richResources, peopleCapacity: 10 },
      workers: { food: 1 },
    });
    const candidate = getRoiCandidates(state, {
      includeUnits: false,
      populationTarget: 90,
    }).find(
      ({ buyable }) => buyable.kind === "building" && buyable.id === "people",
    );

    expect(candidate?.metrics.campaign).toBe(1_000_000);
    expect(
      getBestRoiAction(state, {
        includeUnits: false,
        populationTarget: 90,
      }),
    ).toEqual({ type: "build", building: "people", count: 1 });
  });

  it("ranks food production ahead of gathering for an unaffordable citizen", () => {
    const state = makeState({
      people: 86,
      buildings: { house: 9 },
      resources: {
        ...richResources,
        food: 0,
        science: 0,
        peopleCapacity: 90,
        farmCapacity: 10,
      },
      workers: { food: 45 },
    });
    const citizen = getBuyableRoi(
      state,
      { kind: "building", id: "people" },
      { populationTarget: 90 },
    );
    const candidates = getRoiCandidates(state, {
      includeUnits: false,
      populationTarget: 90,
    });

    expect(citizen?.affordable).toBe(false);
    expect(candidates[0]?.buyable).toEqual({ kind: "building", id: "farm" });
    expect(
      getBestRoiAction(state, {
        includeUnits: false,
        populationTarget: 90,
      }),
    ).toEqual({ type: "gather", resource: "food" });
  });

  it("builds ahead of the food guard when the settlement is rich", () => {
    const strategy = getStrategy("speedrun");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    const state = makeState({
      people: 1,
      buildings: { house: 1 },
      resources: { food: 0, wood: 1e6, stone: 1e6, gold: 1e6 },
      workers: { food: 1 },
    });
    // The mandatory age route outranks the food guard. A citizen both costs
    // food and drains 1/second, so a settlement large enough to matter sits at
    // or below zero food almost continuously; a guard that fired first returned
    // `gather food` for 1127 of 1800 actions and the settlement never grew past
    // 100 citizens. With a rich treasury the route must therefore reach a
    // *build* — here housing, because this fixture's capacity is full — rather
    // than the `gather food` the old ordering demanded.
    const action = strategy.decideAction(state, {
      gameTime: 1,
      snapshots: [],
      timing: zeroTiming,
    });
    expect(action).not.toEqual({ type: "gather", resource: "food" });
    expect(action?.type).toBe("build");
  });

  it("focuses workers on food after the growth route has nothing to offer", () => {
    const strategy = getStrategy("speedrun");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    // Housing exhausted, no town hall left, and a citizen is unaffordable: the
    // route has no population work, so the food guard is allowed to speak.
    const state = makeState({
      people: 100,
      buildings: { house: 10 },
      resources: { food: 0, wood: 1e6, stone: 1e6, gold: 1e6 },
      workers: { food: 1 },
    });
    expect(
      strategy.decideAction(state, {
        gameTime: 900,
        snapshots: [],
        timing: zeroTiming,
      }),
    ).toEqual({
      type: "assignWorker",
      resource: "food",
      count: 49,
    });
  });

  it("lets ROI choose combat spending instead of forcing preparation buildings", () => {
    const strategy = getStrategy("speedrun");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    const state = makeState({
      people: 90,
      resources: richResources,
    });
    const action = strategy.decideAction(state, {
      gameTime: 90,
      snapshots: [],
      timing: zeroTiming,
    });
    expect(action?.type).toBe("buyUnit");
    if (action?.type === "buyUnit") expect(action.unitId).toBe("warrior");
  });
});
