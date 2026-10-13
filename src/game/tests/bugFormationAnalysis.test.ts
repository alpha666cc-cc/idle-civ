import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { parseSave, loadSaveData } from "../saveSystem";
import { simulateBattle } from "../battle";
import { encounterDefinitions } from "../encounters";
import { simulatorCandidates, optimizeBattleTactics } from "../battleSimulator";

describe("bug formation analysis", () => {
  it("inspects the bug formation save", () => {
    const xml = fs.readFileSync("d:/work/dev/idle-civ/saves/bug/simualtor-bug-formation.xml", "utf-8");
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
      const context = {
        getCost: (unitId: string, count: number) => state.getUnitCost(unitId, count),
        getResearch: (unitIds: readonly string[]) => state.getResearchForUnitTypes(unitIds),
        wins: (composition: any, battleId: string) => {
          const stacks = [...composition.entries()].map(([unitId, count]: any) => ({
            unitId,
            count,
            stats: state.getUnitStatsWithResearch(unitId, researchIds)!,
          })).filter((s: any) => s.stats);
          const enemy = state.getEnemyStacks(battleId);
          return state.simulateWithStacksOutcome(stacks, enemy) === "player";
        },
        winsWithFormations: (composition: any, formations: any, battleId: string) => {
          const stacks = [...composition.entries()].map(([unitId, count]: any) => ({
            unitId,
            count,
            stats: state.getUnitStatsWithResearch(unitId, researchIds)!,
            formation: formations.get(unitId),
          })).filter((s: any) => s.stats);
          const enemy = state.getEnemyStacks(battleId);
          return state.simulateWithStacksOutcome(stacks, enemy) === "player";
        },
        winsWithFormationsAndOrders: (composition: any, formations: any, orders: any, battleId: string) => {
          const stacks = [...composition.entries()].map(([unitId, count]: any) => ({
            unitId,
            count,
            stats: state.getUnitStatsWithResearch(unitId, researchIds)!,
            formation: formations.get(unitId),
            order: orders.get(unitId),
          })).filter((s: any) => s.stats);
          const enemy = state.getEnemyStacks(battleId);
          return state.simulateWithStacksOutcome(stacks, enemy) === "player";
        },
      };

      const opt = optimizeBattleTactics(battle.key, candidates, context, true, ownedArmy);
      console.log("Optimizer result composition:", opt?.composition);
      console.log("Optimizer result formations:", opt?.formations);
      console.log("Optimizer result orders:", opt?.orders);

      if (opt) {
        const stateWithOpt = state.applyFormationSnapshot(
          Object.fromEntries(opt.orders),
          Object.fromEntries(opt.formations),
        );
        const encSimOpt = stateWithOpt.simulateEncounter(battle.key);
        expect(encSimOpt?.outcome).toBe("player");
      }
    }
  });
});
