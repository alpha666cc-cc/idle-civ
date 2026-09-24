import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyWorkerAssignments,
} from "../src/game/attributes";
import { CivilizationState } from "../src/game/civilizationState";
import { ExpNumber } from "../src/game/expNumber";
import { GameSimulation } from "./simulation";
import type { SimulationStrategy } from "./simulation";

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
