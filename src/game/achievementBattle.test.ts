import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "./attributes";
import type { BattleSimulation } from "./battle";
import { CivilizationState } from "./civilizationState";
import { ExpNumber } from "./expNumber";
import { emptyStatistics } from "./statistics";
import { unitStatKeys } from "./units";

const achievementId = "a-good-legal-cheat-for-battle";
const firstBattle = "age0_1_first_fire";
const secondBattle = "age0_2_wolf_pack";

const armyState = (
  unitCounts: Record<string, number>,
  defeatedEncounters: readonly string[] = [firstBattle],
): CivilizationState =>
  new CivilizationState(
    emptyResourceAmounts(),
    emptyWorkerAssignments(),
    { "town-hall": 1 },
    emptyResourceFactors(),
    {},
    0,
    [],
    defeatedEncounters,
    [],
    [],
    emptyStatistics(),
    Object.fromEntries(
      Object.entries(unitCounts).map(([unitId, count]) => [
        unitId,
        ExpNumber.fromNumber(count),
      ]),
    ),
  );

const playerVictory = (
  state: CivilizationState,
  encounterId: string,
): BattleSimulation => {
  const simulation = state.simulateEncounter(encounterId);
  expect(simulation?.outcome).toBe("player");
  if (!simulation || simulation.outcome !== "player") {
    throw new Error(`Expected a player victory in ${encounterId}`);
  }
  return simulation;
};

const win = (state: CivilizationState, encounterId: string): CivilizationState =>
  state.resolveBattle(encounterId, playerVictory(state, encounterId));

const numericStat = (value: number | ExpNumber): number =>
  typeof value === "number" ? value : value.toNumber();

const survivingPlayerUnitIds = (
  simulation: BattleSimulation,
): readonly string[] => {
  const finalRound = simulation.rounds[simulation.rounds.length - 1];
  return (finalRound?.player ?? [])
    .filter(({ count }) => count.gt(ExpNumber.ZERO))
    .map(({ unitId }) => unitId);
};

describe("battle-shape achievements", () => {
  it("does not earn the second-battle record for a first-battle victory", () => {
    const state = armyState({ canoe: 1_000_000 }, []);

    expect(win(state, firstBattle).isAchievementEarned(achievementId)).toBe(
      false,
    );
  });

  it("allows opening ground units to be eliminated before victory", () => {
    const state = armyState({ canoe: 1_000_000, warrior: 1 });
    const simulation = playerVictory(state, secondBattle);

    expect(survivingPlayerUnitIds(simulation)).toEqual(["canoe"]);
    expect(
      state.resolveBattle(secondBattle, simulation).isAchievementEarned(
        achievementId,
      ),
    ).toBe(true);
  });

  it("rejects a second-battle victory with any ground unit still alive", () => {
    const state = armyState({ canoe: 1, warrior: 1_000_000 });
    const simulation = playerVictory(state, secondBattle);

    expect(survivingPlayerUnitIds(simulation)).toContain("warrior");
    expect(
      state.resolveBattle(secondBattle, simulation).isAchievementEarned(
        achievementId,
      ),
    ).toBe(false);
  });

  it("earns on an all-naval second victory and boosts every naval stat by 10%", () => {
    const state = armyState({ canoe: 1_000_000 });
    const before = state.getUnitStats("canoe");
    const won = win(state, secondBattle);
    const after = won.getUnitStats("canoe");

    expect(won.isAchievementEarned(achievementId)).toBe(true);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (!before || !after) throw new Error("Missing Dugout Canoe stats");
    for (const stat of unitStatKeys) {
      expect(numericStat(after[stat])).toBeCloseTo(
        numericStat(before[stat]) * 1.1,
        10,
      );
    }
  });
});
