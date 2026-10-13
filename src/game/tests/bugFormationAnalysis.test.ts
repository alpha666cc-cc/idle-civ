/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSave, loadSaveData } from "../saveSystem";
import type { ArmyStack, BattleOrder } from "../battle";
import { optimizeBattleTactics, simulatorCandidates } from "../battleSimulator";
import type {
  BattleSimulatorContext,
  SimulatorTotalArmy,
} from "../battleSimulator";
import type { FormationId } from "../formations";

const savePath = resolve(
  process.cwd(),
  "saves",
  "bug",
  "simualtor-bug-formation.xml",
);

describe("bug formation analysis", () => {
  it.skipIf(!existsSync(savePath))("inspects the bug formation save", () => {
    const xml = readFileSync(savePath, "utf-8");
    const saveData = parseSave(xml, "xml");
    const state = loadSaveData(saveData);

    const battle = state.getNextBattle();
    console.log("Next battle:", battle?.key, battle?.name);
    console.log("Current age:", state.getCurrentAge()?.key);
    console.log("Unit formations in state:", state.unitFormations);
    console.log("Unit orders in state:", state.unitOrders);

    if (battle) {
      // 1. Simulate using state's exact method (simulateEncounter)
      const encSim = state.simulateEncounter(battle.key);
      console.log("simulateEncounter outcome:", encSim?.outcome);
      if (encSim) {
        console.log("rounds length:", encSim.rounds.length);
        console.log("playerSurvivors:", encSim.playerSurvivors.toString());
        console.log("enemySurvivors:", encSim.enemySurvivors.toString());
        const lastRound = encSim.rounds[encSim.rounds.length - 1];
        console.log("Last round distance:", lastRound.distance);
        console.log("Last round player stacks:", lastRound.player.map(p => `${p.unitId}: ${p.count}`));
        console.log("Last round enemy stacks:", lastRound.enemy.map(e => `${e.unitId}: ${e.count}`));
      }

      // 2. What if formations are cleared (standard)?
      const stateWithStandard = state.applyFormationSnapshot({}, {});
      const encSimStandard = stateWithStandard.simulateEncounter(battle.key);
      console.log("simulateEncounter with standard formations outcome:", encSimStandard?.outcome);
      if (encSimStandard) {
        console.log("standard rounds:", encSimStandard.rounds.length);
      }

      // 3. What does optimizeBattleTactics say?
      const candidates = simulatorCandidates(battle.age);
      const ownedArmy = new Map(
        state.getArmyStacks().map(({ unitId, count }) => [unitId, count] as const),
      );
      console.log("Owned army size:", ownedArmy.size);

      const researchIds = state.boughtResearch;
      const stacksFor = (
        composition: SimulatorTotalArmy,
        formations?: ReadonlyMap<string, FormationId>,
        orders?: ReadonlyMap<string, BattleOrder>,
      ): ArmyStack[] =>
        [...composition].flatMap(([unitId, count]) => {
          const stats = state.getUnitStatsWithResearch(unitId, researchIds);
          if (!stats) return [];
          const formation = formations?.get(unitId);
          const order = orders?.get(unitId);
          return [{
            unitId,
            count,
            stats,
            ...(formation ? { formation } : {}),
            ...(order ? { order } : {}),
          }];
        });
      const context: BattleSimulatorContext = {
        getCost: (unitId, count) => state.getUnitCost(unitId, count),
        getResearch: (unitIds) => state.getResearchForUnitTypes(unitIds),
        wins: (composition, battleId) =>
          state.simulateWithStacksOutcome(
            stacksFor(composition),
            state.getEnemyStacks(battleId),
          ) === "player",
        winsWithFormations: (composition, formations, battleId) =>
          state.simulateWithStacksOutcome(
            stacksFor(composition, formations),
            state.getEnemyStacks(battleId),
          ) === "player",
        winsWithFormationsAndOrders: (
          composition,
          formations,
          orders,
          battleId,
        ) =>
          state.simulateWithStacksOutcome(
            stacksFor(composition, formations, orders),
            state.getEnemyStacks(battleId),
          ) === "player",
      };

      const opt = optimizeBattleTactics(
        battle.key,
        candidates,
        context,
        true,
        ownedArmy,
      );
      console.log("Optimizer result composition:", opt?.composition);
      console.log("Optimizer result formations:", opt?.formations);
      console.log("Optimizer result orders:", opt?.orders);

      if (opt) {
        expect(
          context.winsWithFormationsAndOrders(
            opt.totalComposition,
            opt.formations,
            opt.orders,
            battle.key,
          ),
        ).toBe(true);
      }
    }
  });
});
