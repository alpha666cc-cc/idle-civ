import { buildingDefinitions } from "./buildings";
import statData from "./data/stats.json";
import derivedDefaults from "./data/derivedDefaults.json";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";

/**
 * Default values for derived attributes, read from JSON.
 * Building powers use their definition's power field instead.
 */
export const getDerivedAttributeDefault = (key: string): number => {
  const defaults = derivedDefaults as Record<string, number>;
  return defaults[key] ?? 1;
};

/**
 * Attribute families (AGENTS.md §13.2): every value a bonus destination can name on
 * the value side. Amounts are stored and accrue per tick; capacities are stored
 * maxima whose effective value multiplies with capacity bonuses; derived attributes
 * (stats) are computed from state on read and never stored. The unit attributes
 * planned for the battle system (§13.2) will extend the key space, not this registry.
 */
export type AttributeFamily = "amount" | "capacity" | "derived";

export type ProductionResourceKey =
  | "food"
  | "wood"
  | "stone"
  | "gold"
  | "military"
  | "science"
  | "metalwork"
  | "trade";
export type CapacityResourceKey =
  | "peopleCapacity"
  | "houseCapacity"
  | "farmCapacity"
  | "lumberYardCapacity"
  | "quarryCapacity"
  | "goldMineCapacity"
  | "marketCapacity"
  | "townHallCapacity"
  | "smithyCapacity"
  | "barracksCapacity"
  | "universityCapacity";
export type ResourceKey =
  | ProductionResourceKey
  | "population"
  | CapacityResourceKey;

/** Derived attributes: computed from state on read, never stored (§13.2 decision 2). */
export type DerivedAttributeKey =
  | "clickPower"
  | "autoClickRate"
  | "buildingCostMultiplier"
  | "wastedResources"
  | "tradeProductionMultiplier"
  | "tradeRoutes"
  | "spread"
  | "offlineEfficiency"
  | "foodProductionPerWorker"
  | "woodProductionPerWorker"
  | "stoneProductionPerWorker"
  | "goldProductionPerWorker"
  | "militaryProductionPerWorker"
  | "scienceProductionPerWorker"
  | "metalworkProductionPerWorker"
  | "tradeProductionPerWorker";

/** Every value-side key a bonus destination may name; buyable ids are separate. */
export type AttributeKey = ResourceKey | DerivedAttributeKey;

const attributeDescription = (
  family: AttributeFamily,
  label: string,
): string => (family === "amount" ? `${label} resource` : `${label} attribute`);

export class AttributeDefinition extends GameObject {
  readonly key: AttributeKey;
  readonly label: string;
  readonly family: AttributeFamily;
  readonly productionPerWorker: number;

  constructor(
    key: AttributeKey,
    label: string,
    family: AttributeFamily,
    description?: string,
    productionPerWorker = 1,
  ) {
    super(key, description ?? attributeDescription(family, label));
    this.key = key;
    this.label = label;
    this.family = family;
    this.productionPerWorker = productionPerWorker;
  }
}

/** Worker-assignable production resources (§13.2). */
export const productionDefinitions: AttributeDefinition[] = [
  new AttributeDefinition("wood", "Wood", "amount"),
  new AttributeDefinition("stone", "Stone", "amount"),
  new AttributeDefinition("food", "Food", "amount"),
  new AttributeDefinition("gold", "Gold", "amount"),
  new AttributeDefinition("military", "Military", "amount", undefined, 0.1),
  new AttributeDefinition("science", "Science", "amount", undefined, 0.1),
  new AttributeDefinition("metalwork", "Metalwork", "amount", undefined, 0.1),
  new AttributeDefinition(
    "trade",
    "Trade power",
    "amount",
    "Trade power is the reserve the market accumulates and never spends: an open trade route forwards `reserve × intensity` worth of it as gold each second, and the reserve also multiplies every production rate by 1 + log₁₀(reserve + 1).",
    0.1,
  ),
];

export const populationDefinition = new AttributeDefinition(
  "population",
  "Population",
  "amount",
);

/** Capacity is stored as a resource (§4.3): one per building, default 10. */
export const capacityDefinitions: AttributeDefinition[] = [
  new AttributeDefinition("peopleCapacity", "People Capacity", "capacity"),
  new AttributeDefinition("houseCapacity", "House Capacity", "capacity"),
  new AttributeDefinition("farmCapacity", "Farm Capacity", "capacity"),
  new AttributeDefinition(
    "lumberYardCapacity",
    "Lumber Yard Capacity",
    "capacity",
  ),
  new AttributeDefinition("quarryCapacity", "Quarry Capacity", "capacity"),
  new AttributeDefinition("goldMineCapacity", "Gold Mine Capacity", "capacity"),
  new AttributeDefinition("marketCapacity", "Market Capacity", "capacity"),
  new AttributeDefinition("townHallCapacity", "Town Hall Capacity", "capacity"),
  new AttributeDefinition("smithyCapacity", "Smithy Capacity", "capacity"),
  new AttributeDefinition("barracksCapacity", "Barracks Capacity", "capacity"),
  new AttributeDefinition(
    "universityCapacity",
    "University Capacity",
    "capacity",
  ),
];

type DerivedAttributeData = {
  key: string;
  label: string;
  description: string;
};

/**
 * Computed stats (§13.2 decision 2): `clickPower` and `autoClickRate`. They are
 * never stored — bonuses whose destination is the stat id feed their value, so
 * `+1 per click` is an ordinary `attributeFlat` bonus on `clickPower` and
 * `×2 click power` is an `attributeMultiplier` bonus.
 */
export const derivedAttributeDefinitions: AttributeDefinition[] = (
  statData as DerivedAttributeData[]
).map(
  ({ key, label, description }) =>
    new AttributeDefinition(
      key as DerivedAttributeKey,
      label,
      "derived",
      description,
    ),
);

/** Every attribute definition, in Gamepedia registration order. */

/** Wasted resources: accumulated resource cost of retired units (§Age system). */
export const wastedResourcesDefinition = new AttributeDefinition(
  "wastedResources",
  "Wasted Resources",
  "derived",
  "Resources spent on units that were retired at an age boundary.",
);

derivedAttributeDefinitions.push(wastedResourcesDefinition);

/**
 * Every production building owns a derived power attribute (§13.2): its base is
 * the `power` field on the building definition (1 unless the data says
 * otherwise), raised by `attributeMultiplier` bonuses (e.g. an encounter
 * granting `farmPower` ×4). A production building is one that has an
 * `additiveMultiplier` or a `resourceProduction` effect — `house`, `townHall`
 * and `people` (capacity/drain only) have none. Keys are `${buildingKey}Power`.
 */
export const buildingPowerAttributeDefinitions: AttributeDefinition[] =
  buildingDefinitions
    .filter((b) => b.effects.additiveMultiplier || b.effects.resourceProduction)
    .map(
      (b) =>
        new AttributeDefinition(
          `${b.key}Power` as AttributeKey,
          `${b.name} power`,
          "derived",
          `${b.name} power scales this building's production. Base ${b.power?.toString() ?? "1"}; bonuses raise it.`,
        ),
    );

derivedAttributeDefinitions.push(...buildingPowerAttributeDefinitions);

/**
 * Production-per-worker stats: one per production resource, base from derivedDefaults.json,
 * multiplied by bonuses targeting `<resource>ProductionPerWorker` or the group targets
 * `basicProductionPerWorker` (food/wood/stone/gold), `advancedProductionPerWorker`
 * (military/science/metalwork/trade), or `allProductionPerWorker` (all 8).
 */
const productionPerWorkerAttributeDefinitions: AttributeDefinition[] =
  productionDefinitions.map(
    ({ key, label }) =>
      new AttributeDefinition(
        `${key}ProductionPerWorker` as DerivedAttributeKey,
        `${label} production per worker`,
        "derived",
        `Base ${getDerivedAttributeDefault(`${key}ProductionPerWorker`)} worker production for ${label.toLowerCase()}. Multiplied by bonuses to make workers more effective.`,
        getDerivedAttributeDefault(`${key}ProductionPerWorker`),
      ),
  );

derivedAttributeDefinitions.push(...productionPerWorkerAttributeDefinitions);

/** Offline efficiency: the fraction of live production gained while offline. */
const offlineEfficiencyDefinition = new AttributeDefinition(
  "offlineEfficiency",
  "Offline Efficiency",
  "derived",
  "Fraction of live production gained while offline. Default 0.25; bonuses raise it.",
  getDerivedAttributeDefault("offlineEfficiency"),
);

derivedAttributeDefinitions.push(offlineEfficiencyDefinition);

export const attributeDefinitions: AttributeDefinition[] = [
  ...productionDefinitions,
  populationDefinition,
  ...capacityDefinitions,
  ...derivedAttributeDefinitions,
];

export const findAttributeDefinition = (
  key: string,
): AttributeDefinition | undefined =>
  attributeDefinitions.find(({ key: attributeKey }) => attributeKey === key);

/** Resources whose amount accrues per tick: worker production + building output. */
export const producerResourceKeys: ResourceKey[] = [
  ...productionDefinitions.map(({ key }) => key),
] as ResourceKey[];

export type ResourceAmounts = Record<ResourceKey, ExpNumber>;
export type WorkerAssignments = Record<ProductionResourceKey, ExpNumber>;

export type ResourceFactorSource = AttributeDefinition | string;
export type ResourceFactor = readonly [
  source: ResourceFactorSource,
  value: ExpNumber,
];

export type ResourceFactors = {
  additional: ResourceFactor[];
  multiplicative: ResourceFactor[];
  /**
   * Building bonuses that **sum** (AGENTS.md §13.1): (1 + Σ additiveMultiplier)
   * scales the resource beside the compounding multiplicative product.
   */
  additiveMultiplier: ResourceFactor[];
  drain: ResourceFactor[];
};

export type ResourceFactorMap = Record<ResourceKey, ResourceFactors>;

/** Composition of a derived attribute: base term plus active bonus factors (§13.2). */
export type DerivedAttributeFactors = {
  base: ExpNumber;
  additional: ResourceFactor[];
  multiplicative: ResourceFactor[];
};

export const emptyResourceAmounts = (): ResourceAmounts => ({
  food: ExpNumber.ZERO,
  wood: ExpNumber.ZERO,
  stone: ExpNumber.ZERO,
  gold: ExpNumber.ZERO,
  population: ExpNumber.ZERO,
  science: ExpNumber.ZERO,
  military: ExpNumber.ZERO,
  metalwork: ExpNumber.ZERO,
  trade: ExpNumber.ZERO,
  peopleCapacity: ExpNumber.ZERO,
  houseCapacity: ExpNumber.ZERO,
  farmCapacity: ExpNumber.fromNumber(10),
  lumberYardCapacity: ExpNumber.fromNumber(10),
  quarryCapacity: ExpNumber.fromNumber(10),
  goldMineCapacity: ExpNumber.fromNumber(10),
  marketCapacity: ExpNumber.fromNumber(10),
  townHallCapacity: ExpNumber.fromNumber(1),
  smithyCapacity: ExpNumber.fromNumber(10),
  barracksCapacity: ExpNumber.fromNumber(10),
  universityCapacity: ExpNumber.fromNumber(10),
});

export const emptyWorkerAssignments = (): WorkerAssignments => ({
  food: ExpNumber.ZERO,
  wood: ExpNumber.ZERO,
  stone: ExpNumber.ZERO,
  gold: ExpNumber.ZERO,
  military: ExpNumber.ZERO,
  science: ExpNumber.ZERO,
  metalwork: ExpNumber.ZERO,
  trade: ExpNumber.ZERO,
});

export const emptyResourceFactors = (): ResourceFactorMap => ({
  food: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  wood: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  stone: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  gold: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  population: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  science: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  military: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  metalwork: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  trade: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  peopleCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  houseCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  farmCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  lumberYardCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  quarryCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  goldMineCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  marketCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  townHallCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  smithyCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  barracksCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
  universityCapacity: {
    additional: [],
    multiplicative: [],
    additiveMultiplier: [],
    drain: [],
  },
});

export const summarizeResourceFactors = ({
  additional,
  multiplicative,
  additiveMultiplier,
  drain,
}: ResourceFactors) => {
  const additionalTotal = additional.reduce(
    (total, [, value]) => total.add(value),
    ExpNumber.ZERO,
  );
  const multiplier = multiplicative.reduce(
    (total, [, value]) => total.mul(value),
    ExpNumber.ONE,
  );
  // Summed bonuses floor at -1, so the combined multiplier never drops below 0.
  const additiveBonus = ExpNumber.max(
    ExpNumber.fromNumber(-1),
    additiveMultiplier.reduce(
      (total, [, value]) => total.add(value),
      ExpNumber.ZERO,
    ),
  );
  const additive = ExpNumber.ONE.add(additiveBonus);
  const drainTotal = drain.reduce(
    (total, [, value]) => total.add(value),
    ExpNumber.ZERO,
  );

  return {
    additional: additionalTotal,
    multiplier,
    additiveMultiplier: additiveBonus,
    totalMultiplier: multiplier.mul(additive),
    drain: drainTotal,
    result: additionalTotal.mul(multiplier).mul(additive).sub(drainTotal),
  };
};

export const computeResourceRate = (factors: ResourceFactors): ExpNumber =>
  summarizeResourceFactors(factors).result;
