#!/usr/bin/env node

/**
 * Scale units by age using conservative multipliers
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load units data
const unitsData = JSON.parse(readFileSync(join(__dirname, '../src/game/data/units.json'), 'utf8'));

// Conservative scaling by age
const ageScaling = {
  0: 1.0,   // No scaling for age 0
  1: 1.1,   // 10% boost for age 1
  2: 1.2,   // 20% boost for age 2
  3: 1.4,   // 40% boost for age 3
  4: 1.6,   // 60% boost for age 4
  5: 2.0,   // 100% boost for age 5
  6: 2.5,   // 150% boost for age 6
};

// Apply scaling to units
const scaledUnits = unitsData.map(unit => {
  const scale = ageScaling[unit.age] || 1.0;
  
  // Only scale if scale > 1 and unit has costs (player-buyable)
  if (scale > 1.0 && unit.costs && unit.costs.length > 0) {
    const scaledUnit = {
      ...unit,
      hp: Math.round(unit.hp * scale),
      attack: Math.round(unit.attack * scale)
    };
    
    console.log(`${unit.name} (age ${unit.age}): scale=${scale.toFixed(2)}, hp: ${unit.hp} -> ${scaledUnit.hp}, attack: ${unit.attack} -> ${scaledUnit.attack}`);
    
    return scaledUnit;
  }
  
  console.log(`${unit.name} (age ${unit.age}): no scaling (scale=1.0)`);
  return unit;
});

// Write back to units.json
writeFileSync(
  join(__dirname, '../src/game/data/units.json'),
  JSON.stringify(scaledUnits, null, 2),
  'utf8'
);

console.log('\n✅ Units scaled by age and written to units.json');