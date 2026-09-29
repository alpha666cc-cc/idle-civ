/**
 * Analyze all bonuses for Age 2 (Classical Age)
 * Starting point: 120 production buildings (primary), 220 advanced production buildings
 * Ending point: 1200 production buildings (primary)
 */

import { upgradeDefinitions } from "../src/game/upgrades.js";
import { encounterDefinitions } from "../src/game/encounters.js";
import { ageDefinitions } from "../src/game/ages.js";

interface BonusEntry {
  stage: string;
  category: string;
  source: string;
  type: string;
  destination: string;
  value: number | string;
  cumulativeEffect: string;
  notes: string;
}

const entries: BonusEntry[] = [];

// Helper to add entries
function addEntry(
  stage: string,
  category: string,
  source: string,
  type: string,
  destination: string,
  value: number | string,
  cumulativeEffect: string,
  notes: string
) {
  entries.push({
    stage,
    category,
    source,
    type,
    destination,
    value,
    cumulativeEffect,
    notes,
  });
}

// Get Age 2 definition
const age2 = ageDefinitions.find((age) => age.key === "age2");
if (!age2) {
  console.error("Age 2 not found");
  process.exit(1);
}

// START OF AGE 2
addEntry(
  "START_OF_AGE_2",
  "Age Bonus",
  "Age 2 (Classical)",
  "attributeMultiplier",
  "town-hallCapacity",
  "1",
  "×1",
  "No age bonus for capacity"
);
addEntry(
  "START_OF_AGE_2",
  "Age Bonus",
  "Age 2 (Classical)",
  "attributeMultiplier",
  "buildingPower",
  "1",
  "×1",
  "No age bonus for building power"
);

// Carry over from Age 1 end
addEntry(
  "START_OF_AGE_2",
  "Carryover",
  "Age 1 End",
  "attributeMultiplier",
  "town-hallCapacity",
  "200",
  "×200",
  "10 (age0) × 2 (age1) × 10 (battles)"
);
addEntry(
  "START_OF_AGE_2",
  "Carryover",
  "Age 1 End",
  "attributeMultiplier",
  "buildingPower",
  "3",
  "×3",
  "2 (age0) × 1.5 (age1)"
);

// Track cumulative multipliers
let cumulativeFood = 1280; // From Age 0 end
let cumulativeWood = 32;
let cumulativeStone = 40;
let cumulativeGold = 16;
let cumulativeScience = 40;
let cumulativeMilitary = 72;
let cumulativeMetalwork = 12;
let cumulativeBuildingPower = 3;

// Upgrade thresholds for Age 2 range (120-1200 for primary, 220 for advanced)
// Primary production buildings: farm, lumber-yard, quarry, gold-mine
// Advanced production buildings: barracks, university, smithy, market

// Analyze upgrades for primary buildings in the 120-1200 range
const primaryBuildings = ["farm", "lumberYard", "quarry", "goldMine"];
const advancedBuildings = ["barracks", "university", "smithy", "market"];

// Primary building upgrades (tier 1: threshold 98, tier 2: threshold 980)
// Note: tier 0 (threshold 9) is below 120, tier 1 (98) is below 120
// So we start with tier 2 (threshold 980) which is in range

for (const building of primaryBuildings) {
  const buildingKey = building as
    | "farm"
    | "lumberYard"
    | "quarry"
    | "goldMine";

  // Tier 2 (threshold 980) - this is in range 120-1200
  const tier2Upgrade = upgradeDefinitions.find(
    (u) => u.building === buildingKey && u.threshold === 980
  );

  if (tier2Upgrade) {
    for (const bonus of tier2Upgrade.bonuses) {
      if (bonus.type === "attributeMultiplier") {
        if (bonus.destination === `${buildingKey}Capacity`) {
          addEntry(
            "UPGRADE_TIER_2",
            "Upgrade",
            tier2Upgrade.name,
            "attributeMultiplier",
            bonus.destination,
            bonus.value,
            `×${Number(bonus.value) * 10}`,
            `Capacity +${bonus.value}×`
          );
        } else if (bonus.destination === tier2Upgrade.resource) {
          // Cumulative effect
          let currentCumulative = 1;
          if (buildingKey === "farm") currentCumulative = cumulativeFood;
          else if (buildingKey === "lumberYard") currentCumulative = cumulativeWood;
          else if (buildingKey === "quarry") currentCumulative = cumulativeStone;
          else if (buildingKey === "goldMine") currentCumulative = cumulativeGold;

          const newCumulative = currentCumulative * Number(bonus.value);
          addEntry(
            "UPGRADE_TIER_2",
            "Upgrade",
            tier2Upgrade.name,
            "attributeMultiplier",
            bonus.destination,
            bonus.value,
            `×${newCumulative}`,
            `Cumulative: ${currentCumulative}×${bonus.value}`
          );

          // Update cumulative
          if (buildingKey === "farm") cumulativeFood = newCumulative;
          else if (buildingKey === "lumberYard") cumulativeWood = newCumulative;
          else if (buildingKey === "quarry") cumulativeStone = newCumulative;
          else if (buildingKey === "goldMine") cumulativeGold = newCumulative;
        }
      } else if (bonus.type === "attributeFlat") {
        cumulativeBuildingPower += Number(bonus.value);
        addEntry(
          "UPGRADE_TIER_2",
          "Upgrade",
          tier2Upgrade.name,
          "attributeFlat",
          bonus.destination,
          bonus.value,
          `+${bonus.value}`,
          "Building power increase"
        );
      } else if (bonus.type === "costReductionPercent") {
        addEntry(
          "UPGRADE_TIER_2",
          "Upgrade",
          tier2Upgrade.name,
          "costReductionPercent",
          bonus.destination,
          bonus.value,
          `×${Number(bonus.value)}`,
          "Cost reduction"
        );
      }
    }
  }
}

// Advanced building upgrades at threshold 220
// Check if there are upgrades at or near 220 (tier 2 is 980, tier 1 is 98)
// For advanced buildings, we assume they start at 220 and can reach tier 2 (980)
// But 980 is beyond 220, so only tier 1 (98) might be accessible if it's <= 220

for (const building of advancedBuildings) {
  const buildingKey = building as
    | "barracks"
    | "university"
    | "smithy"
    | "market";

  // Tier 1 (threshold 98) - accessible from 220
  const tier1Upgrade = upgradeDefinitions.find(
    (u) => u.building === buildingKey && u.threshold === 98
  );

  if (tier1Upgrade) {
    for (const bonus of tier1Upgrade.bonuses) {
      if (bonus.type === "attributeMultiplier") {
        if (bonus.destination === `${buildingKey}Capacity`) {
          addEntry(
            "UPGRADE_TIER_1",
            "Upgrade",
            tier1Upgrade.name,
            "attributeMultiplier",
            bonus.destination,
            bonus.value,
            `×${Number(bonus.value) * 10}`,
            `Capacity +${bonus.value}×`
          );
        } else if (bonus.destination === tier1Upgrade.resource) {
          let currentCumulative = 1;
          if (buildingKey === "barracks") currentCumulative = cumulativeMilitary;
          else if (buildingKey === "university") currentCumulative = cumulativeScience;
          else if (buildingKey === "smithy") currentCumulative = cumulativeMetalwork;
          else if (buildingKey === "market") currentCumulative = 1; // Trade not tracked yet

          const newCumulative = currentCumulative * Number(bonus.value);
          addEntry(
            "UPGRADE_TIER_1",
            "Upgrade",
            tier1Upgrade.name,
            "attributeMultiplier",
            bonus.destination,
            bonus.value,
            `×${newCumulative}`,
            `Cumulative: ${currentCumulative}×${bonus.value}`
          );

          // Update cumulative
          if (buildingKey === "barracks") cumulativeMilitary = newCumulative;
          else if (buildingKey === "university") cumulativeScience = newCumulative;
          else if (buildingKey === "smithy") cumulativeMetalwork = newCumulative;
        }
      } else if (bonus.type === "attributeFlat") {
        cumulativeBuildingPower += Number(bonus.value);
        addEntry(
          "UPGRADE_TIER_1",
          "Upgrade",
          tier1Upgrade.name,
          "attributeFlat",
          bonus.destination,
          bonus.value,
          `+${bonus.value}`,
          "Building power increase"
        );
      } else if (bonus.type === "costReductionPercent") {
        addEntry(
          "UPGRADE_TIER_1",
          "Upgrade",
          tier1Upgrade.name,
          "costReductionPercent",
          bonus.destination,
          bonus.value,
          `×${Number(bonus.value)}`,
          "Cost reduction"
        );
      }
    }
  }
}

// Age 2 Battles
const age2Battles = encounterDefinitions.filter((e) => e.age === 2);
const battleOrder = ["age2_1_marathon", "age2_2_cannae", "age2_boss_gaugamela"];

for (let i = 0; i < battleOrder.length; i++) {
  const battleKey = battleOrder[i];
  const battle = age2Battles.find((b) => b.key === battleKey);
  if (!battle) continue;

  const stage = i === 0 ? "BEFORE_BATTLE_1" : i === 1 ? "BEFORE_BATTLE_2" : "BEFORE_BATTLE_3";

  for (const bonus of battle.bonuses) {
    if (bonus.type === "attributeMultiplier") {
      let currentCumulative = 1;
      if (bonus.destination === "military") currentCumulative = cumulativeMilitary;
      else if (bonus.destination === "unitAll.hp") currentCumulative = 1;
      else if (bonus.destination === "unitAll.attack") currentCumulative = 1;

      const newCumulative = currentCumulative * Number(bonus.value);
      addEntry(
        stage,
        "Battle Bonus",
        battle.name,
        "attributeMultiplier",
        bonus.destination,
        bonus.value,
        `×${newCumulative}`,
        `Cumulative: ${currentCumulative}×${bonus.value}`
      );

      // Update cumulative
      if (bonus.destination === "military") cumulativeMilitary = newCumulative;
    }
  }

  // After battle summary
  const afterStage = i === 0 ? "AFTER_BATTLE_1" : i === 1 ? "AFTER_BATTLE_2" : "AFTER_BATTLE_3";
  addEntry(
    afterStage,
    "Production Multiplier",
    "food",
    "Cumulative",
    "",
    "",
    `×${cumulativeFood}`,
    "From all sources"
  );
  addEntry(
    afterStage,
    "Production Multiplier",
    "wood",
    "Cumulative",
    "",
    "",
    `×${cumulativeWood}`,
    "From all sources"
  );
  addEntry(
    afterStage,
    "Production Multiplier",
    "stone",
    "Cumulative",
    "",
    "",
    `×${cumulativeStone}`,
    "From all sources"
  );
  addEntry(
    afterStage,
    "Production Multiplier",
    "gold",
    "Cumulative",
    "",
    "",
    `×${cumulativeGold}`,
    "From all sources"
  );
  addEntry(
    afterStage,
    "Production Multiplier",
    "science",
    "Cumulative",
    "",
    "",
    `×${cumulativeScience}`,
    "From all sources"
  );
  addEntry(
    afterStage,
    "Production Multiplier",
    "military",
    "Cumulative",
    "",
    "",
    `×${cumulativeMilitary}`,
    "From all sources"
  );
  addEntry(
    afterStage,
    "Production Multiplier",
    "metalwork",
    "Cumulative",
    "",
    "",
    `×${cumulativeMetalwork}`,
    "From all sources"
  );
}

// End of Age 2 summary
addEntry(
  "END_OF_AGE_2",
  "Production Multiplier",
  "food",
  "Cumulative",
  "",
  "",
  `×${cumulativeFood}`,
  "End of Age 2"
);
addEntry(
  "END_OF_AGE_2",
  "Production Multiplier",
  "wood",
  "Cumulative",
  "",
  "",
  `×${cumulativeWood}`,
  "End of Age 2"
);
addEntry(
  "END_OF_AGE_2",
  "Production Multiplier",
  "stone",
  "Cumulative",
  "",
  "",
  `×${cumulativeStone}`,
  "End of Age 2"
);
addEntry(
  "END_OF_AGE_2",
  "Production Multiplier",
  "gold",
  "Cumulative",
  "",
  "",
  `×${cumulativeGold}`,
  "End of Age 2"
);
addEntry(
  "END_OF_AGE_2",
  "Production Multiplier",
  "science",
  "Cumulative",
  "",
  "",
  `×${cumulativeScience}`,
  "End of Age 2"
);
addEntry(
  "END_OF_AGE_2",
  "Production Multiplier",
  "military",
  "Cumulative",
  "",
  "",
  `×${cumulativeMilitary}`,
  "End of Age 2"
);
addEntry(
  "END_OF_AGE_2",
  "Production Multiplier",
  "metalwork",
  "Cumulative",
  "",
  "",
  `×${cumulativeMetalwork}`,
  "End of Age 2"
);

// Output CSV
console.log("Stage,Category,Source,Type,Destination,Value,Cumulative Effect,Notes");
for (const entry of entries) {
  console.log(
    `${entry.stage},${entry.category},${entry.source},${entry.type},${entry.destination},${entry.value},${entry.cumulativeEffect},${entry.notes}`
  );
}
