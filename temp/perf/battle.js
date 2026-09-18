"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.simulateBattle = exports.battleSeed = exports.armyPower = exports.maximumRounds = exports.initialDistance = void 0;
const expNumber_1 = require("./expNumber");
const units_1 = require("./units");
/** Armies deploy this far apart; the lines close a little every round. */
exports.initialDistance = 20;
/** A battle that has not resolved by then is a stalemate (counted as a loss). */
exports.maximumRounds = 200;
/** Below this range, land and sea units cannot reach each other at all. */
const shoreRange = 7;
/** Bonus damage against a tagged target (`bonusVs`), as in the prototype. */
const bonusVsMultiplier = 1.5;
/** mulberry32: tiny, fast, and seedable, so a battle can be replayed exactly. */
const createRandom = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};
const livingCount = (fighter) => {
    if (fighter.hpPool.lte(expNumber_1.ExpNumber.ZERO))
        return expNumber_1.ExpNumber.ZERO;
    return expNumber_1.ExpNumber.min(fighter.initialCount, fighter.hpPool.div(fighter.hitPoints).ceil());
};
const buildFighters = (stacks, side) => stacks.flatMap((stack) => {
    const definition = (0, units_1.findUnitDefinition)(stack.unitId);
    if (!definition || stack.count.lte(expNumber_1.ExpNumber.ZERO))
        return [];
    const hitPoints = stack.stats.hp.div(expNumber_1.ExpNumber.ONE.sub(expNumber_1.ExpNumber.fromNumber(Math.min(stack.stats.armor, 0.9))));
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
const canReach = (attacker, target, distance) => {
    if (!attacker.canHit.includes(target.domain))
        return false;
    if (distance > attacker.stats.range)
        return false;
    if (target.domain === "air" && attacker.stats.range <= 1)
        return false;
    if ((attacker.domain === "naval" && target.domain === "ground") ||
        (attacker.domain === "ground" && target.domain === "naval")) {
        return attacker.stats.range >= shoreRange;
    }
    return true;
};
/** Contextual damage multipliers, kept identical to the prototype's rules. */
const matchupMultiplier = (attacker, target) => {
    let multiplier = 1;
    if (attacker.bonusVs.some((tag) => target.tags.includes(tag))) {
        multiplier *= bonusVsMultiplier;
    }
    if (attacker.domain === "air" && target.domain === "naval")
        multiplier *= 1.2;
    if (attacker.domain === "naval" && target.domain === "ground")
        multiplier *= 0.8;
    if (target.domain === "air" && attacker.stats.range <= 1)
        multiplier *= 0.3;
    return multiplier;
};
/** Army power (AGENTS.md §14): the sum of every stack's count × unit power. */
const armyPower = (stacks) => stacks.reduce((total, stack) => total.add((0, units_1.unitPower)(stack.stats).mul(stack.count)), expNumber_1.ExpNumber.ZERO);
exports.armyPower = armyPower;
const armySignature = (side, stacks) => stacks
    .map((stack) => `${side}:${stack.unitId}:${stack.count.toString()}:${stack.stats.hp.toString()}:${stack.stats.attack.toString()}`)
    .join("|");
/**
 * Seed for a battle: a fingerprint of both armies. Buying different units is a
 * different battle; replaying the same armies is the same battle.
 */
const battleSeed = (player, enemy, battleId = "") => {
    const armies = `${armySignature("player", player)}||${armySignature("enemy", enemy)}`;
    const signature = battleId ? `${battleId}||${armies}` : armies;
    let hash = 2166136261;
    for (let index = 0; index < signature.length; index += 1) {
        hash ^= signature.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
};
exports.battleSeed = battleSeed;
const snapshot = (fighters) => fighters.map((fighter) => ({
    unitId: fighter.unitId,
    count: livingCount(fighter),
    hpPool: fighter.hpPool,
}));
const totalLiving = (fighters) => fighters.reduce((total, fighter) => total.add(livingCount(fighter)), expNumber_1.ExpNumber.ZERO);
/**
 * Runs one battle and returns the whole round log (the UI plays it back one round
 * per second). Accuracy is applied as expected damage — `count × attack × hit
 * chance` — rather than as a single coin flip for the stack, so a large stack
 * behaves like the many units it represents. Nothing here touches game state.
 */
const simulateBattle = (playerStacks, enemyStacks, { seed = (0, exports.battleSeed)(playerStacks, enemyStacks), maxRounds = exports.maximumRounds, } = {}) => {
    const random = createRandom(seed);
    const player = buildFighters(playerStacks, "player");
    const enemy = buildFighters(enemyStacks, "enemy");
    // Speed decides who fires first; equal speeds keep deployment order.
    const order = [...player, ...enemy].sort((a, b) => b.stats.speed - a.stats.speed);
    const rounds = [
        {
            round: 0,
            distance: exports.initialDistance,
            player: snapshot(player),
            enemy: snapshot(enemy),
        },
    ];
    let distance = exports.initialDistance;
    let round = 0;
    while (round < maxRounds &&
        totalLiving(player).gt(expNumber_1.ExpNumber.ZERO) &&
        totalLiving(enemy).gt(expNumber_1.ExpNumber.ZERO)) {
        round += 1;
        for (const attacker of order) {
            const attackers = livingCount(attacker);
            if (attackers.lte(expNumber_1.ExpNumber.ZERO))
                continue;
            const foes = (attacker.side === "player" ? enemy : player).filter((fighter) => livingCount(fighter).gt(expNumber_1.ExpNumber.ZERO) &&
                canReach(attacker, fighter, distance));
            if (foes.length === 0)
                continue;
            // Fire at the weakest stack: finishing units off ends the fight sooner and
            // keeps the log readable.
            const target = foes.reduce((weakest, fighter) => fighter.hpPool.lt(weakest.hpPool) ? fighter : weakest, foes[0]);
            const hitChance = Math.max(0.05, Math.min(1, attacker.stats.accuracy *
                (1 - Math.min(1, distance / attacker.stats.range) * 0.3)));
            const variance = 0.8 + random() * 0.4;
            const damage = attackers
                .mul(attacker.stats.attack)
                .mul(expNumber_1.ExpNumber.fromNumber(hitChance * variance * matchupMultiplier(attacker, target)));
            target.hpPool = expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ZERO, target.hpPool.sub(damage));
        }
        const fastest = order.reduce((speed, fighter) => livingCount(fighter).gt(expNumber_1.ExpNumber.ZERO)
            ? Math.max(speed, fighter.stats.speed)
            : speed, 0);
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
    const playerHolds = playerSurvivors.gt(expNumber_1.ExpNumber.ZERO);
    const enemyHolds = enemySurvivors.gt(expNumber_1.ExpNumber.ZERO);
    const outcome = enemyHolds && !playerHolds
        ? "enemy"
        : playerHolds && !enemyHolds
            ? "player"
            : "stalemate";
    return { seed, rounds, outcome, playerSurvivors, enemySurvivors };
};
exports.simulateBattle = simulateBattle;
