// Age 0 Building Progression Simulation
// Uses cheapest building strategy with achievement boosts

const buildings = {
  farm: {
    name: "farm",
    costs: [
      { resource: "food", base: 10, factor: 8 },
      { resource: "wood", base: 10, factor: 8 },
    ],
    effect: { resource: "food", perBuilding: 0.1 },
    power: 1,
  },
  "lumber-yard": {
    name: "lumber-yard",
    costs: [
      { resource: "wood", base: 10, factor: 8 },
      { resource: "stone", base: 5, factor: 8 },
    ],
    effect: { resource: "wood", perBuilding: 0.1 },
    power: 1,
  },
  quarry: {
    name: "quarry",
    costs: [{ resource: "stone", base: 20, factor: 8 }],
    effect: { resource: "stone", perBuilding: 0.1 },
    power: 1,
  },
  "gold-mine": {
    name: "gold-mine",
    costs: [
      { resource: "wood", base: 100, factor: 8 },
      { resource: "stone", base: 50, factor: 8 },
    ],
    effect: { resource: "gold", perBuilding: 0.1 },
    power: 1,
  },
  "town-hall": {
    name: "town-hall",
    costs: [
      { resource: "wood", base: 10000, factor: 15 },
      { resource: "stone", base: 7500, factor: 15 },
      { resource: "gold", base: 12500, factor: 15 },
    ],
    effect: null,
    power: null,
    maxCount: 1,
  },
  barracks: {
    name: "barracks",
    costs: [
      { resource: "wood", base: 10000, factor: 10 },
      { resource: "stone", base: 1000, factor: 12 },
      { resource: "food", base: 5000, factor: 10 },
    ],
    effect: { resource: "military", perBuilding: 0.05, production: 1 },
    power: 1,
  },
  university: {
    name: "university",
    costs: [
      { resource: "wood", base: 10000, factor: 10 },
      { resource: "stone", base: 10000, factor: 12 },
      { resource: "gold", base: 7500, factor: 10 },
    ],
    effect: { resource: "science", perBuilding: 0.05, production: 1 },
    power: 1,
  },
  smithy: {
    name: "smithy",
    costs: [
      { resource: "wood", base: 1000000, factor: 12 },
      { resource: "stone", base: 1000000, factor: 12 },
    ],
    effect: { resource: "metalwork", perBuilding: 0.05, production: 1 },
    power: 1,
  },
};

// Age 0 researches (from research.json)
const researches = {
  agriculture: {
    bonuses: [
      { type: "attributeMultiplier", destination: "food", value: 2 },
      { type: "costReductionPercent", destination: "farm", value: 0.5 },
    ],
  },
  pottery: {
    bonuses: [
      { type: "costReductionPercent", destination: "house", value: 0.5 },
      { type: "attributeMultiplier", destination: "food", value: 2 },
    ],
  },
  sling_throwing: {
    bonuses: [{ type: "attributeMultiplier", destination: "food", value: 2 }],
  },
  writing: {
    bonuses: [
      { type: "attributeMultiplier", destination: "science", value: 10 },
      {
        type: "costReductionPercent",
        destination: "all-buildings",
        value: 0.5,
      },
    ],
  },
  animal_husbandry: {
    bonuses: [
      { type: "attributeMultiplier", destination: "food", value: 2 },
      { type: "attributeMultiplier", destination: "wood", value: 2 },
    ],
  },
  mining: {
    bonuses: [
      { type: "attributeMultiplier", destination: "stone", value: 2 },
      { type: "attributeMultiplier", destination: "gold", value: 2 },
    ],
  },
  stone_working: {
    bonuses: [
      {
        type: "costReductionPercent",
        destination: "all-buildings",
        value: 0.5,
      },
      { type: "attributeMultiplier", destination: "stone", value: 10 },
    ],
  },
  forestry: {
    bonuses: [
      { type: "attributeMultiplier", destination: "wood", value: 2 },
      {
        type: "costReductionPercent",
        destination: "all-buildings",
        value: 0.5,
      },
    ],
  },
  weaving: {
    bonuses: [
      { type: "attributeMultiplier", destination: "gold", value: 2 },
      { type: "attributeMultiplier", destination: "food", value: 2 },
    ],
  },
  calendar: {
    bonuses: [
      { type: "attributeMultiplier", destination: "food", value: 2 },
      {
        type: "costReductionPercent",
        destination: "all-buildings",
        value: 0.5,
      },
    ],
  },
  city_planning: {
    bonuses: [
      {
        type: "costReductionPercent",
        destination: "all-buildings",
        value: 0.5,
      },
      { type: "attributeMultiplier", destination: "all-production", value: 2 },
    ],
  },
  tribal_organization: {
    bonuses: [
      { type: "attributeMultiplier", destination: "military", value: 2 },
    ],
  },
};

// Achievements
const achievements = {
  "growing-hamlet": {
    requirement: { type: "population", amount: 25 },
    bonuses: [{ type: "attributeMultiplier", destination: "food", value: 2 }],
  },
  "mustering-village": {
    requirement: { type: "population", amount: 100 },
    bonuses: [
      { type: "attributeMultiplier", destination: "military", value: 2 },
    ],
  },
  "wolf-slayer": {
    requirement: { type: "encounter", encounterId: "age0_1_first_fire" },
    bonuses: [
      { type: "attributeMultiplier", destination: "food", value: 4 },
      { type: "attributeMultiplier", destination: "wood", value: 2 },
    ],
  },
};

// Battle bonuses (from encounters.json)
const battleBonuses = {
  age0_1_first_fire: {
    bonuses: [
      { type: "attributeMultiplier", destination: "military", value: 1.5 },
      {
        type: "attributeMultiplier",
        destination: "town-hallCapacity",
        value: 2,
      },
      {
        type: "attributeMultiplier",
        destination: "barracksCapacity",
        value: 2,
      },
    ],
  },
  age0_2_wolf_pack: {
    bonuses: [
      { type: "attributeMultiplier", destination: "military", value: 1.5 },
      {
        type: "attributeMultiplier",
        destination: "town-hallCapacity",
        value: 5,
      },
      { type: "attributeMultiplier", destination: "wood", value: 4 },
      { type: "attributeMultiplier", destination: "science", value: 2 },
    ],
  },
  age0_3_bronze_raid: {
    bonuses: [
      { type: "attributeMultiplier", destination: "military", value: 2 },
      { type: "attributeMultiplier", destination: "metalwork", value: 3 },
      { type: "attributeMultiplier", destination: "smithyCapacity", value: 2 },
    ],
  },
  age0_boss_troy: {
    bonuses: [
      { type: "attributeMultiplier", destination: "military", value: 4 },
      { type: "attributeMultiplier", destination: "metalwork", value: 4 },
      {
        type: "attributeMultiplier",
        destination: "universityCapacity",
        value: 2,
      },
    ],
  },
};

// Age bonuses
const ageBonuses = {
  "age-0": {
    bonuses: [
      {
        type: "attributeMultiplier",
        destination: "town-hallCapacity",
        value: 10,
      },
      { type: "attributeMultiplier", destination: "buildingPower", value: 2 },
    ],
  },
};

// Helper function to calculate building cost using the sqrt formula
// T(n) = base * (factor^sqrt(n) - 1)
function calculateBuildingCost(building, count, costReductions = {}) {
  const totalCost = {};
  for (const cost of building.costs) {
    const resource = cost.resource;
    let base = cost.base;
    let factor = cost.factor;

    // Apply cost reductions
    if (costReductions[building.name]) {
      base *= 1 - costReductions[building.name];
    }
    if (costReductions["all-buildings"]) {
      base *= 1 - costReductions["all-buildings"];
    }

    // T(n) = base * (factor^sqrt(n) - 1)
    const total = base * (Math.pow(factor, Math.sqrt(count)) - 1);
    totalCost[resource] = Math.ceil(total);
  }
  return totalCost;
}

// Helper function to calculate production from buildings
function calculateProduction(buildingCounts, bonuses) {
  const production = {
    food: 0,
    wood: 0,
    stone: 0,
    gold: 0,
    military: 0,
    science: 0,
    metalwork: 0,
  };

  // Calculate resource multipliers from bonuses
  const resourceMultipliers = {
    food: 1,
    wood: 1,
    stone: 1,
    gold: 1,
    military: 1,
    science: 1,
    metalwork: 1,
  };

  // Age bonus: buildingPower x2
  const buildingPowerBonus = bonuses.buildingPower || 1;

  for (const bonus of bonuses.bonuses) {
    if (bonus.type === "attributeMultiplier") {
      if (bonus.destination === "all-production") {
        for (const key of Object.keys(resourceMultipliers)) {
          resourceMultipliers[key] *= bonus.value;
        }
      } else if (resourceMultipliers.hasOwnProperty(bonus.destination)) {
        resourceMultipliers[bonus.destination] *= bonus.value;
      }
    }
  }

  // Calculate base production from buildings
  for (const [buildingKey, count] of Object.entries(buildingCounts)) {
    const building = buildings[buildingKey];
    if (building.effect && count > 0) {
      const resource = building.effect.resource;
      const buildingPower = building.power || 1;
      const effectivePower = buildingPower * buildingPowerBonus;

      // Additive multiplier: count * perBuilding * effectivePower
      const additive = count * building.effect.perBuilding * effectivePower;

      // Base production: count * production * effectivePower
      const productionAmount =
        (building.effect.production || 0) * count * effectivePower;

      // Total = base production + (additive * resource multiplier)
      production[resource] +=
        productionAmount + additive * resourceMultipliers[resource];
    }
  }

  return production;
}

// Helper function to get cost reduction factor
function getCostReductionFactor(researchKeys, buildingKey) {
  let reduction = 0;
  for (const key of researchKeys) {
    const research = researches[key];
    if (research) {
      for (const bonus of research.bonuses) {
        if (bonus.type === "costReductionPercent") {
          if (
            bonus.destination === buildingKey ||
            bonus.destination === "all-buildings"
          ) {
            reduction += bonus.value;
          }
        }
      }
    }
  }
  return reduction;
}

// Helper function to collect all bonuses
function collectBonuses(researchKeys, achievementKeys, battleKeys, ageKey) {
  const bonuses = {
    bonuses: [],
    buildingPower: 1,
  };

  // Age bonuses
  if (ageKey && ageBonuses[ageKey]) {
    bonuses.bonuses.push(...ageBonuses[ageKey].bonuses);
  }

  // Research bonuses
  for (const key of researchKeys) {
    const research = researches[key];
    if (research) {
      bonuses.bonuses.push(...research.bonuses);
    }
  }

  // Achievement bonuses
  for (const key of achievementKeys) {
    const achievement = achievements[key];
    if (achievement) {
      bonuses.bonuses.push(...achievement.bonuses);
    }
  }

  // Battle bonuses
  for (const key of battleKeys) {
    const battle = battleBonuses[key];
    if (battle) {
      bonuses.bonuses.push(...battle.bonuses);
    }
  }

  // Extract buildingPower bonus
  for (const bonus of bonuses.bonuses) {
    if (
      bonus.type === "attributeMultiplier" &&
      bonus.destination === "buildingPower"
    ) {
      bonuses.buildingPower = bonus.value;
    }
  }

  return bonuses;
}

// Simulation stages
const stages = [
  {
    name: "BEFORE_BATTLE_1",
    researchKeys: [],
    achievementKeys: [],
    battleKeys: [],
    ageKey: "age-0",
    description: "Only age bonuses, no research, no achievements",
  },
  {
    name: "BEFORE_BATTLE_2",
    researchKeys: ["agriculture", "pottery", "sling_throwing", "writing"],
    achievementKeys: ["growing-hamlet"],
    battleKeys: [],
    ageKey: "age-0",
    description: "Basic research + growing-hamlet achievement",
  },
  {
    name: "BEFORE_BATTLE_3",
    researchKeys: [
      "agriculture",
      "pottery",
      "sling_throwing",
      "writing",
      "animal_husbandry",
      "mining",
      "stone_working",
      "forestry",
      "weaving",
      "calendar",
      "city_planning",
      "tribal_organization",
    ],
    achievementKeys: ["growing-hamlet", "mustering-village", "wolf-slayer"],
    battleKeys: ["age0_1_first_fire", "age0_2_wolf_pack"],
    ageKey: "age-0",
    description: "Half researches + more achievements + 2 battles",
  },
  {
    name: "END_OF_AGE_0",
    researchKeys: Object.keys(researches),
    achievementKeys: ["growing-hamlet", "mustering-village", "wolf-slayer"],
    battleKeys: [
      "age0_1_first_fire",
      "age0_2_wolf_pack",
      "age0_3_bronze_raid",
      "age0_boss_troy",
    ],
    ageKey: "age-0",
    description: "All researches + all achievements + boss battle",
  },
];

// Simulate cheapest building strategy for each stage
function simulateStage(stage) {
  const bonuses = collectBonuses(
    stage.researchKeys,
    stage.achievementKeys,
    stage.battleKeys,
    stage.ageKey,
  );
  const costReductions = {};

  // Calculate cost reductions for each building
  for (const buildingKey of Object.keys(buildings)) {
    costReductions[buildingKey] = getCostReductionFactor(
      stage.researchKeys,
      buildingKey,
    );
  }
  costReductions["all-buildings"] = getCostReductionFactor(
    stage.researchKeys,
    "all-buildings",
  );

  // Start with basic resources (simulate having enough to build)
  // Use cheapest strategy: prioritize buildings with lowest total cost
  const buildingCounts = {
    farm: 0,
    "lumber-yard": 0,
    quarry: 0,
    "gold-mine": 0,
    "town-hall": 0,
    barracks: 0,
    university: 0,
    smithy: 0,
  };

  // For simulation, we'll build up to reasonable limits based on stage
  // Early stages: focus on primary production buildings
  // Later stages: add advanced buildings

  const maxBuildings = {
    farm:
      stage.name === "END_OF_AGE_0"
        ? 10
        : stage.name === "BEFORE_BATTLE_3"
          ? 8
          : 5,
    "lumber-yard":
      stage.name === "END_OF_AGE_0"
        ? 10
        : stage.name === "BEFORE_BATTLE_3"
          ? 8
          : 5,
    quarry:
      stage.name === "END_OF_AGE_0"
        ? 10
        : stage.name === "BEFORE_BATTLE_3"
          ? 8
          : 5,
    "gold-mine":
      stage.name === "END_OF_AGE_0"
        ? 10
        : stage.name === "BEFORE_BATTLE_3"
          ? 5
          : 2,
    "town-hall": stage.name === "END_OF_AGE_0" ? 1 : 0,
    barracks:
      stage.name === "END_OF_AGE_0"
        ? 10
        : stage.name === "BEFORE_BATTLE_3"
          ? 5
          : 0,
    university:
      stage.name === "END_OF_AGE_0"
        ? 10
        : stage.name === "BEFORE_BATTLE_3"
          ? 5
          : 0,
    smithy: stage.name === "END_OF_AGE_0" ? 10 : 0,
  };

  // Build in cheapest order
  const buildingOrder = Object.keys(buildings).sort((a, b) => {
    const costA = calculateBuildingCost(buildings[a], 1, costReductions);
    const costB = calculateBuildingCost(buildings[b], 1, costReductions);
    const totalA = Object.values(costA).reduce((sum, v) => sum + v, 0);
    const totalB = Object.values(costB).reduce((sum, v) => sum + v, 0);
    return totalA - totalB;
  });

  for (const buildingKey of buildingOrder) {
    const max = maxBuildings[buildingKey];
    for (let i = 0; i < max; i++) {
      buildingCounts[buildingKey]++;
    }
  }

  // Calculate production
  const production = calculateProduction(buildingCounts, bonuses);

  // Generate CSV rows for this stage
  const rows = [];
  for (const buildingKey of Object.keys(buildings)) {
    const building = buildings[buildingKey];
    const count = buildingCounts[buildingKey];
    const reduction =
      costReductions[buildingKey] + costReductions["all-buildings"];
    const scaleFactor = 1; // No achievement-based scale factors in Age 0

    // Calculate production boost for this building
    let prodBoost = 0;
    if (building.effect) {
      const resource = building.effect.resource;
      prodBoost = production[resource] / (count > 0 ? count : 1);
    }

    rows.push({
      Stage: stage.name,
      Building: buildingKey,
      "Reduction Factor": reduction.toFixed(3),
      "Scale Factor": scaleFactor.toFixed(3),
      "Prod Boost": prodBoost.toFixed(3),
      "# Buildings": count,
      Production: building.effect
        ? production[building.effect.resource].toFixed(3)
        : "N/A",
    });
  }

  return rows;
}

// Generate CSV
console.log(
  "Stage,Building,Reduction Factor,Scale Factor,Prod Boost,# Buildings,Production",
);
for (const stage of stages) {
  const rows = simulateStage(stage);
  for (const row of rows) {
    console.log(
      `${row.Stage},${row.Building},${row["Reduction Factor"]},${row["Scale Factor"]},${row["Prod Boost"]},${row["# Buildings"]},${row.Production}`,
    );
  }
}
