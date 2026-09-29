/**
 * Age-0 campaign balance gates (roadmap Milestone 8).
 *
 * Battles are deterministic: damage has no random component, so every assertion
 * here is a golden value rather than a statistical one. The three tuned numbers
 * are the wolf's attack (12, down from 15 — eight Tribesmen now hold the fire),
 * the canoe's range (2, so a hull is a real but expensive answer) and the
 * slinger's `canHit` list (naval, so thrown stones reach a hull). Each gate
 * states the balance intent it protects, so a future retune fails loudly here
 * instead of quietly in the campaign.
 */
import { describe, expect, it } from "vitest";
import { simulateBattle, simulateBattleOutcome } from "./battle";
import { CivilizationState } from "./civilizationState";
import { findUnitDefinition } from "./units";
import { ExpNumber } from "./expNumber";

type Army = readonly (readonly [string, number])[];

const firstFire = "age0_1_first_fire";
const wolfPack = "age0_2_wolf_pack";
const bronzeRaid = "age0_3_bronze_raid";
const troy = "age0_boss_troy";

const state = new CivilizationState();

/** The army the campaign would field: current stats, no battle boosts. */
const player = (list: Army) =>
  list.map(([unitId, count]) => {
    const stats = state.getUnitStats(unitId);
    if (!stats) throw new Error(`Unknown unit: ${unitId}`);
    return { unitId, count: ExpNumber.fromNumber(count), stats };
  });

const fight = (battleId: string, list: Army, seed = 1) =>
  simulateBattleOutcome(player(list), state.getEnemyStacks(battleId), { seed });

/** Military-only spend, the metric `battleSimulator` ranks candidate armies by. */
const military = (list: Army): number =>
  list.reduce(
    (total, [unitId, count]) =>
      total +
      state
        .getUnitCost(unitId, count)
        .filter((cost) => cost.resource === "military")
        .reduce((sum, cost) => sum.add(cost.base), ExpNumber.ZERO)
        .toNumber(),
    0,
  );

describe("battle determinism", () => {
  it("resolves the same fight whatever the seed says", () => {
    const army = player([["warrior", 8]]);
    const wolves = state.getEnemyStacks(firstFire);
    const first = simulateBattle(army, wolves, { seed: 1 });
    const second = simulateBattle(army, wolves, { seed: 987654321 });

    expect(second.outcome).toBe(first.outcome);
    expect(second.rounds.length).toBe(first.rounds.length);
    expect(second.rounds.at(-1)).toEqual(first.rounds.at(-1));
  });
});

describe("First Fire: eight Tribesmen hold the fire", () => {
  it("is won by eight warriors", () => {
    expect(fight(firstFire, [["warrior", 8]])).toBe("player");
  });

  it("is not won by seven", () => {
    expect(fight(firstFire, [["warrior", 7]])).not.toBe("player");
  });

  it("is not won by six", () => {
    expect(fight(firstFire, [["warrior", 6]])).not.toBe("player");
  });

  it("keeps the wolf at the attack the gate was tuned against", () => {
    const wolf = findUnitDefinition("wolf");
    expect(wolf?.stats.attack.toNumber()).toBe(12);
  });
});

describe("Wolf Pack: a mixed army is the cheapest answer", () => {
  const mixed: Army = [
    ["warrior", 9],
    ["slinger", 26],
  ];

  it("is won by warriors and slingers together", () => {
    expect(fight(wolfPack, mixed)).toBe("player");
  });

  it("is won by a fleet of hulls, so the naval branch is a real answer", () => {
    expect(fight(wolfPack, [["canoe", 8]])).toBe("player");
  });

  it("needs eight hulls, not seven", () => {
    expect(fight(wolfPack, [["canoe", 7]])).not.toBe("player");
  });

  it("costs less mixed than afloat, so canoes stay the expensive option", () => {
    expect(military(mixed)).toBeLessThan(military([["canoe", 8]]));
    // A comfortable fleet win is well clear of the mixed army: 10 hulls, round ~161.
    expect(military([["canoe", 10]])).toBeGreaterThan(military(mixed) * 2);
  });

  it("makes hulls the cheap marginal buy once an army is already held", () => {
    // 8 hulls (4.8e5) undercut the 18 slingers (6.5e5) that finish the stack.
    expect(military([["canoe", 8]])).toBeLessThan(
      military([["slinger", 30]]) - military([["slinger", 12]]),
    );
    expect(
      fight(wolfPack, [
        ["warrior", 15],
        ["slinger", 12],
        ["canoe", 8],
      ]),
    ).toBe("player");
  });
});

describe("Bronze Raid and Troy: slingers reach a hull", () => {
  it("gives the slinger the naval domain in its data", () => {
    const slinger = findUnitDefinition("slinger");
    expect(slinger?.canHit).toContain("naval");
    expect(slinger?.stats.range).toBeGreaterThan(3);
  });

  it("lets a ground unit with reach damage a naval stack", () => {
    const trireme = state.getUnitStats("trireme_bronze");
    if (!trireme) throw new Error("The trireme definition is missing.");
    const battle = simulateBattle(
      player([["slinger", 50]]),
      [{ unitId: "trireme_bronze", count: ExpNumber.fromNumber(10), stats: trireme }],
      { seed: 1 },
    );
    const opening = battle.rounds[0].enemy[0]?.hpPool;
    const closing = battle.rounds.at(-1)?.enemy[0]?.hpPool;
    expect(opening?.gt(ExpNumber.ZERO)).toBe(true);
    expect(closing?.lt(opening ?? ExpNumber.ZERO)).toBe(true);
  });

  it("leaves the raid winnable and the boss unbeaten by the reference field", () => {
    expect(
      fight(bronzeRaid, [
        ["spearman_bronze", 150],
        ["bowman_bronze", 80],
      ]),
    ).toBe("player");
    expect(
      fight(bronzeRaid, [
        ["axeman_bronze", 40],
        ["bowman_bronze", 30],
      ]),
    ).toBe("enemy");
    expect(
      fight(troy, [
        ["spearman_bronze", 300],
        ["bowman_bronze", 200],
      ]),
    ).toBe("enemy");
  });
});
