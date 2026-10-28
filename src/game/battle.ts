import { ExpNumber } from "./expNumber";
import {
  DEFAULT_FORMATION,
  findFormationDefinition,
  type FormationId,
} from "./formations";
import {
  DEFAULT_ORDER,
  orderDefinitions,
  ordersForAge,
  type OrderId,
} from "./orders";
import {
  findUnitDefinition,
  unitPower,
  type UnitDomain,
  type UnitStats,
} from "./units";

/**
 * The battle model (AGENTS.md §14, roadmap Milestone 8).
 *
 * A round is one second of playback: both armies advance one position, then
 * every stack that can reach an enemy fires once in speed order. Casualties are
 * tracked as an aggregate hit point pool per stack — never one object per unit —
 * so a million spearmen cost exactly as much to simulate as a stack of one, and
 * a battle always finishes in bounded time.
 *
 * Contact is latched once per round (front gap ≤ 1 after the movement step), so
 * a mid-round kill on the front line cannot silently break it. While engaged,
 * stacks behind their own front advance one position per round, even when their
 * range already lets them attack. Their effective reach includes that progress,
 * so backline units can join as they move forward without losing ranged attacks.
 * Once a stack reaches the front, an empty target list widens its reach one step
 * at a time until a living, attackable foe is found; this does not change target
 * priority or the stack's formation-advance timing.
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
  /** Formation: positioning + stat trades; `standard` if unset. */
  readonly formation?: FormationId;
};

/** Battle targeting orders (re-exported from orders.ts for convenience) */
export type BattleOrder = OrderId;
export const standardOrder = DEFAULT_ORDER;
export const battleOrders = orderDefinitions.map(
  (def) => def.id,
) as readonly BattleOrder[];
export const orderUnlocks = (ageIndex: number): readonly BattleOrder[] =>
  ordersForAge(ageIndex);
export const battleOrderLabels: Record<BattleOrder, string> =
  Object.fromEntries(
    orderDefinitions.map((def) => [def.id, def.name]),
  ) as Record<BattleOrder, string>;
export const battleOrderHints: Record<BattleOrder, string> = Object.fromEntries(
  orderDefinitions.map((def) => [def.id, def.description]),
) as Record<BattleOrder, string>;

export type BattleSide = "player" | "enemy";

export type StackSnapshot = {
  readonly unitId: string;
  readonly side: BattleSide;
  /** Units still standing, rounded up so a wounded unit is still a unit. */
  readonly count: ExpNumber;
  readonly hpPool: ExpNumber;
  readonly position: number;
};

export type BattleAttackLog = {
  readonly attackerSide: BattleSide;
  readonly attackerId: string;
  readonly targetSide: BattleSide;
  readonly targetId: string;
  readonly attackerPosition: number;
  readonly targetPosition: number;
  /** Cumulative steps from deployment; `position ± attackAdvance` is the strike position. */
  readonly attackAdvance: number;
  readonly reachableTargets: readonly string[];
  readonly reachableTargetSide: BattleSide;
  readonly attackerCountBefore: ExpNumber;
  readonly attackerCountAfter: ExpNumber;
  readonly attackerAliveBefore: ExpNumber;
  readonly attackerAliveAfter: ExpNumber;
  readonly targetAliveBefore: ExpNumber;
  readonly targetAliveAfter: ExpNumber;
  readonly intendedDamage: ExpNumber;
  readonly targetDamage: ExpNumber;
  readonly screening: readonly {
    readonly side: BattleSide;
    readonly unitId: string;
    readonly damage: ExpNumber;
    readonly aliveBefore: ExpNumber;
    readonly aliveAfter: ExpNumber;
  }[];
};

export type BattleRound = {
  readonly round: number;
  /** Distance between the armies' front lines at the start of the round. */
  readonly distance: number;
  readonly player: readonly StackSnapshot[];
  readonly enemy: readonly StackSnapshot[];
  readonly attacks: readonly BattleAttackLog[];
};

export type BattleOutcome = "player" | "enemy" | "stalemate";

export type BattleSimulation = {
  readonly rounds: readonly BattleRound[];
  readonly outcome: BattleOutcome;
  readonly playerSurvivors: ExpNumber;
  readonly enemySurvivors: ExpNumber;
};

/** A battle that has not resolved by then is a stalemate (counted as a loss). */
export const maximumRounds = 101;
/** Bonus damage against a tagged target (`bonusVs`), as in the prototype. */
const bonusVsMultiplier = 1.5;

/**
 * Apply formation stat bonuses to unit stats.
 * `standard` formation has no bonuses, so it returns stats unchanged.
 */
const applyFormationStats = (
  stats: UnitStats,
  formation: FormationId,
): UnitStats => {
  const formationDef = findFormationDefinition(formation);
  if (
    !formationDef ||
    !formationDef.statBonuses ||
    formationDef.statBonuses.length === 0
  ) {
    return stats;
  }

  const bonusMap = new Map(
    formationDef.statBonuses.map((b) => [b.attribute, b.multiplier]),
  );

  const applyBonus = (value: ExpNumber, attribute: string): ExpNumber => {
    const multiplier = bonusMap.get(attribute);
    if (!multiplier) return value;
    return value.mul(ExpNumber.fromNumber(multiplier));
  };

  const applyBonusToNumber = (value: number, attribute: string): number => {
    const multiplier = bonusMap.get(attribute);
    if (!multiplier) return value;
    return value * multiplier;
  };

  let newStats = {
    ...stats,
    hp: applyBonus(stats.hp, "unitAll.hp"),
    attack: applyBonus(stats.attack, "unitAll.attack"),
    accuracy: applyBonusToNumber(stats.accuracy, "unitAll.accuracy"),
  };

  // Tag-specific bonuses: for now, just apply to all units with that tag
  // This is a simplification - proper implementation would check unit tags
  if (bonusMap.has("tag.cavalry.attack")) {
    newStats = {
      ...newStats,
      attack: applyBonus(newStats.attack, "tag.cavalry.attack"),
    };
  }
  if (bonusMap.has("tag.ranged.attack")) {
    newStats = {
      ...newStats,
      attack: applyBonus(newStats.attack, "tag.ranged.attack"),
    };
  }

  return newStats;
};

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
  /** The formation this stack uses for positioning and stat trades. */
  readonly formation: FormationId;
  /** Attack-only advance; formation position remains unchanged for targeting. */
  attackAdvance: number;
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

const effectivePosition = (fighter: Fighter, armyPosition: number): number => {
  const offset =
    findFormationDefinition(fighter.formation)?.positionOffset ?? 0;
  return armyPosition + (fighter.side === "player" ? -offset : offset);
};

const armyFrontPosition = (
  fighters: readonly Fighter[],
  armyPosition: number,
): number => {
  const positions = fighters
    .filter((fighter) => fighter.hpPool.gt(ExpNumber.ZERO))
    .map((fighter) => effectivePosition(fighter, armyPosition));
  if (positions.length === 0) return armyPosition;
  return fighters[0].side === "player"
    ? Math.max(...positions)
    : Math.min(...positions);
};

const buildFighters = (
  stacks: readonly ArmyStack[],
  side: BattleSide,
): Fighter[] =>
  [...stacks]
    .sort((left, right) => left.unitId.localeCompare(right.unitId))
    .flatMap((stack) => {
      const definition = findUnitDefinition(stack.unitId);
      if (!definition || stack.count.lte(ExpNumber.ZERO)) return [];
      const formation = stack.formation ?? DEFAULT_FORMATION;
      // `standard` formation has no stat bonuses, so this is a no-op for Age 0/1
      const effectiveStats = applyFormationStats(stack.stats, formation);
      const hitPoints = effectiveStats.hp.div(
        ExpNumber.ONE.sub(
          ExpNumber.fromNumber(Math.min(effectiveStats.armor, 0.9)),
        ),
      );
      return [
        {
          unitId: stack.unitId,
          side,
          stats: effectiveStats,
          domain: definition.domain,
          canHit: definition.canHit,
          bonusVs: definition.bonusVs,
          tags: definition.tags,
          hitPoints,
          initialCount: stack.count,
          hpPool: hitPoints.mul(stack.count),
          initialHpPool: hitPoints.mul(stack.count),
          order: stack.order ?? standardOrder,
          formation,
          attackAdvance: 0,
        },
      ];
    });

/** Range and domain rules use signed army positions plus mirrored formation offsets. */
const canReach = (
  attacker: Fighter,
  target: Fighter,
  playerPosition: number,
  enemyPosition: number,
  attackAdvance = 0,
  extraRange = 0,
): boolean => {
  if (!canAttackDomain(attacker, target)) return false;

  const attackerPos = effectivePosition(
    attacker,
    attacker.side === "player" ? playerPosition : enemyPosition,
  );
  const targetPos = effectivePosition(
    target,
    target.side === "player" ? playerPosition : enemyPosition,
  );
  const attackPosition =
    attackerPos + (attacker.side === "player" ? attackAdvance : -attackAdvance);
  const actualDistance = Math.abs(attackPosition - targetPos);

  if (actualDistance > attacker.stats.range + extraRange) return false;
  return true;
};

const canAttackDomain = (attacker: Fighter, target: Fighter): boolean =>
  attacker.canHit.includes(target.domain) &&
  !(target.domain === "air" && attacker.stats.range <= 1) &&
  !(
    attacker.domain === "ground" &&
    target.domain === "naval" &&
    attacker.stats.range <= 3
  );

/** Contextual damage multipliers, kept identical to the prototype's rules. */
const matchupMultiplier = (attacker: Fighter, target: Fighter): number => {
  let multiplier = 1;
  // A formation may declare damage dealt to tagged targets (e.g. Pike Square
  // spears cavalry).
  const damageDealtVs =
    findFormationDefinition(attacker.formation)?.damageDealtVs ?? [];
  for (const rule of damageDealtVs) {
    if (target.tags.includes(rule.tag)) multiplier *= rule.multiplier;
  }
  // A formation may declare damage taken from tagged attackers (e.g. Turtle
  // shields against `ranged` fire).
  const damageTakenVs =
    findFormationDefinition(target.formation)?.damageTakenVs ?? [];
  for (const rule of damageTakenVs) {
    if (attacker.tags.includes(rule.tag)) multiplier *= rule.multiplier;
  }
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

const snapshot = (
  fighters: readonly Fighter[],
  armyPosition: number,
  side: BattleSide,
): StackSnapshot[] =>
  fighters.map((fighter) => ({
    unitId: fighter.unitId,
    side,
    count: livingCount(fighter),
    hpPool: fighter.hpPool,
    position: effectivePosition(fighter, armyPosition),
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
 * Which foe a stack shoots, by its targeting order. Every order falls back to a reachable
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
  attacker: Fighter,
): ExpNumber => {
  const protectedTarget = target.tags.some(
    (tag) => tag === "ranged" || tag === "siege",
  );
  if (!protectedTarget) return damage;
  const screens = targetAllies.filter(
    (ally) =>
      ally.unitId !== target.unitId &&
      livingCount(ally).gt(ExpNumber.ZERO) &&
      ally.domain === "ground" &&
      ally.tags.includes("infantry"),
  );
  if (screens.length === 0) return damage;
  const shared = damage.mul(ExpNumber.fromNumber(screeningShare));
  const each = shared.div(ExpNumber.fromNumber(screens.length));
  for (const screen of screens) {
    // Each screen's share is damage aimed at it, so apply the full matchup
    // multiplier (formation damageTakenVs/damageDealtVs, bonusVs, domain).
    const screenMultiplier = matchupMultiplier(attacker, screen);
    const reduced = each.mul(ExpNumber.fromNumber(screenMultiplier));
    screen.hpPool = ExpNumber.max(ExpNumber.ZERO, screen.hpPool.sub(reduced));
  }
  // The target takes the rest of the damage, which is the original minus what was screened(matchup excluded).
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
  const maximumRange = Math.max(
    0,
    ...[...player, ...enemy].map((fighter) => fighter.stats.range),
  );
  const startingGap = Math.ceil(maximumRange) + 1;
  const playerFrontOffset = armyFrontPosition(player, 0);
  const enemyFrontOffset = armyFrontPosition(enemy, 0);
  let playerPosition = -Math.floor(startingGap / 2) - playerFrontOffset;
  let enemyPosition = Math.ceil(startingGap / 2) - enemyFrontOffset;
  // Speed decides who fires first; equal speeds keep deployment order.
  const order = [...player, ...enemy].sort(
    (a, b) => b.stats.speed - a.stats.speed,
  );

  const rounds: BattleRound[] = [];
  if (recordRounds) {
    rounds.push({
      round: 0,
      distance: Math.abs(
        armyFrontPosition(enemy, enemyPosition) -
          armyFrontPosition(player, playerPosition),
      ),
      player: snapshot(player, playerPosition, "player"),
      enemy: snapshot(enemy, enemyPosition, "enemy"),
      attacks: [],
    });
  }

  let round = 0;
  while (round < maxRounds && hasLiving(player) && hasLiving(enemy)) {
    round += 1;
    const frontGap =
      armyFrontPosition(enemy, enemyPosition) -
      armyFrontPosition(player, playerPosition);
    if (frontGap > 1) {
      playerPosition += 1;
      enemyPosition -= 1;
    }
    // Contact is latched for the whole round, *after* the movement step. It is
    // deliberately not re-evaluated mid-round: a front stack dying to a faster
    // attacker used to flip this flag live, and the slower stack behind it then
    // lost its turn without even banking an advance step. Once engaged, both
    // sides stay engaged until the next round re-measures the gap.
    const engaged =
      Math.abs(
        armyFrontPosition(enemy, enemyPosition) -
          armyFrontPosition(player, playerPosition),
      ) <= 1;
    const attacks: BattleAttackLog[] = [];

    for (const attacker of order) {
      const attackers = livingCount(attacker);
      if (attackers.lte(ExpNumber.ZERO)) continue;
      const enemyForces = attacker.side === "player" ? enemy : player;
      const livingFoes = enemyForces.filter((fighter) =>
        fighter.hpPool.gt(ExpNumber.ZERO),
      );
      const positionOf = (fighter: Fighter): number =>
        effectivePosition(
          fighter,
          fighter.side === "player" ? playerPosition : enemyPosition,
        );
      const attackerPosition = positionOf(attacker);
      const ownForces = attacker.side === "player" ? player : enemy;
      const ownArmyPosition =
        attacker.side === "player" ? playerPosition : enemyPosition;
      const ownFrontPosition = armyFrontPosition(ownForces, ownArmyPosition);
      const distanceToFront =
        attacker.side === "player"
          ? ownFrontPosition - attackerPosition
          : attackerPosition - ownFrontPosition;
      if (engaged && attacker.attackAdvance < distanceToFront) {
        attacker.attackAdvance += 1;
      }
      const hasReachedFront = attacker.attackAdvance >= distanceToFront;
      const reachableFoes = (extraRange: number) =>
        livingFoes.filter((fighter) =>
          canReach(
            attacker,
            fighter,
            playerPosition,
            enemyPosition,
            attacker.attackAdvance,
            extraRange,
          ),
        );
      let extraRange = 0;
      let foes = reachableFoes(extraRange);
      while (
        foes.length === 0 &&
        engaged &&
        hasReachedFront &&
        livingFoes.some((fighter) => canAttackDomain(attacker, fighter))
      ) {
        extraRange += 1;
        foes = reachableFoes(extraRange);
      }
      if (foes.length === 0) {
        continue;
      }
      const melee = attacker.stats.range <= 1;
      const eligible = melee
        ? foes
            .filter((foe) => attacker.canHit.includes(foe.domain))
            .sort(
              (left, right) =>
                Math.abs(positionOf(left) - attackerPosition) -
                Math.abs(positionOf(right) - attackerPosition),
            )
            .slice(0, 1)
        : foes;
      if (eligible.length === 0) continue;
      // The stack's order decides the target; `standard` finishes off the weakest.
      const target = pickTargetByOrder(attacker, eligible);
      const attackerBefore = livingCount(attacker);
      const targetBefore = livingCount(target);
      const targetHpBefore = target.hpPool;
      const screenBefore = new Map(
        (attacker.side === "player" ? enemy : player).map((fighter) => [
          fighter,
          { hp: fighter.hpPool, count: livingCount(fighter) },
        ]),
      );
      const attackerPos = attackerPosition;
      const targetPos = positionOf(target);
      const attackPosition =
        attackerPos +
        (attacker.side === "player"
          ? attacker.attackAdvance
          : -attacker.attackAdvance);
      const distance = Math.abs(attackPosition - targetPos);
      const hitChance = Math.max(
        0.05,
        Math.min(
          1,
          attacker.stats.accuracy *
            (1 -
              Math.min(1, distance / Math.max(1, attacker.stats.range)) * 0.3),
        ),
      );
      const targetAllies = attacker.side === "player" ? enemy : player;
      // Raw damage before any resistances — each unit that actually takes a
      // share (screen or target) applies its own matchup multiplier after
      // screening decides who takes what.
      const intendedDamage = attackers
        .mul(attacker.stats.attack)
        .mul(ExpNumber.fromNumber(hitChance));
      const damage = applyScreening(
        target,
        intendedDamage,
        targetAllies,
        attacker,
      );
      // The target's own resistances apply only to what reaches it after screening.
      const targetDamage = damage.mul(
        ExpNumber.fromNumber(matchupMultiplier(attacker, target)),
      );
      target.hpPool = ExpNumber.max(
        ExpNumber.ZERO,
        target.hpPool.sub(targetDamage),
      );
      attacks.push({
        attackerSide: attacker.side,
        attackerId: attacker.unitId,
        targetSide: target.side,
        targetId: target.unitId,
        attackerPosition: attackerPos,
        targetPosition: targetPos,
        attackAdvance: attacker.attackAdvance,
        reachableTargets: foes.map((foe) => foe.unitId),
        reachableTargetSide: attacker.side === "player" ? "enemy" : "player",
        attackerCountBefore: attackerBefore,
        attackerCountAfter: livingCount(attacker),
        attackerAliveBefore: attackerBefore,
        attackerAliveAfter: livingCount(attacker),
        targetAliveBefore: targetBefore,
        targetAliveAfter: livingCount(target),
        intendedDamage,
        targetDamage: ExpNumber.max(
          ExpNumber.ZERO,
          targetHpBefore.sub(target.hpPool),
        ),
        screening: targetAllies
          .filter((fighter) => fighter !== target)
          .flatMap((fighter) => {
            const before = screenBefore.get(fighter);
            if (!before || before.hp.eq(fighter.hpPool)) return [];
            return [
              {
                side: fighter.side,
                unitId: fighter.unitId,
                damage: before.hp.sub(fighter.hpPool),
                aliveBefore: before.count,
                aliveAfter: livingCount(fighter),
              },
            ];
          }),
      });
    }

    if (recordRounds) {
      rounds.push({
        round,
        distance: Math.abs(
          armyFrontPosition(enemy, enemyPosition) -
            armyFrontPosition(player, playerPosition),
        ),
        player: snapshot(player, playerPosition, "player"),
        enemy: snapshot(enemy, enemyPosition, "enemy"),
        attacks,
      });
    }
  }

  const playerSurvivors = totalLiving(player);
  const enemySurvivors = totalLiving(enemy);
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

/** Survivor summary for search/scoring without retaining the per-round log. */
export const simulateBattleSummary = (
  playerStacks: readonly ArmyStack[],
  enemyStacks: readonly ArmyStack[],
  options: { maxRounds?: number } = {},
): BattleSimulation =>
  simulateBattleInternal(playerStacks, enemyStacks, options, false);

/** Deterministic win/loss check for strategy search; skips all round-log work. */
export const simulateBattleOutcome = (
  playerStacks: readonly ArmyStack[],
  enemyStacks: readonly ArmyStack[],
  options: { maxRounds?: number } = {},
): BattleOutcome =>
  simulateBattleInternal(playerStacks, enemyStacks, options, false).outcome;
