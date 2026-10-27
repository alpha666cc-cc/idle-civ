import { describe, expect, it } from "vitest";
import {
  mergeSimulatorArmy,
  solveMinimumArmy,
  type SimulatorOwnedArmy,
  type SimulatorTotalArmy,
} from "../battleSimulator";
import { ExpNumber } from "../expNumber";
import { simulateBattle, simulateBattleOutcome } from "../battle";
import { findUnitDefinition } from "../units";

const battleId = "age0_1_first_fire";
const warrior = findUnitDefinition("warrior");
if (!warrior) throw new Error("The Tribesman definition is missing.");
const wolf = findUnitDefinition("wolf");
if (!wolf) throw new Error("The wolf definition is missing.");

const ownedWarriors = (count: number): SimulatorOwnedArmy =>
  new Map([["warrior", ExpNumber.fromNumber(count)]]);

const context = () => ({
  getCost: (_unitId: string, count: number) => [
    {
      resource: "military" as const,
      base: ExpNumber.fromNumber(count * 20),
      factor: 1,
      exponent: 0.5,
    },
  ],
  getResearch: () => ({ ids: [], costs: [] }),
  wins: (total: SimulatorTotalArmy) =>
    (total.get("warrior")?.toNumber() ?? 0) >= 5,
  winsWithFormations: (total: SimulatorTotalArmy) =>
    (total.get("warrior")?.toNumber() ?? 0) >= 5,
  winsWithFormationsAndOrders: (total: SimulatorTotalArmy) =>
    (total.get("warrior")?.toNumber() ?? 0) >= 5,
});

describe("battle simulator current army", () => {
  it("lets a standard elephant close two positions to attack hoplites", () => {
    const elephant = findUnitDefinition("elephant_iron");
    const hoplite = findUnitDefinition("hoplite");
    if (!elephant || !hoplite)
      throw new Error("The elephant or hoplite definition is missing.");
    const battle = simulateBattle(
      [{ unitId: elephant.key, count: ExpNumber.ONE, stats: elephant.stats }],
      [{ unitId: hoplite.key, count: ExpNumber.ONE, stats: hoplite.stats }],
      { maxRounds: 12 },
    );
    const elephantAttacks = battle.rounds.flatMap((round) =>
      round.attacks.filter((attack) => attack.attackerId === elephant.key),
    );

    expect(elephantAttacks.length).toBeGreaterThan(0);
    expect(elephantAttacks[0].targetId).toBe(hoplite.key);
    expect(elephantAttacks[0].attackerPosition).toBe(0);
    expect(elephantAttacks[0].attackerSide).toBe("player");
    expect(elephantAttacks[0].targetSide).toBe("enemy");
    expect(elephantAttacks[0].reachableTargets).toContain(hoplite.key);
    expect(elephantAttacks[0].reachableTargetSide).toBe("enemy");
    expect(battle.rounds[0].player[0].side).toBe("player");
    expect(battle.rounds[0].enemy[0].side).toBe("enemy");
  });

  it("matches full playback outcomes without producing logs", () => {
    const player = [
      {
        unitId: warrior.key,
        count: ExpNumber.fromNumber(30),
        stats: warrior.stats,
      },
    ];
    const enemy = [
      {
        unitId: wolf.key,
        count: ExpNumber.fromNumber(8),
        stats: wolf.stats,
      },
    ];
    const full = simulateBattle(player, enemy);

    expect(simulateBattleOutcome(player, enemy)).toBe(full.outcome);
    expect(full.rounds.length).toBeGreaterThan(0);
  });

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
    expect(result.orders.size).toBeGreaterThanOrEqual(0);
  });

  it("returns no additional recruits when the current army already wins", () => {
    const owned = ownedWarriors(5);
    const result = solveMinimumArmy(
      battleId,
      [warrior],
      {
        ...context(),
        winsWithFormations: (total: SimulatorTotalArmy) =>
          (total.get("warrior")?.toNumber() ?? 0) >= 5,
        winsWithFormationsAndOrders: (total: SimulatorTotalArmy) =>
          (total.get("warrior")?.toNumber() ?? 0) >= 5,
      },
      false,
      owned,
    );

    expect(result?.composition.size).toBe(0);
    expect(result?.totalComposition.get("warrior")?.toNumber()).toBe(5);
    expect(result?.military.isZero).toBe(true);
    expect(result?.formations.size).toBeGreaterThanOrEqual(0);
    expect(result?.orders.size).toBeGreaterThanOrEqual(0);
  });

  it("passes only new unit types to the research cost evaluator", () => {
    const owned = new Map([["warrior", ExpNumber.fromNumber(4)]]);
    const result = solveMinimumArmy(
      battleId,
      [warrior],
      {
        ...context(),
        getResearch: (unitIds) => ({
          ids: unitIds,
          costs: [
            {
              resource: "science",
              base: ExpNumber.fromNumber(100),
              factor: 1,
              exponent: 0.5,
            },
          ],
        }),
        winsWithFormations: (total: SimulatorTotalArmy) =>
          (total.get("warrior")?.toNumber() ?? 0) >= 5,
        winsWithFormationsAndOrders: (total: SimulatorTotalArmy) =>
          (total.get("warrior")?.toNumber() ?? 0) >= 5,
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
