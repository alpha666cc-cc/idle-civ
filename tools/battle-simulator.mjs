#!/usr/bin/env node

/**
 * Battle simulator for testing unit strength scaling and battle balance.
 * This script helps visualize and test battle outcomes to ensure optimal unit mixes.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load unit and encounter data
const unitsData = JSON.parse(
  readFileSync(join(__dirname, "../src/game/data/units.json"), "utf8"),
);
const encountersData = JSON.parse(
  readFileSync(join(__dirname, "../src/game/data/encounters.json"), "utf8"),
);

// Simple ExpNumber implementation for simulation
class ExpNumber {
  constructor(mantissa, exponent) {
    this.mantissa = mantissa;
    this.exponent = exponent;
  }

  static from(value) {
    if (typeof value === "number") {
      if (value === 0) return new ExpNumber(0, 0);
      if (value < 0) throw new Error("Negative numbers not supported");
      const exp = Math.floor(Math.log10(value));
      const mant = value / Math.pow(10, exp);
      return new ExpNumber(mant, exp);
    }
    if (typeof value === "string") {
      const match = value.match(/^([+-]?\d+\.?\d*)(?:[eE]([+-]?\d+))?$/);
      if (!match) throw new Error(`Invalid ExpNumber string: ${value}`);
      const mant = parseFloat(match[1]);
      const exp = match[2] ? parseInt(match[2]) : 0;
      return new ExpNumber(mant, exp);
    }
    throw new Error(`Unsupported value type: ${typeof value}`);
  }

  static fromNumber(value) {
    return ExpNumber.from(value);
  }

  static get ZERO() {
    return new ExpNumber(0, 0);
  }
  static get ONE() {
    return new ExpNumber(1, 0);
  }

  toNumber() {
    return this.mantissa * Math.pow(10, this.exponent);
  }

  toString() {
    if (this.mantissa === 0) return "0";
    return `${this.mantissa}e${this.exponent}`;
  }

  add(other) {
    if (this.mantissa === 0) return other;
    if (other.mantissa === 0) return this;

    // Align exponents
    const [a, b] =
      this.exponent > other.exponent ? [this, other] : [other, this];
    const expDiff = a.exponent - b.exponent;
    const scaledB = new ExpNumber(
      b.mantissa / Math.pow(10, expDiff),
      a.exponent,
    );
    const sum = new ExpNumber(a.mantissa + scaledB.mantissa, a.exponent);
    return sum.normalize();
  }

  sub(other) {
    return this.add(other.negate());
  }

  negate() {
    return new ExpNumber(-this.mantissa, this.exponent);
  }

  mul(other) {
    if (this.mantissa === 0 || other.mantissa === 0) return ExpNumber.ZERO;
    return new ExpNumber(
      this.mantissa * other.mantissa,
      this.exponent + other.exponent,
    ).normalize();
  }

  div(other) {
    if (other.mantissa === 0) throw new Error("Division by zero");
    return new ExpNumber(
      this.mantissa / other.mantissa,
      this.exponent - other.exponent,
    ).normalize();
  }

  normalize() {
    if (this.mantissa === 0) return ExpNumber.ZERO;
    while (Math.abs(this.mantissa) >= 10) {
      this.mantissa /= 10;
      this.exponent += 1;
    }
    while (Math.abs(this.mantissa) < 1 && this.mantissa !== 0) {
      this.mantissa *= 10;
      this.exponent -= 1;
    }
    return this;
  }

  lt(other) {
    return this.toNumber() < other.toNumber();
  }

  lte(other) {
    return this.toNumber() <= other.toNumber();
  }

  gt(other) {
    return this.toNumber() > other.toNumber();
  }

  gte(other) {
    return this.toNumber() >= other.toNumber();
  }

  log10() {
    return Math.log10(this.mantissa) + this.exponent;
  }

  ceil() {
    const num = this.toNumber();
    return ExpNumber.from(Math.ceil(num));
  }

  min(other) {
    return this.lte(other) ? this : other;
  }

  max(other) {
    return this.gte(other) ? this : other;
  }
}

// Calculate unit power
function unitPower(stats) {
  const effectiveHP = stats.hp.div(
    ExpNumber.ONE.sub(ExpNumber.fromNumber(Math.min(stats.armor, 0.9))),
  );
  const attackTimesAccuracy = stats.attack.mul(
    ExpNumber.fromNumber(stats.accuracy),
  );
  const sqrtEHP = ExpNumber.fromNumber(Math.sqrt(effectiveHP.toNumber()));
  return attackTimesAccuracy.mul(sqrtEHP);
}

// Simulate a more realistic battle with range, speed, and accuracy
function simulateRealisticBattle(playerUnits, enemyUnits) {
  const initialDistance = 20;
  const maximumRounds = 200;
  const shoreRange = 7;
  const bonusVsMultiplier = 1.5;

  // Build fighter objects
  const buildFighters = (units, side) => {
    return units.map((unit) => {
      const unitDef = unitsData.find((u) => u.id === unit.unitId);
      const effectiveHP =
        unit.stats.hp.toNumber() / (1 - Math.min(unit.stats.armor, 0.9));

      return {
        unitId: unit.unitId,
        name: unit.name,
        side,
        stats: unit.stats,
        domain: unitDef?.domain || "ground",
        canHit: unitDef?.canHit || ["ground"],
        bonusVs: unitDef?.bonusVs || [],
        tags: unitDef?.tags || [],
        count: unit.count,
        hitPoints: effectiveHP,
        hpPool: effectiveHP * unit.count,
        initialCount: unit.count,
      };
    });
  };

  const player = buildFighters(playerUnits, "player");
  const enemy = buildFighters(enemyUnits, "enemy");
  const allFighters = [...player, ...enemy];

  // Sort by speed (higher speed fires first)
  allFighters.sort((a, b) => b.stats.speed - a.stats.speed);

  let distance = initialDistance;
  let round = 0;
  let playerHP = player.reduce((sum, f) => sum + f.hpPool, 0);
  let enemyHP = enemy.reduce((sum, f) => sum + f.hpPool, 0);

  while (round < maximumRounds && playerHP > 0 && enemyHP > 0) {
    round++;

    for (const attacker of allFighters) {
      if (attacker.hpPool <= 0) continue;

      const livingCount = Math.max(
        0,
        Math.min(
          attacker.initialCount,
          Math.ceil(attacker.hpPool / attacker.hitPoints),
        ),
      );
      if (livingCount <= 0) continue;

      const foes = (attacker.side === "player" ? enemy : player).filter(
        (fighter) => {
          if (fighter.hpPool <= 0) return false;

          // Check domain targeting
          if (!attacker.canHit.includes(fighter.domain)) return false;

          // Check range
          if (distance > attacker.stats.range) return false;

          // Special rules
          if (fighter.domain === "air" && attacker.stats.range <= 1)
            return false;
          if (
            (attacker.domain === "naval" && fighter.domain === "ground") ||
            (attacker.domain === "ground" && fighter.domain === "naval")
          ) {
            if (attacker.stats.range < shoreRange) return false;
          }

          return true;
        },
      );

      if (foes.length === 0) continue;

      // Target weakest stack
      const target = foes.reduce(
        (weakest, f) => (f.hpPool < weakest.hpPool ? f : weakest),
        foes[0],
      );

      // Calculate hit chance with distance penalty
      const hitChance = Math.max(
        0.05,
        Math.min(
          1,
          attacker.stats.accuracy *
            (1 - Math.min(1, distance / attacker.stats.range) * 0.3),
        ),
      );

      // Calculate matchup multipliers
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

      // Apply damage
      const baseDamage =
        livingCount * attacker.stats.attack.toNumber() * hitChance * multiplier;
      target.hpPool = Math.max(0, target.hpPool - baseDamage);
    }

    // Update HP totals
    playerHP = player.reduce((sum, f) => sum + Math.max(0, f.hpPool), 0);
    enemyHP = enemy.reduce((sum, f) => sum + Math.max(0, f.hpPool), 0);

    // Close distance based on fastest living unit
    const fastestSpeed = Math.max(
      ...allFighters.filter((f) => f.hpPool > 0).map((f) => f.stats.speed),
    );
    distance = Math.max(
      1,
      distance - Math.max(1, Math.floor(fastestSpeed / 2)),
    );
  }

  return {
    winner: playerHP > 0 ? "player" : enemyHP > 0 ? "enemy" : "draw",
    rounds: round,
    playerHP: Math.max(0, playerHP),
    enemyHP: Math.max(0, enemyHP),
    finalDistance: distance,
  };
}

// Process units with scaling already applied in JSON
function processUnits() {
  return unitsData.map((unit) => {
    const hp = ExpNumber.fromNumber(unit.hp);
    const attack = ExpNumber.fromNumber(unit.attack);

    return {
      ...unit,
      scaledStats: {
        hp: hp.toNumber(),
        attack: attack.toNumber(),
        armor: unit.armor,
        range: unit.range,
        speed: unit.speed,
        accuracy: unit.accuracy,
      },
      scale: 1, // Scaling is now in the JSON data itself
      power: unitPower({
        hp,
        attack,
        armor: unit.armor,
        range: unit.range,
        speed: unit.speed,
        accuracy: unit.accuracy,
      }).toNumber(),
      militaryCost:
        unit.costs?.find((c) => c.resource === "military")?.base || 0,
    };
  });
}

// Test specific battles
function testBattle(battleKey, playerUnitConfig) {
  const encounter = encountersData.find((e) => e.key === battleKey);
  if (!encounter) {
    console.log(`Battle ${battleKey} not found`);
    return;
  }

  console.log(`\n=== Testing: ${encounter.name} (${battleKey}) ===`);
  console.log(`Age: ${encounter.age}, Boss: ${encounter.isBoss}`);

  // Build enemy army
  const enemyUnits = encounter.enemyArmy
    .map((e) => {
      const unitDef = unitsData.find((u) => u.id === e.unitId);
      if (!unitDef) return null;
      const hp = ExpNumber.fromNumber(unitDef.hp);
      const attack = ExpNumber.fromNumber(unitDef.attack);

      return {
        unitId: e.unitId,
        name: unitDef.name,
        count: e.count,
        stats: {
          hp,
          attack,
          armor: unitDef.armor,
          range: unitDef.range,
          speed: unitDef.speed,
          accuracy: unitDef.accuracy,
        },
      };
    })
    .filter(Boolean);

  // Build player army from config
  const playerUnits = playerUnitConfig
    .map((config) => {
      const unitDef = unitsData.find((u) => u.id === config.unitId);
      if (!unitDef) return null;
      const hp = ExpNumber.fromNumber(unitDef.hp);
      const attack = ExpNumber.fromNumber(unitDef.attack);

      return {
        unitId: config.unitId,
        name: unitDef.name,
        count: config.count,
        stats: {
          hp,
          attack,
          armor: unitDef.armor,
          range: unitDef.range,
          speed: unitDef.speed,
          accuracy: unitDef.accuracy,
        },
      };
    })
    .filter(Boolean);

  // Calculate army powers
  const playerPower = playerUnits.reduce((sum, u) => {
    const power = unitPower(u.stats).toNumber();
    return sum + power * u.count;
  }, 0);

  const enemyPower = enemyUnits.reduce((sum, u) => {
    const power = unitPower(u.stats).toNumber();
    return sum + power * u.count;
  }, 0);

  console.log(`\nPlayer Army:`);
  playerUnits.forEach((u) => {
    const power = unitPower(u.stats).toNumber();
    console.log(
      `  ${u.name} x${u.count}: ${power.toFixed(2)} power each = ${(power * u.count).toFixed(2)} total`,
    );
  });
  console.log(`  Total Player Power: ${playerPower.toFixed(2)}`);

  console.log(`\nEnemy Army:`);
  enemyUnits.forEach((u) => {
    const power = unitPower(u.stats).toNumber();
    console.log(
      `  ${u.name} x${u.count}: ${power.toFixed(2)} power each = ${(power * u.count).toFixed(2)} total`,
    );
  });
  console.log(`  Total Enemy Power: ${enemyPower.toFixed(2)}`);

  const result = simulateRealisticBattle(playerUnits, enemyUnits);
  console.log(`\nBattle Result:`);
  console.log(`  Winner: ${result.winner}`);
  console.log(`  Rounds: ${result.rounds}`);
  console.log(`  Player HP remaining: ${result.playerHP.toFixed(2)}`);
  console.log(`  Enemy HP remaining: ${result.enemyHP.toFixed(2)}`);
  console.log(`  Final distance: ${result.finalDistance}`);
  console.log(
    `  Power ratio (Player/Enemy): ${(playerPower / enemyPower).toFixed(3)}`,
  );

  return result;
}

// Main execution
const processedUnits = processUnits();

console.log("=== Unit Strength Analysis ===");
console.log("\nFirst 10 units by military cost:");
processedUnits
  .filter((u) => u.militaryCost > 0)
  .sort((a, b) => a.militaryCost - b.militaryCost)
  .slice(0, 10)
  .forEach((u) => {
    console.log(
      `${u.name}: cost=${u.militaryCost.toExponential(2)}, scale=${u.scale.toFixed(2)}, power=${u.power.toFixed(2)}`,
    );
  });

console.log("\n=== Testing Early Battles ===");

// Test first battle - should be winnable with 5-7 tribesman
testBattle("age0_1_first_fire", [{ unitId: "warrior", count: 5 }]);

testBattle("age0_1_first_fire", [{ unitId: "warrior", count: 7 }]);

// Test second battle - should need mix of tribesman and slinger
testBattle("age0_2_wolf_pack", [{ unitId: "warrior", count: 12 }]);

testBattle("age0_2_wolf_pack", [
  { unitId: "warrior", count: 12 },
  { unitId: "slinger", count: 12 },
]);

testBattle("age0_2_wolf_pack", [
  { unitId: "warrior", count: 15 },
  { unitId: "slinger", count: 15 },
]);

console.log("\n=== Testing All Battles ===");

// Test all encounters
encountersData.forEach((encounter) => {
  testBattle(encounter.key, [
    { unitId: "warrior", count: 50 },
    { unitId: "slinger", count: 30 },
  ]);
});

console.log("\n=== Analysis Complete ===");
