import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  type ProductionResourceKey,
  type ResourceKey,
} from "../src/game/attributes";
import { buildingDefinitions, type BuildingKey } from "../src/game/buildings";
import { encounterDefinitions } from "../src/game/encounters";
import { CivilizationState } from "../src/game/civilizationState";
import { ExpNumber } from "../src/game/expNumber";
import { emptyStatistics } from "../src/game/statistics";
import { GameSimulation, createInitialState } from "./simulation";
import type { SimulationStrategy } from "./simulation";
import {
  getRequiredAgeAction,
  getRequiredBattle,
  getRequiredBattleAction,
  getRequiredBattlePreparationAction,
  getRequiredBattleUnitTargets,
  getRequiredResearchAction,
  getBootstrapGatherResource,
  getRecommendedBattlePurchase,
  getSimulatorBattlePlan,
  getStrategy,
} from "./strategies";

describe("simulation event snapshots", () => {
  const makeActionRateState = () =>
    new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e6),
        wood: ExpNumber.fromNumber(1e6),
      },
      emptyWorkerAssignments(),
      { "town-hall": 1 },
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      [],
      [],
      emptyStatistics(),
    );

  it("executes five normal actions before one tick by default", () => {
    let decisions = 0;
    const strategy: SimulationStrategy = {
      name: "action-rate",
      description: "counts normal strategy decisions",
      decideAction: () => {
        decisions += 1;
        return { type: "wait", seconds: 0 };
      },
    };
    const result = new GameSimulation(makeActionRateState(), strategy, {
      seed: 42,
      objective: { type: "timeLimit", seconds: 1 },
      gatherClicksPerAction: 1,
      maxGameTime: 1,
      recordSnapshots: false,
    }).run();

    expect(decisions).toBe(5);
    expect(result.gameTime).toBe(1);
  });

  it("honors an explicit action budget", () => {
    let decisions = 0;
    const strategy: SimulationStrategy = {
      name: "action-override",
      description: "counts normal strategy decisions",
      decideAction: () => {
        decisions += 1;
        return { type: "wait", seconds: 0 };
      },
    };
    const result = new GameSimulation(makeActionRateState(), strategy, {
      seed: 42,
      objective: { type: "timeLimit", seconds: 1 },
      gatherClicksPerAction: 1,
      actionsPerSecond: 2,
      maxGameTime: 1,
      recordSnapshots: false,
    }).run();

    expect(decisions).toBe(2);
    expect(result.gameTime).toBe(1);
  });

  it("uses the full default action budget for one gather decision", () => {
    let decisions = 0;
    const strategy: SimulationStrategy = {
      name: "gather-rate",
      description: "counts gather decisions",
      decideAction: () => {
        decisions += 1;
        return { type: "gather", resource: "food" };
      },
    };
    const result = new GameSimulation(makeActionRateState(), strategy, {
      seed: 42,
      objective: { type: "timeLimit", seconds: 1 },
      gatherClicksPerAction: 1,
      maxGameTime: 1,
      recordSnapshots: false,
    }).run();

    expect(decisions).toBe(1);
    expect(result.finalState.statistics.productionClicks.toNumber()).toBe(1);
    expect(result.gameTime).toBe(1);
  });

  it("reports the effective capacity after an enhancer purchase", () => {
    const state = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(3000),
        wood: ExpNumber.fromNumber(1000),
      },
      emptyWorkerAssignments(),
      { house: 1, farm: 9, people: 1 },
    );
    const strategy: SimulationStrategy = {
      name: "test",
      description: "buys the first farm enhancer",
      decideAction: () => ({
        type: "buyUpgrade",
        upgradeId: "farm-enhancer-9",
      }),
    };
    const result = new GameSimulation(state, strategy, {
      seed: 42,
      objective: { type: "timeLimit", seconds: 1 },
      gatherClicksPerAction: 1,
      maxGameTime: 1,
      recordSnapshots: false,
    }).run();
    const event = result.events.find(
      ({ type, id }) =>
        type === "upgrade" && id === "farm-enhancer-9",
    );

    expect(result.finalState.resources.farmCapacity.toString()).toBe("1e1");
    expect(result.finalState.getBuildingMax("farm").toString()).toBe("1e2");
    expect(event?.resources.farmCapacity).toBe("1e2");
  });
});

describe("required progression strategy", () => {
  const richResources = {
    food: 1e12,
    wood: 1e12,
    stone: 1e12,
    gold: 1e12,
    science: 1e12,
  } as const;

  const simulatorResources = {
    ...richResources,
    military: 1e12,
    metalwork: 1e12,
    trade: 1e12,
  } as const;

  const makeState = ({
    people = 0,
    buildings = {},
    resources = {},
    workers = {},
    unitCounts = {},
    defeatedEncounters = [],
  }: {
    people?: number;
    buildings?: Partial<Record<BuildingKey, number>>;
    resources?: Partial<Record<ResourceKey, number>>;
    workers?: Partial<Record<ProductionResourceKey, number>>;
    unitCounts?: Record<string, number>;
    defeatedEncounters?: string[];
  } = {}): CivilizationState => {
    const amounts = emptyResourceAmounts();
    for (const [key, value] of Object.entries(resources)) {
      amounts[key as ResourceKey] = ExpNumber.fromNumber(value);
    }
    const assignments = emptyWorkerAssignments();
    for (const [key, value] of Object.entries(workers)) {
      assignments[key as ProductionResourceKey] = ExpNumber.fromNumber(value);
    }
    const counts = Object.fromEntries(
      Object.entries(unitCounts).map(([key, value]) => [
        key,
        ExpNumber.fromNumber(value),
      ]),
    );
    return new CivilizationState(
      amounts,
      assignments,
      { "town-hall": 1, ...buildings, people },
      emptyResourceFactors(),
      {},
      0,
      [],
      defeatedEncounters,
      [],
      [],
      emptyStatistics(),
      counts,
    );
  };

  it("exposes the next data-defined battle before it is winnable", () => {
    const state = makeState({ resources: richResources });
    const firstBattle = encounterDefinitions[0];
    expect(firstBattle).toBeDefined();
    if (!firstBattle) return;

    expect(getRequiredBattle(state)?.key).toBe(firstBattle.key);
    expect(getRequiredBattleAction(state)).toBeNull();

    const armed = makeState({
      people: 100,
      resources: richResources,
      unitCounts: { warrior: 10 },
    });
    expect(getRequiredBattleAction(armed)).toEqual({
      type: "launchBattle",
      encounterId: firstBattle.key,
    });
  });

  it("finds a player unit path for beast-only encounters", () => {
    const firstBattle = encounterDefinitions[0];
    expect(firstBattle).toBeDefined();
    if (!firstBattle) return;
    const state = makeState({
      people: 100,
      resources: richResources,
      defeatedEncounters: [],
    });

    expect(getRequiredBattleUnitTargets(state)[0]?.key).toBe("slinger");
  });

  it("prefers a named buyable enemy over the generic domain fallback", () => {
    const bronzeRaid = encounterDefinitions.find(
      ({ key }) => key === "age0_3_bronze_raid",
    );
    expect(bronzeRaid).toBeDefined();
    if (!bronzeRaid) return;
    const state = makeState({
      people: 100,
      resources: richResources,
      defeatedEncounters: encounterDefinitions
        .filter(({ key }) =>
          ["age0_1_first_fire", "age0_2_wolf_pack"].includes(key),
        )
        .map(({ key }) => key),
    });

    expect(getRequiredBattleUnitTargets(state).map(({ key }) => key)).toEqual([
      "axeman_bronze",
    ]);
  });

  it("queues Bronze Raid's research hint before the next battle", () => {
    let state = makeState({
      people: 100,
      resources: richResources,
      defeatedEncounters: ["age0_1_first_fire"],
    });
    const order = [
      "agriculture",
      "pottery",
      "sling_throwing",
      "writing",
    ];

    for (const researchId of order) {
      expect(getRequiredResearchAction(state)).toEqual({
        type: "buyResearch",
        researchId,
      });
      state = state.buyResearch(researchId);
    }
    expect(getRequiredResearchAction(state)).toBeNull();
  });

  it("does not gather toward a battle plan blocked on unproducible resources", () => {
    // The advisor wants warriors, which cost military. With no barracks there is
    // no military production, so the plan is blocked on infrastructure: the
    // advisor must offer no purchase and must not spend the gather budget on it.
    const state = createInitialState();
    const plan = getSimulatorBattlePlan(state);

    expect(plan).not.toBeNull();
    expect(getRecommendedBattlePurchase(state, plan)).toBeNull();
    expect(getStrategy("balanced")?.decideAction(state, { gameTime: 0, snapshots: [] })).not.toEqual({
      type: "gather",
      resource: "military",
    });
  });

  it("gathers for the cheapest purchase while no worker produces anything", () => {
    // Every production rate ties at zero without workers, so a lowest-rate
    // heuristic would lock onto one arbitrary resource and never bootstrap.
    const state = createInitialState();

    expect(state.assignedWorkers).toBe(0);
    const target = getBootstrapGatherResource(state);
    expect(target).not.toBeNull();

    // The target must actually unblock the economy: repeatedly gathering it has
    // to make the settlement's first building purchasable.
    const canBuildAnything = (candidate: CivilizationState) =>
      buildingDefinitions.some(({ key }) => candidate.canBuild(key));
    let bootstrapped = state;
    for (let step = 0; step < 200 && !canBuildAnything(bootstrapped); step += 1) {
      bootstrapped = bootstrapped.gather(target as ProductionResourceKey);
    }
    expect(canBuildAnything(bootstrapped)).toBe(true);
  });

  it("advances the age whenever the engine allows it, whatever the population", () => {
    // Regression: the strategy helper used to add its own population gate, so a
    // run that had won every age-0 battle and cleared the building target still
    // sat at 999 citizens — one short of the next age's 1000 threshold — and
    // never asked to advance, even though `canEnterAge` said it could.
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const state = makeState({
      people: 999,
      // Clears the 125% building target for age-0 with room to spare.
      buildings: { farm: 1200 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });

    expect(state.canEnterAge("age-0")).toBe(true);
    expect(getRequiredAgeAction(state)).toEqual({
      type: "enterAge",
      ageId: "age-0",
    });
    // And the cheapest strategy asks for it ahead of any purchase.
    expect(
      getStrategy("cheapest")?.decideAction(state, { gameTime: 0, snapshots: [] }),
    ).toEqual({ type: "enterAge", ageId: "age-0" });
  });

  it("waits for the age transition until the engine says it is allowed", () => {
    const notReady = makeState({ people: 999, resources: richResources });
    expect(notReady.canEnterAge("age-0")).toBe(false);
    expect(getRequiredAgeAction(notReady)).toBeNull();
  });

  it("buys the advisor shortfall and re-plans after the purchase", () => {
    const state = makeState({
      people: 100,
      buildings: { barracks: 1, university: 1, smithy: 1 },
      resources: simulatorResources,
      unitCounts: { warrior: 4 },
    });
    const plan = getSimulatorBattlePlan(state);
    const strategy = getStrategy("balanced");

    expect(plan).not.toBeNull();
    expect(plan?.totalComposition.get("warrior")?.toNumber()).toBeGreaterThan(4);
    expect(strategy?.decideAction(state, { gameTime: 0, snapshots: [] })).toEqual({
      type: "buyUnit",
      unitId: "warrior",
      count: plan?.composition.get("warrior"),
    });

    const recommended = plan?.composition.get("warrior") ?? 0;
    const afterPurchase = state.buyUnit("warrior", recommended);
    expect(getSimulatorBattlePlan(afterPurchase)?.composition.size).toBe(0);
    expect(getRequiredBattleAction(afterPurchase)).toEqual({
      type: "launchBattle",
      encounterId: "age0_1_first_fire",
    });
  });

  it("buys simulator-required research and re-plans the army", () => {
    const state = makeState({
      people: 100,
      buildings: { barracks: 1, university: 1, smithy: 1 },
      resources: simulatorResources,
      defeatedEncounters: ["age0_1_first_fire"],
    });
    const plan = getSimulatorBattlePlan(state);
    const firstResearch = plan?.research.ids[0];
    const strategy = getStrategy("balanced");

    expect(plan).not.toBeNull();
    expect(firstResearch).toBeDefined();
    expect(strategy?.decideAction(state, { gameTime: 0, snapshots: [] })).toEqual({
      type: "buyResearch",
      researchId: firstResearch,
    });
    if (!firstResearch) return;

    const afterResearch = state.buyResearch(firstResearch);
    expect(getSimulatorBattlePlan(afterResearch)?.research.ids).not.toContain(
      firstResearch,
    );
  });

  it("buys the cheapest affordable purchase instead of a priority purchase", () => {
    const strategy = getStrategy("cheapest");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    const state = makeState({
      resources: { wood: 10, food: 0, stone: 0, gold: 0 },
    });

    expect(strategy.decideAction(state, { gameTime: 0, snapshots: [] })).toEqual({
      type: "build",
      building: "house",
      count: 1,
    });
  });

  it("keeps the cheapest strategy in the simulation registry", () => {
    expect(getStrategy("cheapest")?.description).toBe(
      "Always buy the cheapest legal purchase",
    );
  });

  it("moves a surplus worker to an under-assigned resource", () => {
    const strategy = getStrategy("production");
    expect(strategy).toBeDefined();
    if (!strategy) return;
    const state = makeState({
      people: 10,
      resources: { food: 1e6, wood: 1e6, stone: 1e6, gold: 1e6 },
      workers: { food: 9, wood: 1 },
    });

    expect(strategy.decideAction(state, { gameTime: 0, snapshots: [] })).toEqual({
      type: "unassignWorker",
      resource: "food",
      count: 3,
    });
    const afterUnassign = state.unassignWorker("food", 3);
    expect(
      strategy.decideAction(afterUnassign, { gameTime: 1, snapshots: [] }),
    ).toEqual({
      type: "assignWorker",
      resource: "wood",
      count: 1,
    });
  });

  it("prepares a building once its existing unlock gate is met", () => {
    const beforeGate = makeState({ people: 89, resources: richResources });
    const atGate = makeState({ people: 90, resources: richResources });

    expect(getRequiredBattlePreparationAction(beforeGate)).toBeNull();
    expect(getRequiredBattlePreparationAction(atGate)).toEqual({
      type: "build",
      building: "barracks",
      count: 1,
    });
  });

  it("makes the production strategy follow the required battle path", () => {
    const strategy = getStrategy("production");
    expect(strategy).toBeDefined();
    if (!strategy) return;

    const atGate = makeState({ people: 90, resources: richResources });
    expect(strategy.decideAction(atGate, { gameTime: 90, snapshots: [] })).toEqual({
      type: "build",
      building: "barracks",
      count: 1,
    });
  });

  it("counts the next age as reached after entering the completed age", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const ready = makeState({
      people: 1000,
      buildings: { farm: 250 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });
    const strategy: SimulationStrategy = {
      name: "age-transition",
      description: "enters the current age when its requirements are met",
      decideAction: (state) => getRequiredAgeAction(state),
    };
    const result = new GameSimulation(ready, strategy, {
      seed: 42,
      objective: { type: "ageReach", ageId: "age-1" },
      gatherClicksPerAction: 1,
      maxGameTime: 2,
      recordSnapshots: false,
    }).run();

    expect(result.finalState.getCurrentAge()?.key).toBe("age-1");
    expect(result.objectiveReached).toBe(true);
    expect(result.success).toBe(true);
  });

  it("enters the next age only once every battle is won and the target is built", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const ready = makeState({
      people: 1000,
      buildings: { farm: 250 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });
    // One citizen short of the next age's population threshold, but the engine
    // only asks for battles and buildings — so this is still ready to advance.
    const oneCitizenShort = makeState({
      people: 999,
      buildings: { farm: 250 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });
    const missingBattle = makeState({
      people: 1000,
      buildings: { farm: 250 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles.slice(1),
    });
    const missingBuildings = makeState({
      people: 1000,
      buildings: { farm: 2 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });

    expect(getRequiredAgeAction(ready)).toEqual({
      type: "enterAge",
      ageId: "age-0",
    });
    expect(getRequiredAgeAction(oneCitizenShort)).toEqual({
      type: "enterAge",
      ageId: "age-0",
    });
    expect(getRequiredAgeAction(missingBattle)).toBeNull();
    expect(getRequiredAgeAction(missingBuildings)).toBeNull();
    // The engine agrees in every case: the helper adds no rule of its own.
    expect(ready.canEnterAge("age-0")).toBe(true);
    expect(oneCitizenShort.canEnterAge("age-0")).toBe(true);
    expect(missingBattle.canEnterAge("age-0")).toBe(false);
    expect(missingBuildings.canEnterAge("age-0")).toBe(false);
  });
});
