import { describe, expect, it } from "vitest";
import { simulateBattle, type ArmyStack } from "../battle";
import { ExpNumber } from "../expNumber";
import { findUnitDefinition } from "../units";

const stack = (
  unitId: string,
  count: number,
  formation?: "standard" | "frontline" | "rush" | "backline",
): ArmyStack => {
  const definition = findUnitDefinition(unitId);
  if (!definition) throw new Error(`Missing unit definition: ${unitId}`);
  return {
    unitId,
    count: ExpNumber.fromNumber(count),
    stats: definition.stats,
    ...(formation ? { formation } : {}),
  };
};

/** `position ± attackAdvance` is where a stack actually struck from. */
const strikeDistance = (attack: {
  attackerPosition: number;
  attackAdvance: number;
  targetPosition: number;
  attackerSide: "player" | "enemy";
}): number =>
  Math.abs(
    attack.attackerPosition +
      (attack.attackerSide === "player"
        ? attack.attackAdvance
        : -attack.attackAdvance) -
      attack.targetPosition,
  );

describe("battle contact latching and engaged advance ladder", () => {
  it("lets a slower stack strike the next line after a faster stack kills the front", () => {
    const battle = simulateBattle(
      [
        {
          ...stack("companion", 1, "frontline"),
          stats: {
            ...stack("companion", 1, "frontline").stats,
            attack: ExpNumber.fromNumber(1_000),
            range: 1,
            speed: 8,
          },
        },
        {
          ...stack("warrior", 1, "rush"),
          stats: {
            ...stack("warrior", 1, "rush").stats,
            attack: ExpNumber.ONE,
            range: 3,
            speed: 1,
          },
        },
      ],
      [
        {
          ...stack("wolf", 1, "frontline"),
          stats: {
            ...stack("wolf", 1, "frontline").stats,
            attack: ExpNumber.ZERO,
            hp: ExpNumber.ONE,
            range: 1,
            speed: 1,
          },
        },
        {
          ...stack("slinger", 1, "rush"),
          stats: {
            ...stack("slinger", 1, "rush").stats,
            attack: ExpNumber.ZERO,
            hp: ExpNumber.fromNumber(1_000),
            range: 1,
            speed: 1,
          },
        },
      ],
      { maxRounds: 3 },
    );

    const contactRound = battle.rounds.find((round) =>
      round.attacks.some(
        (attack) =>
          attack.attackerId === "companion" && attack.targetId === "wolf",
      ),
    );
    expect(contactRound).toBeDefined();
    const killingAttackIndex =
      contactRound?.attacks.findIndex(
        (attack) =>
          attack.attackerId === "companion" && attack.targetId === "wolf",
      ) ?? -1;
    const nextLineAttackIndex =
      contactRound?.attacks.findIndex(
        (attack) =>
          attack.attackerId === "warrior" && attack.targetId === "slinger",
      ) ?? -1;
    expect(killingAttackIndex).toBeGreaterThanOrEqual(0);
    expect(nextLineAttackIndex).toBeGreaterThan(killingAttackIndex);
    expect(
      contactRound?.attacks[nextLineAttackIndex]?.reachableTargets,
    ).toContain("slinger");
    expect(
      contactRound?.attacks[nextLineAttackIndex]?.attackAdvance,
    ).toBe(1);
  });

  it("advances behind the front even when range already reaches a target", () => {
    const warrior = stack("warrior", 1);
    const battle = simulateBattle(
      [
        {
          ...stack("companion", 1, "frontline"),
          stats: {
            ...stack("companion", 1, "frontline").stats,
            attack: ExpNumber.fromNumber(1_000),
            range: 1,
            speed: 8,
          },
        },
        {
          ...warrior,
          stats: { ...warrior.stats, range: 4, speed: 1 },
        },
      ],
      [
        {
          ...stack("wolf", 1, "frontline"),
          stats: {
            ...stack("wolf", 1, "frontline").stats,
            attack: ExpNumber.ZERO,
            hp: ExpNumber.ONE,
            range: 1,
            speed: 1,
          },
        },
        {
          ...stack("slinger", 1, "rush"),
          stats: {
            ...stack("slinger", 1, "rush").stats,
            attack: ExpNumber.ZERO,
            hp: ExpNumber.fromNumber(1_000),
            range: 1,
            speed: 1,
          },
        },
      ],
      { maxRounds: 3 },
    );

    const attack = battle.rounds
      .flatMap((round) => round.attacks)
      .find(
        (candidate) =>
          candidate.attackerId === "warrior" &&
          candidate.targetId === "slinger",
      );
    expect(attack).toBeDefined();
    if (!attack) return;
    expect(attack.attackAdvance).toBe(1);
    expect(
      Math.abs(attack.attackerPosition - attack.targetPosition),
    ).toBeLessThanOrEqual(4);
  });

  /**
   * A backline unit behind its own living front joins one ring per engaged
   * round: no attack while out of reach, first strike on the rung that closes
   * the distance — arrival pacing, not instant teleport. The hoplite's range 2
   * makes first contact land at front gap 1, so the backline legionary (offset
   * 2 behind its own front) sits 3 away and needs exactly two rungs.
   */
  it("walks a backline unit in one rung per engaged round", () => {
    const battle = simulateBattle(
      [stack("legionary", 1_000_000, "backline"), stack("warrior", 1_000_000)],
      [stack("hoplite", 5_000)],
      { maxRounds: 6 },
    );

    const legionaryAttacks = battle.rounds.flatMap((round) =>
      round.attacks
        .filter((attack) => attack.attackerId === "legionary")
        .map((attack) => ({ round, attack })),
    );
    expect(legionaryAttacks.length).toBeGreaterThan(0);

    // Rung 1 (advance 1 → strike at distance 2) still falls short of range 1.
    expect(
      battle.rounds[1].attacks.some(
        (attack) => attack.attackerId === "legionary",
      ),
    ).toBe(false);
    // Rung 2 (advance 2 → strike at distance 1) reaches: first strike round 2.
    expect(legionaryAttacks[0].round.round).toBe(2);
    expect(legionaryAttacks[0].attack.attackAdvance).toBe(2);
  });

  /**
   * The only legitimate no-target case: the enemy has not arrived. The melee
   * stack lands no phantom hits during the approach rounds and strikes on the
   * first engaged round, exactly one rung deep.
   */
  it("waits while the enemy has not arrived, then strikes on first contact", () => {
    const battle = simulateBattle(
      [stack("hoplite", 100_000)],
      [stack("archer_classical", 2_000, "backline")],
      { maxRounds: 6 },
    );

    const playerHopliteAttacks = battle.rounds.filter((round) =>
      round.attacks.some(
        (attack) =>
          attack.attackerSide === "player" && attack.attackerId === "hoplite",
      ),
    );
    expect(playerHopliteAttacks.length).toBeGreaterThan(0);

    // Rounds 1-2 close the gap but stay out of melee reach: no phantom hits.
    for (const round of battle.rounds.filter(
      (r) => r.round >= 1 && r.round <= 2,
    )) {
      expect(
        round.attacks.some(
          (attack) =>
            attack.attackerSide === "player" && attack.attackerId === "hoplite",
        ),
      ).toBe(false);
    }
    // First strike lands on the first engaged round (round 3). This stack was
    // already at the front, so it does not need an advance step.
    const first = playerHopliteAttacks[0].attacks.find(
      (attack) => attack.attackerId === "hoplite",
    );
    expect(first).toBeDefined();
    if (!first) return;
    expect(playerHopliteAttacks[0].round).toBe(3);
    expect(first.attackAdvance).toBe(0);
    expect(strikeDistance(first)).toBeLessThanOrEqual(2);
  });

  /**
   * The engine is deterministic: identical armies produce identical
   * simulations, and every logged attack respects its range once the banked
   * advance is counted.
   */
  it("is deterministic and never strikes beyond effective reach", () => {
    const player = [
      stack("warrior", 1),
      stack("hoplite", 100_000, "backline"),
      stack("legionary", 50_000),
    ];
    const enemy = [
      stack("archer_classical", 10_000),
      stack("hoplite", 100_000),
    ];
    const options = { maxRounds: 12 };
    const first = simulateBattle(player, enemy, options);
    const second = simulateBattle(player, enemy, options);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    for (const round of first.rounds) {
      for (const attack of round.attacks) {
        const range =
          findUnitDefinition(attack.attackerId)?.stats.range ?? Number.NaN;
        expect(strikeDistance(attack)).toBeLessThanOrEqual(range);
      }
    }
  });
});
