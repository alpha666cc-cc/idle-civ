#!/usr/bin/env node

/**
 * Script to calculate and apply unit scaling directly to units.json
 * instead of using engine-side scaling.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load units data
const unitsData = JSON.parse(
  readFileSync(join(__dirname, "../src/game/data/units.json"), "utf8"),
);

// Calculate scaling factor - very conservative tier-based scaling
function calculateScale(data) {
  const military = data.costs?.find(({ resource }) => resource === "military");
  if (!military) return 1;

  // Convert cost to number for comparison
  let costNum;
  if (typeof military.base === "number") {
    costNum = military.base;
  } else {
    // Parse scientific notation
    const match = military.base
      .toString()
      .match(/^([+-]?\d+\.?\d*)(?:[eE]([+-]?\d+))?$/);
    if (match) {
      const mant = parseFloat(match[1]);
      const exp = match[2] ? parseInt(match[2]) : 0;
      costNum = mant * Math.pow(10, exp);
    } else {
      costNum = parseFloat(military.base);
    }
  }

  // Very conservative tier-based scaling
  if (costNum <= 1000) return 1.0; // Early units: no scaling
  if (costNum <= 100000) return 1.2; // Early-mid: 20% boost
  if (costNum <= 10000000) return 1.5; // Mid game: 50% boost
  if (costNum <= 1000000000) return 2.0; // Late game: 2x boost
  if (costNum <= 100000000000) return 3.0; // Very late: 3x boost
  return 4.0; // Maximum 4x for endgame units
}

// Apply scaling to units
const scaledUnits = unitsData.map((unit) => {
  const scale = calculateScale(unit);

  // Only scale if cost > 0 (player-buyable units)
  if (unit.costs && unit.costs.length > 0) {
    const scaledUnit = {
      ...unit,
      hp: Math.round(unit.hp * scale),
      attack: Math.round(unit.attack * scale),
    };

    let costNum;
    if (typeof unit.costs[0].base === "number") {
      costNum = unit.costs[0].base;
    } else {
      const match = unit.costs[0].base
        .toString()
        .match(/^([+-]?\d+\.?\d*)(?:[eE]([+-]?\d+))?$/);
      if (match) {
        const mant = parseFloat(match[1]);
        const exp = match[2] ? parseInt(match[2]) : 0;
        costNum = mant * Math.pow(10, exp);
      } else {
        costNum = parseFloat(unit.costs[0].base);
      }
    }

    const costDisplay = costNum.toExponential(2);

    console.log(
      `${unit.name}: cost=${costDisplay}, scale=${scale.toFixed(2)}, hp: ${unit.hp} -> ${scaledUnit.hp}, attack: ${unit.attack} -> ${scaledUnit.attack}`,
    );

    return scaledUnit;
  }

  // Enemy-only units keep original stats
  console.log(`${unit.name}: enemy-only, no scaling applied`);
  return unit;
});

// Write back to units.json
writeFileSync(
  join(__dirname, "../src/game/data/units.json"),
  JSON.stringify(scaledUnits, null, 2),
  "utf8",
);

console.log("\n✅ Units scaled and written to units.json");
