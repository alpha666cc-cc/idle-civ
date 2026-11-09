import { DEFAULT_FORMATION, type FormationId } from "./formations";
import { DEFAULT_ORDER, type OrderId } from "./orders";
import type { ArmyStack, BattleSimulation } from "./battle";

export type BattleDebugLog = BattleSimulation & {
  readonly setup: {
    readonly schemaVersion: 1;
    readonly playerArmy: readonly {
      readonly unitId: string;
      readonly count: string;
      readonly formation: FormationId;
      readonly order: OrderId;
    }[];
  };
};

/** Adds a versioned snapshot of the deployed player army and its tactics. */
export const buildBattleDebugLog = (
  simulation: BattleSimulation,
  playerArmy: readonly ArmyStack[],
): BattleDebugLog => ({
  ...simulation,
  setup: {
    schemaVersion: 1,
    playerArmy: playerArmy.map(({ unitId, count, formation, order }) => ({
      unitId,
      count: count.toString(),
      formation: formation ?? DEFAULT_FORMATION,
      order: order ?? DEFAULT_ORDER,
    })),
  },
});
