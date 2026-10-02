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
 * The simulation is pure and deterministic: damage has no random component, so
 * the same armies always produce the same battle, however many times it is
 * replayed. Results are reproducible, testable and cheap to replay in the UI.
 * Casualties are never written back to the save (armies are restored after a
 * fight).
 */

/** One unit type in an army, with the stats it actually fights with. */
export type ArmyStack = {
  readonly unitId: string;
  readonly count: ExpNumber;
  readonly stats: UnitStats;
  /** How this stack picks its target and screens its allies; `standard` if unset. */
  readonly order?: BattleOrder;
};

/**
 * Battle orders (the "Classical discovery", Age 2).
 *
 * An order is per unit type, not per stack instance — the player has one army and
 * `getArmyStacks()` emits a single stack per unit type, so an order always
 * describes the whole of that type. Orders change only *targeting* and *screening*;
 * they never touch the damage, range or speed rules, so an order can move the
 * cost of a battle but not invalidate a unit's own stats.
 *
 * `standard` is the pre-order behaviour (fire at the weakest stack you can
 * reach). The rest are tactical choices the player unlocks with the classical
 * ages: hold a line, screen the shooters, or concentrate fire differently.
 */
export type BattleOrder =
  | "standard"
  | "frontline"
  | "backline"
  | "focus_weak"
  | "focus_strong"
  | "focus_counter"
  | "same_tag"
  | "protect_ranged";

export const standardOrder: BattleOrder = "standard";

/** Every order, in unlock order; used to validate a loaded save. */
export const battleOrders: readonly BattleOrder[] = [
  "standard",
  "frontline",
  "backline",
  "focus_counter",
  "focus_weak",
  "focus_strong",
  "same_tag",
  "protect_ranged",
];

/** Which orders the player has discovered by the time they reach an age. */
export const orderUnlocks: Record<number, readonly BattleOrder[]> = {
  0: ["standard"],
  1: ["standard"],
  2: [
    "standard",
    "frontline",
    "backline",
    "focus_counter",
    "focus_weak",
    "focus_strong",
  ],
  3: [
    "standard",
    "frontline",
    "backline",
    "focus_counter",
    "focus_weak",
    "focus_strong",
    "same_tag",
    "protect_ranged",
  ],
  4: [
    "standard",
    "frontline",
    "backline",
    "focus_counter",
    "focus_weak",
    "focus_strong",
    "same_tag",
    "protect_ranged",
  ],
  5: [
    "standard",
    "frontline",
    "backline",
    "focus_counter",
    "focus_weak",
    "focus_strong",
    "same_tag",
    "protect_ranged",
  ],
  6: [
    "standard",
    "frontline",
    "backline",
    "focus_counter",
    "focus_weak",
    "focus_strong",
    "same_tag",
    "protect_ranged",
  ],
  7: [
    "standard",
    "frontline",
    "backline",
    "focus_counter",
    "focus_weak",
    "focus_strong",
    "same_tag",
    "protect_ranged",
  ],
};

export const battleOrderLabels: Record<BattleOrder, string> = {
  standard: "Standard",
  frontline: "Hold the line",
  backline: "Keep to the rear",
  focus_weak: "Finish the weakest",
  focus_strong: "Break the strongest",
  focus_counter: "Hunt the armoured",
  same_tag: "Match their kind",
  protect_ranged: "Guard the shooters",
};

export const battleOrderHints: Record<BattleOrder, string> = {
  standard: "Fire at the weakest stack you can reach.",
  frontline: "Engage the nearest melee line, and screen what is behind it.",
  backline: "Stand off and screen yourself from the enemy line.",
  focus_weak: "Concentrate on the smallest remaining stack.",
  focus_strong: "Concentrate on the largest remaining stack.",
  focus_counter:
    "Prefer the enemy your unit counters; fall back if it has none.",
  same_tag: "Pick a foe of your own kind, or the first you can reach.",
  protect_ranged: "Body-guard the ranged line, absorbing fire for it.",
};

/** Orders a player of this age may issue; never empty, always includes standard. */
export const ordersForAge = (ageIndex: number): readonly BattleOrder[] =>
  orderUnlocks[Math.max(0, Math.min(7, ageIndex))] ?? orderUnlocks[0];

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
  /** The order this stack was told to fight under. */
  readonly order: BattleOrder;
  /** Hit points the stack started with, so screening can read its health. */
  readonly initialHpPool: ExpNumber;
};

const livingCount = (fighter: Fighter): ExpNumber => {
  if (fighter.hpPool.lte(ExpNumber.ZERO)) return ExpNumber.ZERO;
  return ExpNumber.min(
    fighter.initialCount,
    fighter.hpPool.div(fighter.hitPoints).ceil(),
  );
};

/**
 * One fighter per stack, in a canonical (unit id) order. The order is fixed so
 * that the same set of units always produces the same battle, however the caller
 * happened to assemble the stack list — see `armySignature` for why.
 */
const buildFighters = (
  stacks: readonly ArmyStack[],
  side: BattleSide,
): Fighter[] =>
  [...stacks]
    .sort((left, right) => left.unitId.localeCompare(right.unitId))
    .flatMap((stack) => {
      const definition = findUnitDefinition(stack.unitId);
      if (!definition || stack.count.lte(ExpNumber.ZERO)) return [];
      const hitPoints = stack.stats.hp.div(
        ExpNumber.ONE.sub(
          ExpNumber.fromNumber(Math.min(stack.stats.armor, 0.9)),
        ),
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
          initialHpPool: hitPoints.mul(stack.count),
          order: stack.order ?? standardOrder,
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

/** Lowest remaining hit points first — the classic "finish what is nearly dead". */
const weakestFirst = (foes: readonly Fighter[]): Fighter =>
  foes.reduce(
    (weakest, foe) => (foe.hpPool.lt(weakest.hpPool) ? foe : weakest),
    foes[0],
  );

/** The foes this unit's `bonusVs` tags actually counter, if any are reachable. */
const counterTargets = (
  attacker: Fighter,
  foes: readonly Fighter[],
): Fighter[] =>
  foes.filter((foe) => attacker.bonusVs.some((tag) => foe.tags.includes(tag)));

/**
 * `standard` is exactly the pre-orders rule — fire at the weakest reachable pool
 * — so a battle with no orders set resolves bit-for-bit as it did before orders
 * existed. It deliberately does *not* prefer a countered target; that is what
 * `focus_counter` is for, and folding it in here would silently retune every
 * battle in the game for players who never touch the control.
 */
const pickStandardTarget = (foes: readonly Fighter[]): Fighter =>
  weakestFirst(foes);

/**
 * Which foe a stack shoots, by its order. Every order falls back to a reachable
 * target, so an order never makes a stack idle while enemies are in range.
 */
const pickTargetByOrder = (
  attacker: Fighter,
  foes: readonly Fighter[],
): Fighter => {
  switch (attacker.order) {
    case "focus_counter": {
      const counters = counterTargets(attacker, foes);
      return counters.length > 0 ? weakestFirst(counters) : weakestFirst(foes);
    }
    case "focus_weak":
      return weakestFirst(foes);
    case "focus_strong":
      return foes.reduce(
        (strongest, foe) => (foe.hpPool.gt(strongest.hpPool) ? foe : strongest),
        foes[0],
      );
    case "frontline":
      // The nearest melee line: the shortest reach, and a screen for what is behind.
      return foes.reduce(
        (nearest, foe) =>
          foe.stats.range < nearest.stats.range ? foe : nearest,
        foes[0],
      );
    case "backline":
      // Keep to the rear: shoot whatever reaches furthest, from behind the line.
      return foes.reduce(
        (furthest, foe) =>
          foe.stats.range > furthest.stats.range ? foe : furthest,
        foes[0],
      );
    case "same_tag": {
      const same = foes.filter((foe) =>
        foe.tags.some((tag) => attacker.tags.includes(tag)),
      );
      return same.length > 0 ? same[0] : foes[0];
    }
    case "protect_ranged":
    case "standard":
    default:
      return pickStandardTarget(foes);
  }
};

/**
 * Screening: a stack that is holding the line, standing to the rear, or guarding
 * the shooters draws fire that was aimed at a protected ally. Only a protected
 * target is screened, so a front line still takes the hits meant for it.
 *
 * A fixed share of the damage is split across the living screens, and the rest
 * lands on the intended target. All of it is still dealt, so screening trades a
 * body's survival for its allies' rather than adding or removing damage.
 *
 * The share is deliberately small. A screen is one stack standing in for another,
 * and the redirected fire is aimed at it precisely because it is nearest — at a
 * higher share the screen dies in the opening rounds, the enemy then focuses
 * whatever is left, and the order loses battles that were already won. A small
 * share lets a tanky screen blunt the volley that would have deleted a fragile
 * ally, which is the whole point of holding a line.
 */
const screeningShare = 0.25;

const applyScreening = (
  target: Fighter,
  damage: ExpNumber,
  targetAllies: readonly Fighter[],
): ExpNumber => {
  const protectedTarget =
    target.order === "protect_ranged" || target.stats.range <= 3;
  if (!protectedTarget) return damage;
  const screens = targetAllies.filter(
    (ally) =>
      ally.unitId !== target.unitId &&
      livingCount(ally).gt(ExpNumber.ZERO) &&
      (ally.order === "frontline" || ally.order === "protect_ranged"),
  );
  if (screens.length === 0) return damage;
  const shared = damage.mul(ExpNumber.fromNumber(screeningShare));
  const each = shared.div(ExpNumber.fromNumber(screens.length));
  for (const screen of screens) {
    screen.hpPool = ExpNumber.max(ExpNumber.ZERO, screen.hpPool.sub(each));
  }
  return damage.sub(shared);
};

const hasLiving = (fighters: readonly Fighter[]): boolean =>
  fighters.some((fighter) => fighter.hpPool.gt(ExpNumber.ZERO));

/**
 * Runs one battle and returns the whole round log (the UI plays it back one round
 * per second). Accuracy is applied as expected damage — `count × attack × hit
 * chance` — rather than as a single coin flip for the stack, so a large stack
 * behaves like the many units it represents. There is no damage roll on top of
 * that: the fight is a pure function of the two armies. Nothing here touches
 * game state.
 */
const simulateBattleInternal = (
  playerStacks: readonly ArmyStack[],
  enemyStacks: readonly ArmyStack[],
  { maxRounds = maximumRounds }: { maxRounds?: number } = {},
  recordRounds: boolean,
): BattleSimulation => {
  const player = buildFighters(playerStacks, "player");
  const enemy = buildFighters(enemyStacks, "enemy");
  // Speed decides who fires first; equal speeds keep deployment order.
  const order = [...player, ...enemy].sort(
    (a, b) => b.stats.speed - a.stats.speed,
  );

  const rounds: BattleRound[] = [];
  if (recordRounds) {
    rounds.push({
      round: 0,
      distance: initialDistance,
      player: snapshot(player),
      enemy: snapshot(enemy),
    });
  }

  let distance = initialDistance;
  let round = 0;
  while (round < maxRounds && hasLiving(player) && hasLiving(enemy)) {
    round += 1;

    for (const attacker of order) {
      const attackers = livingCount(attacker);
      if (attackers.lte(ExpNumber.ZERO)) continue;
      const foes = (attacker.side === "player" ? enemy : player).filter(
        (fighter) =>
          fighter.hpPool.gt(ExpNumber.ZERO) &&
          canReach(attacker, fighter, distance),
      );
      if (foes.length === 0) continue;
      // The stack's order decides the target; `standard` finishes off the weakest.
      const target = pickTargetByOrder(attacker, foes);
      const hitChance = Math.max(
        0.05,
        Math.min(
          1,
          attacker.stats.accuracy *
            (1 - Math.min(1, distance / attacker.stats.range) * 0.3),
        ),
      );
      const targetAllies = attacker.side === "player" ? enemy : player;
      // A line that screens its allies absorbs part of the hit meant for them.
      const damage = applyScreening(
        target,
        attackers
          .mul(attacker.stats.attack)
          .mul(
            ExpNumber.fromNumber(
              hitChance * matchupMultiplier(attacker, target),
            ),
          ),
        targetAllies,
      );
      target.hpPool = ExpNumber.max(ExpNumber.ZERO, target.hpPool.sub(damage));
    }

    const fastest = order.reduce(
      (speed, fighter) =>
        fighter.hpPool.gt(ExpNumber.ZERO)
          ? Math.max(speed, fighter.stats.speed)
          : speed,
      0,
    );
    distance = Math.max(1, distance - Math.max(1, Math.floor(fastest / 2)));
    if (recordRounds) {
      rounds.push({
        round,
        distance,
        player: snapshot(player),
        enemy: snapshot(enemy),
      });
    }
  }

  const playerSurvivors = recordRounds ? totalLiving(player) : ExpNumber.ZERO;
  const enemySurvivors = recordRounds ? totalLiving(enemy) : ExpNumber.ZERO;
  const playerHolds = hasLiving(player);
  const enemyHolds = hasLiving(enemy);
  const outcome: BattleOutcome =
    enemyHolds && !playerHolds
      ? "enemy"
      : playerHolds && !enemyHolds
        ? "player"
        : "stalemate";

  return { rounds, outcome, playerSurvivors, enemySurvivors };
};

/** Full battle result for playback and survivor-dependent rewards. */
export const simulateBattle = (
  playerStacks: readonly ArmyStack[],
  enemyStacks: readonly ArmyStack[],
  options: { maxRounds?: number } = {},
): BattleSimulation =>
  simulateBattleInternal(playerStacks, enemyStacks, options, true);

/** Deterministic win/loss check for strategy search; skips all round-log work. */
export const simulateBattleOutcome = (
  playerStacks: readonly ArmyStack[],
  enemyStacks: readonly ArmyStack[],
  options: { maxRounds?: number } = {},
): BattleOutcome =>
  simulateBattleInternal(playerStacks, enemyStacks, options, false).outcome;
