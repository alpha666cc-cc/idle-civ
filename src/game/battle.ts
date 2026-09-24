import { ExpNumber } from "./expNumber";
import {
  findUnitDefinition,
  unitPower,
  type UnitDomain,
  type UnitStats,
} from "./units";

/**
 * The battle model (AGENTS.md §14, roadmap Milestone 8).
 *
 * A round is one second of playback: every stack that can reach an enemy fires
 * once, in speed order, and then the lines close. Casualties are tracked as an
 * aggregate hit point pool per stack — never one object per unit — so a stack of
 * a million spearmen costs exactly as much to simulate as a stack of one, and a
 * battle always finishes in bounded time.
 *
 * The simulation is pure and seeded: the same armies produce the same battle, so
 * results are reproducible, testable, and cheap to replay in the UI. Casualties
 * are never written back to the save (armies are restored after a fight).
 */

/** One unit type in an army, with the stats it actually fights with. */
export type ArmyStack = {
  readonly unitId: string;
  readonly count: ExpNumber;
  readonly stats: UnitStats;
};

export type BattleSide = "player" | "enemy";

export type StackSnapshot = {
  readonly unitId: string;
  /** Units still standing, rounded up so a wounded unit is still a unit. */
  readonly count: ExpNumber;
  readonly hpPool: ExpNumber;
};

export type BattleRound = {
  readonly round: number;
  /** Closing distance at the start of the round; range gates who may fire. */
  readonly distance: number;
  readonly player: readonly StackSnapshot[];
  readonly enemy: readonly StackSnapshot[];
};

export type BattleOutcome = "player" | "enemy" | "stalemate";

export type BattleSimulation = {
  readonly seed: number;
  readonly rounds: readonly BattleRound[];
  readonly outcome: BattleOutcome;
  readonly playerSurvivors: ExpNumber;
  readonly enemySurvivors: ExpNumber;
};

/** Armies deploy this far apart; the lines close a little every round. */
export const initialDistance = 20;
/** A battle that has not resolved by then is a stalemate (counted as a loss). */
export const maximumRounds = 200;
/** Bonus damage against a tagged target (`bonusVs`), as in the prototype. */
const bonusVsMultiplier = 1.5;

type Fighter = {
  readonly unitId: string;
  readonly side: BattleSide;
  readonly stats: UnitStats;
  readonly domain: UnitDomain;
  readonly canHit: readonly UnitDomain[];
  readonly bonusVs: readonly string[];
  readonly tags: readonly string[];
  /** Effective hit points of one full-health unit. */
  readonly hitPoints: ExpNumber;
  readonly initialCount: ExpNumber;
  /** Remaining effective hit points of the whole stack. */
  hpPool: ExpNumber;
};

/** mulberry32: tiny, fast, and seedable, so a battle can be replayed exactly. */
const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const livingCount = (fighter: Fighter): ExpNumber => {
  if (fighter.hpPool.lte(ExpNumber.ZERO)) return ExpNumber.ZERO;
  return ExpNumber.min(
    fighter.initialCount,
    fighter.hpPool.div(fighter.hitPoints).ceil(),
  );
};

const buildFighters = (
  stacks: readonly ArmyStack[],
  side: BattleSide,
): Fighter[] =>
  stacks.flatMap((stack) => {
    const definition = findUnitDefinition(stack.unitId);
    if (!definition || stack.count.lte(ExpNumber.ZERO)) return [];
    const hitPoints = stack.stats.hp.div(
      ExpNumber.ONE.sub(ExpNumber.fromNumber(Math.min(stack.stats.armor, 0.9))),
    );
    return [
      {
        unitId: stack.unitId,
        side,
        stats: stack.stats,
        domain: definition.domain,
        canHit: definition.canHit,
        bonusVs: definition.bonusVs,
        tags: definition.tags,
        hitPoints,
        initialCount: stack.count,
        hpPool: hitPoints.mul(stack.count),
      },
    ];
  });

/** Range and domain rules: who is allowed to shoot whom, and from how far. */
const canReach = (
  attacker: Fighter,
  target: Fighter,
  distance: number,
): boolean => {
  if (!attacker.canHit.includes(target.domain)) return false;
  if (distance > attacker.stats.range) return false;
  if (target.domain === "air" && attacker.stats.range <= 1) return false;
  // Ground melee units cannot hit naval units unless they have sufficient range
  if (
    attacker.domain === "ground" &&
    target.domain === "naval" &&
    attacker.stats.range <= 3
  )
    return false;
  return true;
};

/** Contextual damage multipliers, kept identical to the prototype's rules. */
const matchupMultiplier = (attacker: Fighter, target: Fighter): number => {
  let multiplier = 1;
  if (attacker.bonusVs.some((tag) => target.tags.includes(tag))) {
    multiplier *= bonusVsMultiplier;
  }
  if (attacker.domain === "air" && target.domain === "naval") multiplier *= 1.2;
  if (attacker.domain === "naval" && target.domain === "ground") {
    multiplier *= attacker.stats.range / 10;
  }
  if (target.domain === "air" && attacker.stats.range <= 1) multiplier *= 0.3;
  return multiplier;
};

/** Army power (AGENTS.md §14): the sum of every stack's count × unit power. */
export const armyPower = (stacks: readonly ArmyStack[]): ExpNumber =>
  stacks.reduce(
    (total, stack) => total.add(unitPower(stack.stats).mul(stack.count)),
    ExpNumber.ZERO,
  );

const armySignature = (
  side: BattleSide,
  stacks: readonly ArmyStack[],
): string =>
  stacks
    .map(
      (stack) =>
        `${side}:${stack.unitId}:${stack.count.toString()}:${stack.stats.hp.toString()}:${stack.stats.attack.toString()}`,
    )
    .join("|");

/**
 * Seed for a battle: a fingerprint of both armies. Buying different units is a
 * different battle; replaying the same armies is the same battle.
 */
export const battleSeed = (
  player: readonly ArmyStack[],
  enemy: readonly ArmyStack[],
  battleId = "",
): number => {
  const armies = `${armySignature("player", player)}||${armySignature(
    "enemy",
    enemy,
  )}`;
  const signature = battleId ? `${battleId}||${armies}` : armies;
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const snapshot = (fighters: readonly Fighter[]): StackSnapshot[] =>
  fighters.map((fighter) => ({
    unitId: fighter.unitId,
    count: livingCount(fighter),
    hpPool: fighter.hpPool,
  }));

const totalLiving = (fighters: readonly Fighter[]): ExpNumber =>
  fighters.reduce(
    (total, fighter) => total.add(livingCount(fighter)),
    ExpNumber.ZERO,
  );

/**
 * Runs one battle and returns the whole round log (the UI plays it back one round
 * per second). Accuracy is applied as expected damage — `count × attack × hit
 * chance` — rather than as a single coin flip for the stack, so a large stack
 * behaves like the many units it represents. Nothing here touches game state.
 */
export const simulateBattle = (
  playerStacks: readonly ArmyStack[],
  enemyStacks: readonly ArmyStack[],
  {
    seed = battleSeed(playerStacks, enemyStacks),
    maxRounds = maximumRounds,
  }: { seed?: number; maxRounds?: number } = {},
): BattleSimulation => {
  const random = createRandom(seed);
  const player = buildFighters(playerStacks, "player");
  const enemy = buildFighters(enemyStacks, "enemy");
  // Speed decides who fires first; equal speeds keep deployment order.
  const order = [...player, ...enemy].sort(
    (a, b) => b.stats.speed - a.stats.speed,
  );

  const rounds: BattleRound[] = [
    {
      round: 0,
      distance: initialDistance,
      player: snapshot(player),
      enemy: snapshot(enemy),
    },
  ];

  let distance = initialDistance;
  let round = 0;
  while (
    round < maxRounds &&
    totalLiving(player).gt(ExpNumber.ZERO) &&
    totalLiving(enemy).gt(ExpNumber.ZERO)
  ) {
    round += 1;

    for (const attacker of order) {
      const attackers = livingCount(attacker);
      if (attackers.lte(ExpNumber.ZERO)) continue;
      const foes = (attacker.side === "player" ? enemy : player).filter(
        (fighter) =>
          livingCount(fighter).gt(ExpNumber.ZERO) &&
          canReach(attacker, fighter, distance),
      );
      if (foes.length === 0) continue;
      // Fire at the weakest stack: finishing units off ends the fight sooner and
      // keeps the log readable.
      const target = foes.reduce(
        (weakest, fighter) =>
          fighter.hpPool.lt(weakest.hpPool) ? fighter : weakest,
        foes[0],
      );
      const hitChance = Math.max(
        0.05,
        Math.min(
          1,
          attacker.stats.accuracy *
            (1 - Math.min(1, distance / attacker.stats.range) * 0.3),
        ),
      );
      const variance = 0.8 + random() * 0.4;
      const damage = attackers
        .mul(attacker.stats.attack)
        .mul(
          ExpNumber.fromNumber(
            hitChance * variance * matchupMultiplier(attacker, target),
          ),
        );
      target.hpPool = ExpNumber.max(ExpNumber.ZERO, target.hpPool.sub(damage));
    }

    const fastest = order.reduce(
      (speed, fighter) =>
        livingCount(fighter).gt(ExpNumber.ZERO)
          ? Math.max(speed, fighter.stats.speed)
          : speed,
      0,
    );
    distance = Math.max(1, distance - Math.max(1, Math.floor(fastest / 2)));
    rounds.push({
      round,
      distance,
      player: snapshot(player),
      enemy: snapshot(enemy),
    });
  }

  const playerSurvivors = totalLiving(player);
  const enemySurvivors = totalLiving(enemy);
  const playerHolds = playerSurvivors.gt(ExpNumber.ZERO);
  const enemyHolds = enemySurvivors.gt(ExpNumber.ZERO);
  const outcome: BattleOutcome =
    enemyHolds && !playerHolds
      ? "enemy"
      : playerHolds && !enemyHolds
        ? "player"
        : "stalemate";

  return { seed, rounds, outcome, playerSurvivors, enemySurvivors };
};
