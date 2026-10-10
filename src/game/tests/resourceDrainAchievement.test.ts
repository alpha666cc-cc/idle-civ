import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  type ResourceKey,
} from "../attributes";
import { CivilizationState } from "../civilizationState";
import { ExpNumber } from "../expNumber";
import { emptyStatistics } from "../statistics";

/**
 * A settlement at `population` citizens. `people` carries a real food drain, so
 * these states starve on their own: with no workers and no farms the food rate is
 * exactly −population.
 */
const starving = (population: number, food: number = 0): CivilizationState =>
  new CivilizationState(
    { ...emptyResourceAmounts(), food: ExpNumber.fromNumber(food) },
    emptyWorkerAssignments(),
    { townHall: 1, house: 200, people: population },
    emptyResourceFactors(),
    {},
    0,
    [],
    [],
    [],
    [],
    emptyStatistics(),
    {},
  );

describe("the famine achievement", () => {
  it("starts unearned on a healthy settlement", () => {
    const state = starving(0, 5_000);
    expect(state.isAchievementEarned("famine")).toBe(false);
    expect(state.checkAchievements().isAchievementEarned("famine")).toBe(false);
  });

  it("fires at 0 food, negative production, and 1001+ citizens", () => {
    const state = starving(1001);
    expect(state.computeResourceRate("food").lt(ExpNumber.ZERO)).toBe(true);
    const earned = state.checkAchievements();
    expect(earned.isAchievementEarned("famine")).toBe(true);
  });

  it("needs 1001 citizens, not 1000", () => {
    expect(
      starving(1000).checkAchievements().isAchievementEarned("famine"),
    ).toBe(false);
    expect(
      starving(1001).checkAchievements().isAchievementEarned("famine"),
    ).toBe(true);
  });

  it("does not fire while the settlement is still eating", () => {
    // Food empty but production positive: an empty larder, not a famine.
    const state = starving(1001).addFactor("food" as ResourceKey, "additional", [
      "farm",
      ExpNumber.fromNumber(5_000),
    ]);
    expect(state.computeResourceRate("food").gt(ExpNumber.ZERO)).toBe(true);
    expect(state.checkAchievements().isAchievementEarned("famine")).toBe(false);
  });

  it("does not fire on a full larder while starving slowly", () => {
    const state = starving(1001, 1_000);
    expect(state.checkAchievements().isAchievementEarned("famine")).toBe(false);
  });

  it("is a one-time record: it is never appended twice", () => {
    const earned = starving(1001).checkAchievements();
    expect(
      earned.earnedAchievements.filter((id) => id === "famine"),
    ).toHaveLength(1);
    // Re-checking must not append a second entry.
    expect(
      earned.checkAchievements().earnedAchievements.filter(
        (id) => id === "famine",
      ),
    ).toHaveLength(1);
  });

  it("stays earned after the famine ends", () => {
    const earned = starving(1001).checkAchievements();
    expect(earned.isAchievementEarned("famine")).toBe(true);
    const later = new CivilizationState(
      { ...emptyResourceAmounts(), food: ExpNumber.fromNumber(500) },
      emptyWorkerAssignments(),
      { townHall: 1, house: 200, people: 1001 },
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      [],
      earned.earnedAchievements,
      emptyStatistics(),
      {},
    );
    const after = later.checkAchievements();
    expect(after.isAchievementEarned("famine")).toBe(true);
    expect(
      after.earnedAchievements.filter((id) => id === "famine"),
    ).toHaveLength(1);
  });
});

describe("the famine reward", () => {
  /** The citizen food upkeep, as a plain number. */
  const upkeep = (state: CivilizationState): number =>
    state.getFactors("food").drain.reduce(
      (total, [, value]) => total + value.toNumber(),
      0,
    );

  it("costs food while the famine is unearned", () => {
    const state = starving(100);
    expect(upkeep(state)).toBe(100);
    expect(state.computeResourceRate("food").toNumber()).toBe(-100);
  });

  it("removes the citizen food upkeep once famine is earned", () => {
    const earned = starving(1001).checkAchievements();
    expect(earned.isAchievementEarned("famine")).toBe(true);
    expect(upkeep(earned)).toBe(0);
    // With upkeep gone and no workers, food stops falling.
    expect(earned.computeResourceRate("food").toNumber()).toBe(0);
  });

  it("only cancels food, leaving other resources' drains alone", () => {
    const earned = starving(1001).checkAchievements();
    const woodDrain = earned
      .addFactor("wood" as ResourceKey, "drain", [
        "upkeep",
        ExpNumber.fromNumber(7),
      ])
      .getFactors("wood")
      .drain.reduce((total, [, value]) => total + value.toNumber(), 0);
    expect(woodDrain).toBe(7);
  });

  it("keeps the famine unreachable once its own reward is active", () => {
    // The reward removes the very drain the requirement needs, so a settlement
    // that already earned it can never re-enter the famine state.
    const earned = starving(1001).checkAchievements();
    expect(earned.computeResourceRate("food").lt(ExpNumber.ZERO)).toBe(false);
  });
});
