import { describe, expect, it } from "vitest";
import {
  mergeSimulatorArmy,
  solveMinimumArmy,
  type SimulatorOwnedArmy,
  type SimulatorTotalArmy,
} from "./battleSimulator";
import { ExpNumber } from "./expNumber";
import { findUnitDefinition } from "./units";

const battleId = "age0_1_first_fire";
const warrior = findUnitDefinition("warrior");
if (!warrior) throw new Error("The Tribesman definition is missing.");

const ownedWarriors = (count: number): SimulatorOwnedArmy =>
  new Map([["warrior", ExpNumber.fromNumber(count)]]);

const context = () => ({
  getCost: (_unitId: string, count: number) => [
    {
      resource: "military" as const,
      base: ExpNumber.fromNumber(count * 20),
      factor: 1,
    },
  ],
  getResearch: () => ({ ids: [], costs: [] }),
  wins: (total: SimulatorTotalArmy) =>
    (total.get("warrior")?.toNumber() ?? 0) >= 5,
});

describe("battle simulator current army", () => {
  it("merges owned units into the simulated total without charging them again", () => {
    const owned = ownedWarriors(4);
    const result = solveMinimumArmy(
      battleId,
      [warrior],
      context(),
      false,
      owned,
    );

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.composition.get("warrior")).toBe(1);
    expect(result.totalComposition.get("warrior")?.toNumber()).toBe(5);
    expect(result.military.toNumber()).toBe(20);
  });

  it("returns no additional recruits when the current army already wins", () => {
    const owned = ownedWarriors(5);
    const result = solveMinimumArmy(
      battleId,
      [warrior],
      context(),
      false,
      owned,
    );

    expect(result?.composition.size).toBe(0);
    expect(result?.totalComposition.get("warrior")?.toNumber()).toBe(5);
    expect(result?.military.isZero).toBe(true);
  });

  it("passes only new unit types to the research cost evaluator", () => {
    const owned = new Map([
      ["warrior", ExpNumber.fromNumber(4)],
    ]);
    const result = solveMinimumArmy(
      battleId,
      [warrior],
      {
        ...context(),
        getResearch: (unitIds) => ({
          ids: unitIds,
          costs: [{ resource: "science", base: ExpNumber.fromNumber(100), factor: 1 }],
        }),
      },
      false,
      owned,
    );

    expect(result?.research.ids).toEqual([]);
  });

  it("adds counts for different unit types", () => {
    const total = mergeSimulatorArmy(
      ownedWarriors(2),
      new Map([
        ["warrior", 3],
        ["slinger", 4],
      ]),
    );

    expect(total.get("warrior")?.toNumber()).toBe(5);
    expect(total.get("slinger")?.toNumber()).toBe(4);
  });
});
