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
import { ExpNumber } from "../src/game/expNumber";
import { emptyStatistics } from "../src/game/statistics";
import {
  getBestRoiAction,
  getBuyableRoi,
  getRoiCandidates,
} from "./roi";
import { getStrategy } from "./strategies";

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
}: {
  people?: number;
  buildings?: Partial<Record<BuildingKey, number>>;
  resources?: Partial<Record<ResourceKey, number>>;
  workers?: Partial<Record<ProductionResourceKey, number>>;
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
    { "town-hall": 1, ...buildings, people },
    emptyResourceFactors(),
    {},
    0,
    [],
    [],
    [],
    [],
    emptyStatistics(),
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
      id: "farm-enhancer-9",
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
      { kind: "upgrade", id: "farm-enhancer-9" },
      { upgradeMultiplier: 1 },
    );
    const boosted = getBuyableRoi(
      state,
      { kind: "upgrade", id: "farm-enhancer-9" },
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
      id: "farm-enhancer-9",
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
          candidate.buyable.id === "farm-enhancer-9",
      ),
    ).toBe(true);
    expect(candidates.some((candidate) => candidate.buyable.kind === "unit")).toBe(
      true,
    );
    expect(
      getRoiCandidates(state, { includeUnits: false }).some(
        (candidate) => candidate.buyable.kind === "unit",
      ),
    ).toBe(false);
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

  it("gathers food before ROI purchases when the food buffer is empty", () => {
    const strategy = getStrategy("speedrun");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    const state = makeState({
      people: 1,
      buildings: { house: 1 },
      resources: { food: 0, wood: 1e6, stone: 1e6, gold: 1e6 },
      workers: { food: 1 },
    });
    expect(strategy.decideAction(state, { gameTime: 1, snapshots: [] })).toEqual({
      type: "gather",
      resource: "food",
    });
  });

  it("keeps required battle preparation ahead of ROI purchases", () => {
    const strategy = getStrategy("speedrun");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    const state = makeState({
      people: 90,
      resources: richResources,
    });
    expect(strategy.decideAction(state, { gameTime: 90, snapshots: [] })).toEqual({
      type: "build",
      building: "barracks",
      count: 1,
    });
  });
});
