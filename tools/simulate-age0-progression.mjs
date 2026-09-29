#!/usr/bin/env node

/**
 * Extract Age 0 building progression from actual cheapest strategy simulation
 * Uses sim-output/sim/sim-cheapest.csv to get real building counts and production
 * rates. Both paths live under the gitignored `sim-output/` folder.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load simulation CSV
const csvData = readFileSync(
  join(__dirname, "../sim-output/sim/sim-cheapest.csv"),
  "utf8",
);
const lines = csvData.trim().split("\n");

// Header mapping for buildings (column indices are 1-based)
const buildingColumns = {
  farm: { count: 8, production: 10, red_factor: 53, scale_factor: 56 },
  "lumber-yard": {
    count: 11,
    production: 13,
    red_factor: 60,
    scale_factor: 63,
  },
  quarry: { count: 14, production: 16, red_factor: 67, scale_factor: 70 },
  "gold-mine": { count: 17, production: 19, red_factor: 74, scale_factor: 77 },
  "town-hall": {
    count: null,
    production: null,
    red_factor: 81,
    scale_factor: 84,
  }, // town-hall has no count/production in this CSV
  barracks: { count: 20, production: 22, red_factor: 88, scale_factor: 91 },
  university: { count: 23, production: 25, red_factor: 95, scale_factor: 98 },
  smithy: { count: 26, production: 28, red_factor: 102, scale_factor: 105 },
  market: { count: 29, production: 31, red_factor: 109, scale_factor: 112 },
};

// Stage checkpoints based on battles_won (column 7)
// Using the last row BEFORE each battle transition
const stages = {
  BEFORE_BATTLE_1: 18, // Row 18: last row with battles_won = 0
  BEFORE_BATTLE_2: 47, // Row 47: last row with battles_won = 1
  BEFORE_BATTLE_3: 60, // Row 60: last row with battles_won = 2
  END_OF_AGE_0: 62, // Row 62: final row, battles_won = 3
};

// Parse CSV row
function parseRow(line) {
  return line.split(",");
}

// Extract production rate from field (direct numeric value)
function extractProductionRate(productionStr) {
  if (!productionStr || productionStr === "") return 0;
  // The production field shows the actual total production rate for all buildings of this type
  // It's a numeric value like "18739.8" or "2.48112e+7"
  const value = parseFloat(productionStr);
  return isNaN(value) ? 0 : value;
}

// Extract scale factor (may have multiple values like "8|8", take first)
function extractScaleFactor(scaleStr) {
  if (!scaleStr || scaleStr === "") return 1;
  const parts = scaleStr.split("|");
  const value = parseFloat(parts[0]);
  return isNaN(value) ? 1 : value;
}

// Generate CSV from simulation data
function generateCSV() {
  const buildings = [
    "farm",
    "lumber-yard",
    "quarry",
    "gold-mine",
    "town-hall",
    "barracks",
    "university",
    "smithy",
    "market",
  ];

  let csv =
    "Stage,Building,Reduction Factor,Prod Boost,Scale Factor,Building Count,Production\n";

  for (const [stageName, rowIndex] of Object.entries(stages)) {
    const row = parseRow(lines[rowIndex - 1]); // 0-indexed array

    for (const building of buildings) {
      const cols = buildingColumns[building];

      // Extract values from CSV
      const buildingCount = cols.count
        ? parseFloat(row[cols.count - 1]) || 0
        : 1; // town-hall always has 1
      const reductionFactor = cols.red_factor
        ? parseFloat(row[cols.red_factor - 1]) || 1
        : 1;
      const scaleFactor = cols.scale_factor
        ? extractScaleFactor(row[cols.scale_factor - 1])
        : 1;

      // Production field - this is the actual total production rate for all buildings of this type
      const productionStr = cols.production ? row[cols.production - 1] : "";
      const productionRate = extractProductionRate(productionStr);

      // Prod Boost = productionRate / (baseRate * buildingCount)
      // Base rate is 1 for all production buildings
      const baseRate = 1;
      const prodBoost =
        buildingCount > 0 ? productionRate / (baseRate * buildingCount) : 1.0;

      csv += `${stageName},${building},${reductionFactor.toFixed(4)},${prodBoost.toFixed(2)},${scaleFactor.toFixed(2)},${buildingCount},${productionRate.toFixed(2)}\n`;
    }
  }

  return csv;
}

// Write CSV file
const csv = generateCSV();
const outputPath = join(__dirname, "../sim-output/age_0_building_progression.csv");
import { writeFileSync } from "fs";
writeFileSync(outputPath, csv, "utf8");

console.log(
  "✅ CSV generated from simulation data: sim-output/age_0_building_progression.csv",
);
console.log("\nRows extracted from sim-cheapest.csv:");
console.log("- BEFORE_BATTLE_1: row 18 (last row with battles_won=0)");
console.log("- BEFORE_BATTLE_2: row 47 (last row with battles_won=1)");
console.log("- BEFORE_BATTLE_3: row 60 (last row with battles_won=2)");
console.log("- END_OF_AGE_0: row 62 (final row, battles_won=3)");
console.log("\n" + csv);
