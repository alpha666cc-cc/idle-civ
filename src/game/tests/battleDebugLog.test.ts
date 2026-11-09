import { describe, expect, it } from "vitest";
import { ExpNumber } from "../expNumber";
import { buildBattleDebugLog } from "../battleDebugLog";
import { DEFAULT_FORMATION } from "../formations";
import { DEFAULT_ORDER } from "../orders";
import type { ArmyStack, BattleSimulation } from "../battle";

const simulation: BattleSimulation = {
  rounds: [],
  outcome: "player",
  playerSurvivors: ExpNumber.fromNumber(4),
  enemySurvivors: ExpNumber.ZERO,
};

describe("battle debug logs", () => {
  it("records the deployed army with its formation and order", () => {
    const playerArmy: ArmyStack[] = [
      {
        unitId: "warrior",
        count: ExpNumber.fromNumber(8),
        stats: {
          hp: ExpNumber.fromNumber(10),
          attack: ExpNumber.fromNumber(2),
          armor: 0,
          range: 1,
          speed: 1,
          accuracy: 1,
        },
        formation: "frontline",
        order: "focus_weak",
      },
      {
        unitId: "archer",
        count: ExpNumber.fromNumber(4),
        stats: {
          hp: ExpNumber.fromNumber(5),
          attack: ExpNumber.fromNumber(3),
          armor: 0,
          range: 3,
          speed: 1,
          accuracy: 1,
        },
      },
    ];

    const log = buildBattleDebugLog(simulation, playerArmy);

    expect(log).toMatchObject({
      rounds: [],
      outcome: "player",
      setup: {
        schemaVersion: 1,
        playerArmy: [
          {
            unitId: "warrior",
            count: "8e0",
            formation: "frontline",
            order: "focus_weak",
          },
          {
            unitId: "archer",
            count: "4e0",
            formation: DEFAULT_FORMATION,
            order: DEFAULT_ORDER,
          },
        ],
      },
    });
    expect(JSON.parse(JSON.stringify(log)).setup.playerArmy).toHaveLength(2);
  });
});
