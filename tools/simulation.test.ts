import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  type ResourceKey,
} from "../src/game/attributes";
import { type BuildingKey } from "../src/game/buildings";
import { encounterDefinitions } from "../src/game/encounters";
import { CivilizationState } from "../src/game/civilizationState";
import { ExpNumber } from "../src/game/expNumber";
import { emptyStatistics } from "../src/game/statistics";
import { GameSimulation } from "./simulation";
import type { SimulationStrategy } from "./simulation";
import {
  getRequiredAgeAction,
  getRequiredBattle,
  getRequiredBattleAction,
  getRequiredBattlePreparationAction,
  getRequiredBattleUnitTargets,
  getStrategy,
} from "./strategies";

describe("simulation event snapshots", () => {
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
  } as const;

  const makeState = ({
    people = 0,
    buildings = {},
    resources = {},
    unitCounts = {},
    defeatedEncounters = [],
  }: {
    people?: number;
    buildings?: Partial<Record<BuildingKey, number>>;
    resources?: Partial<Record<ResourceKey, number>>;
    unitCounts?: Record<string, number>;
    defeatedEncounters?: string[];
  } = {}): CivilizationState => {
    const amounts = emptyResourceAmounts();
    for (const [key, value] of Object.entries(resources)) {
      amounts[key as ResourceKey] = ExpNumber.fromNumber(value);
    }
    const counts = Object.fromEntries(
      Object.entries(unitCounts).map(([key, value]) => [
        key,
        ExpNumber.fromNumber(value),
      ]),
    );
    return new CivilizationState(
      amounts,
      emptyWorkerAssignments(),
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

  it("enters the next age only after its data threshold and battles", () => {
    const ageZeroBattles = encounterDefinitions
      .filter(({ age }) => age === 0)
      .map(({ key }) => key);
    const ready = makeState({
      people: 1000,
      buildings: { farm: 250 },
      resources: richResources,
      defeatedEncounters: ageZeroBattles,
    });
    const belowThreshold = makeState({
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

    expect(getRequiredAgeAction(ready)).toEqual({
      type: "enterAge",
      ageId: "age-0",
    });
    expect(getRequiredAgeAction(belowThreshold)).toBeNull();
    expect(getRequiredAgeAction(missingBattle)).toBeNull();
  });
});
