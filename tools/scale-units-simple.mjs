#!/usr/bin/env node

/**
 * Simple script to apply conservative unit scaling
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

// Simple manual scaling based on unit tiers
const manualScaling = {
  // Age 0 units (no scaling)
  warrior: 1.0,
  slinger: 1.0,
  archer_prehist: 1.0,
  canoe: 1.0,

  // Age 0 bronze units (10% boost)
  spearman_bronze: 1.1,
  axeman_bronze: 1.1,
  chariot_bronze: 1.1,
  bowman_bronze: 1.1,
  trireme_bronze: 1.1,
  catapult_ancient: 1.1,

  // Age 1 iron units (20% boost)
  spearman_iron: 1.2,
  swordsman_iron: 1.2,
  chariot_iron: 1.2,
  cavalry_iron: 1.2,
  war_galley_iron: 1.2,
  elephant_iron: 1.2,
  ballista: 1.2,
  quinquereme: 1.2,

  // Age 2 classical units (30% boost)
  legionary: 1.3,
  hoplite: 1.3,
  companion: 1.3,
  archer_classical: 1.3,
  onager: 1.3,
  fire_ship: 1.3,
  assassin: 1.3,
  trader_classical: 1.3,

  // Age 3 medieval units (50% boost)
  knight: 1.5,
  longbow: 1.5,
  crossbow: 1.5,
  man_at_arms: 1.5,
  trebuchet: 1.5,
  cog: 1.5,
  longship: 1.5,

  // Age 4 renaissance units (75% boost)
  bombard_cannon: 1.75,
  caravel: 1.75,
  musketeer: 1.75,
  tercio_pikeman: 1.75,
  dragoon_renaissance: 1.75,
  cuirassier: 1.75,
  field_cannon: 1.75,
  galleon: 1.75,
  sailing_frigate: 1.75,
  privateer: 1.75,

  // Age 5 industrial units (100% boost)
  line_infantry: 2.0,
  rifleman: 2.0,
  dragoon_industrial: 2.0,
  lancer: 2.0,
  gatling: 2.0,
  ironclad: 2.0,
  zeppelin: 2.0,
  biplane: 2.0,
  howitzer: 2.0,
  early_submarine: 2.0,

  // Age 6 modern units (150% boost)
  ww1_infantry: 2.5,
  ww2_infantry: 2.5,
  dragoon_motorized: 2.5,
  sherman_tank: 2.5,
  p51_fighter: 2.5,
  b17_bomber: 2.5,
  battleship: 2.5,
  carrier_ww2: 2.5,
  modern_soldier: 2.5,
  abrams_tank: 2.5,
  f35_fighter: 2.5,
  burke_destroyer: 2.5,
  dragoon_armored: 2.5,
  reaper_drone: 2.5,
  apache_helicopter: 2.5,
  m270_mlrs: 2.5,
  nuclear_submarine: 2.5,
  nuclear_carrier: 2.5,
  special_forces: 2.5,
  stealth_bomber: 2.5,
  military_satellite: 2.5,
  orbital_laser: 2.5,
  mech_suit: 2.5,
  starship_trooper: 2.5,
};

// Apply scaling to units
const scaledUnits = unitsData.map((unit) => {
  const scale = manualScaling[unit.id] || 1.0;

  // Only scale if scale > 1
  if (scale > 1.0) {
    const scaledUnit = {
      ...unit,
      hp: Math.round(unit.hp * scale),
      attack: Math.round(unit.attack * scale),
    };

    console.log(
      `${unit.name}: scale=${scale.toFixed(2)}, hp: ${unit.hp} -> ${scaledUnit.hp}, attack: ${unit.attack} -> ${scaledUnit.attack}`,
    );

    return scaledUnit;
  }

  console.log(`${unit.name}: no scaling (scale=1.0)`);
  return unit;
});

// Write back to units.json
writeFileSync(
  join(__dirname, "../src/game/data/units.json"),
  JSON.stringify(scaledUnits, null, 2),
  "utf8",
);

console.log("\n✅ Units scaled and written to units.json");
