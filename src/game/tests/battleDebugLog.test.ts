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
        formation: "skirmish",
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
    const enemyArmy: ArmyStack[] = [
      {
        unitId: "wolf",
        count: ExpNumber.fromNumber(3),
        stats: {
          hp: ExpNumber.fromNumber(12),
          attack: ExpNumber.fromNumber(4),
          armor: 0.2,
          range: 2,
          speed: 1.5,
          accuracy: 0.8,
        },
        formation: "standard",
      },
    ];

    const log = buildBattleDebugLog(simulation, playerArmy, enemyArmy);

    expect(log).toMatchObject({
      rounds: [],
      outcome: "player",
      setup: {
        schemaVersion: 2,
        playerArmy: [
          {
            unitId: "warrior",
            count: "8e0",
            formation: "skirmish",
            order: "focus_weak",
            stats: {
              hp: "1e1",
              attack: "2e0",
              armor: 0,
              range: 2,
              speed: 1,
              accuracy: 1.5,
            },
          },
          {
            unitId: "archer",
            count: "4e0",
            formation: DEFAULT_FORMATION,
            order: DEFAULT_ORDER,
            stats: {
              hp: "5e0",
              attack: "3e0",
              armor: 0,
              range: 3,
              speed: 1,
              accuracy: 1,
            },
          },
        ],
        enemyArmy: [
          {
            unitId: "wolf",
            count: "3e0",
            formation: "standard",
            order: DEFAULT_ORDER,
            stats: {
              hp: "1.2e1",
              attack: "4e0",
              armor: 0.2,
              range: 2,
              speed: 1.5,
              accuracy: 0.8,
            },
          },
        ],
      },
    });
    expect(JSON.parse(JSON.stringify(log)).setup.playerArmy).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(log)).setup.enemyArmy).toHaveLength(1);
  });
});
