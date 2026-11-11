import { DEFAULT_FORMATION, type FormationId } from "./formations";
import { DEFAULT_ORDER, type OrderId } from "./orders";
import {
  getEffectiveBattleStats,
  type ArmyStack,
  type BattleSimulation,
} from "./battle";
import type { UnitStats } from "./units";

type BattleDebugStack = {
  readonly unitId: string;
  readonly count: string;
  readonly formation: FormationId;
  readonly order: OrderId;
  readonly stats: {
    readonly hp: string;
    readonly attack: string;
    readonly armor: number;
    readonly range: number;
    readonly speed: number;
    readonly accuracy: number;
  };
};

export type BattleDebugLog = BattleSimulation & {
  readonly setup: {
    readonly schemaVersion: 2;
    readonly playerArmy: readonly BattleDebugStack[];
    readonly enemyArmy: readonly BattleDebugStack[];
  };
};

const serializeStats = (stats: UnitStats): BattleDebugStack["stats"] => ({
  hp: stats.hp.toString(),
  attack: stats.attack.toString(),
  armor: stats.armor,
  range: stats.range,
  speed: stats.speed,
  accuracy: stats.accuracy,
});

const serializeArmy = (
  army: readonly ArmyStack[],
): readonly BattleDebugStack[] =>
  army.map(({ unitId, count, stats, formation, order }) => {
    const effectiveFormation = formation ?? DEFAULT_FORMATION;
    return {
      unitId,
      count: count.toString(),
      formation: effectiveFormation,
      order: order ?? DEFAULT_ORDER,
      stats: serializeStats(getEffectiveBattleStats(stats, effectiveFormation)),
    };
  });

/** Adds a versioned snapshot of both deployed armies and their combat stats. */
export const buildBattleDebugLog = (
  simulation: BattleSimulation,
  playerArmy: readonly ArmyStack[],
  enemyArmy: readonly ArmyStack[],
): BattleDebugLog => ({
  ...simulation,
  setup: {
    schemaVersion: 2,
    playerArmy: serializeArmy(playerArmy),
    enemyArmy: serializeArmy(enemyArmy),
  },
});
