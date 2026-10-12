import { describe, expect, it } from "vitest";
import { ExpNumber } from "../../src/game/expNumber";
import { GameSimulation, createInitialState } from "../simulation";
import { growthCosts } from "../objectivePlan";
import { getStrategy } from "../strategies";

describe("population objective funding", () => {
  it("includes wood for a house when the citizen target exceeds live capacity", () => {
    const costs = growthCosts(createInitialState(), 90);
    const byResource = new Map(
      costs.map(({ resource, base }) => [resource, base]),
    );

    expect(byResource.has("food")).toBe(true);
    expect(byResource.has("wood")).toBe(true);
  });

  it("reaches 90 citizens in under three minutes using the objective plan", () => {
    const result = new GameSimulation(createInitialState(), getStrategy("objective")!, {
      objective: {
        type: "buildingCount",
        building: "people",
        target: 90,
      },
      gatherClicksPerAction: 10,
      actionsPerSecond: 5,
      maxGameTime: 420,
      recordSnapshots: false,
    }).run();

    expect(result.objectiveReached).toBe(true);
    expect(result.gameTime).toBeLessThanOrEqual(180);
  }, 30_000);

  it("prepares for and wins First Fire after reaching the population gate", () => {
    const result = new GameSimulation(createInitialState(), getStrategy("objective")!, {
      objective: {
        type: "battleVictory",
        encounterId: "age0_1_first_fire",
      },
      gatherClicksPerAction: 10,
      actionsPerSecond: 5,
      maxGameTime: 600,
      recordSnapshots: false,
    }).run();

    expect(result.objectiveReached).toBe(true);
    expect(result.gameTime).toBeLessThanOrEqual(600);
    expect(result.finalState.getBuildingCount("barracks")).toBeGreaterThan(0);
    expect(
      result.finalState.getUnitCount("warrior").gt(ExpNumber.ZERO),
    ).toBe(true);
    expect(result.finalState.defeatedEncounters).toContain("age0_1_first_fire");
  }, 30_000);

});