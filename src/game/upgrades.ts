import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingDefinition,
  type BuildingKey,
} from "./buildings";
import {
  capacityMultiplierBonus,
  costReductionBonus,
  resourceBonus,
  type Bonus,
} from "./bonus";
import type { ResourceKey } from "./resources";

/** Unlock conditions for upgrades (AGENTS.md §13.4). Sources own their id lists. */
export type UpgradeUnlock =
  | { source: "building-capacity"; building: BuildingKey; ratio: number }
  | { source: "building-count"; building: BuildingKey; threshold: number };

/** A one-shot purchase that permanently applies its bonuses (limit of one). */
export class UpgradeDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly costs: BuildingCost[];
  readonly bonuses: Bonus[];
  readonly unlock: UpgradeUnlock;

  constructor(
    key: string,
    name: string,
    description: string,
    costs: BuildingCost[],
    bonuses: Bonus[],
    unlock: UpgradeUnlock,
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.costs = costs;
    this.bonuses = bonuses;
    this.unlock = unlock;
  }
}

type EnhancerTarget = {
  building: BuildingDefinition;
  resource: ResourceKey;
  label: string;
};

const enhancerBuilding = (key: BuildingKey): BuildingDefinition => {
  const building = buildingDefinitions.find(
    ({ key: buildingKey }) => buildingKey === key,
  );
  if (!building) throw new Error(`Unknown enhancer building: ${key}`);
  return building;
};

const enhancerTargets: EnhancerTarget[] = [
  { building: enhancerBuilding("farm"), resource: "food", label: "Farm" },
  {
    building: enhancerBuilding("lumber-yard"),
    resource: "wood",
    label: "Lumber Yard",
  },
  { building: enhancerBuilding("quarry"), resource: "stone", label: "Quarry" },
  {
    building: enhancerBuilding("gold-mine"),
    resource: "gold",
    label: "Gold Mine",
  },
];

/** Building counts at which each enhancer tier unlocks (98% of the previous ×10 step). */
const ENHANCER_TIERS = [
  10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000,
];
const ROMAN_NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/**
 * Rough placeholder costing (§13 — the Balance agent should revisit): each tier costs
 * about two minutes of the affected resource's production at the moment it unlocks.
 * At that point the building sits at 98% of its capacity, so its own multiplier is
 * 1.1^(0.98 × threshold) and every previous tier has doubled production once. The
 * worker-pool assumption (food ~90 workers, others ~9) matches the current housing
 * ceiling (houseCapacity ≤ 110), which is what production actually scales with.
 */
const PRODUCTION_SECONDS = 120;
const METALWORK_GATE_TIER = 3; // thresholds from 1000 on also cost metalwork
const METALWORK_PLACEHOLDER_COST = ExpNumber.fromNumber(1000);

const estimateWorkers = (resource: ResourceKey): number =>
  resource === "food" ? 90 : 9;

const enhancerCosts = (
  building: BuildingDefinition,
  tierIndex: number,
): BuildingCost[] => {
  const threshold = ENHANCER_TIERS[tierIndex];
  const scale = ExpNumber.fromNumber(1.1)
    .pow(threshold * 0.98)
    .mul(ExpNumber.fromNumber(2).pow(tierIndex));
  const costs: BuildingCost[] = building.costs.map(({ resource }) => ({
    resource,
    base: ExpNumber.fromNumber(PRODUCTION_SECONDS * estimateWorkers(resource))
      .mul(scale)
      .ceil(),
    factor: 1,
  }));
  if (tierIndex + 1 >= METALWORK_GATE_TIER) {
    costs.push({
      resource: "metalwork",
      base: METALWORK_PLACEHOLDER_COST,
      factor: 1,
    });
  }
  return costs;
};

/** Tiers 3–5 halve their building's cost (compounding to ÷8); tiers 6+ flatten its growth factor. */
const enhancerBonuses = (
  building: BuildingDefinition,
  resource: ResourceKey,
  tierIndex: number,
): Bonus[] => {
  const threshold = ENHANCER_TIERS[tierIndex];
  const bonuses: Bonus[] = [
    capacityMultiplierBonus(building.key, 10),
    resourceBonus("resourceMultiplier", resource, 2),
  ];
  if (threshold >= 1_000 && threshold < 1_000_000) {
    bonuses.push(costReductionBonus("costReductionPercent", building.key, 0.5));
  } else if (threshold >= 1_000_000) {
    bonuses.push(costReductionBonus("costReductionFactor", building.key, 0.01));
  }
  return bonuses;
};

const enhancerDescription = (
  label: string,
  resource: ResourceKey,
  tierIndex: number,
): string => {
  const threshold = ENHANCER_TIERS[tierIndex];
  const costEffect =
    threshold >= 1_000 && threshold < 1_000_000
      ? `, ${label} cost −50%`
      : threshold >= 1_000_000
        ? `, ${label} growth factor −0.01`
        : "";
  return `${label}: capacity ×10 and ${resource} production ×2${costEffect}.`;
};

const enhancerUpgrades = enhancerTargets.flatMap(({ building, resource, label }) =>
  ENHANCER_TIERS.map((threshold, tierIndex) => {
    const roman = ROMAN_NUMERALS[tierIndex];
    return new UpgradeDefinition(
      `${building.key}-enhancer-${threshold}`,
      `Enhanced ${label} ${roman}`,
      enhancerDescription(label, resource, tierIndex),
      enhancerCosts(building, tierIndex),
      enhancerBonuses(building, resource, tierIndex),
      { source: "building-capacity", building: building.key, ratio: 0.98 },
    );
  }),
);

export const upgradeDefinitions: UpgradeDefinition[] = [...enhancerUpgrades];