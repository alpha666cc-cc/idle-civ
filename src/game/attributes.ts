import statData from "./data/stats.json";
import { buildingDefinitions, type BuildingKey } from "./buildings";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";

/**
 * Attribute families (AGENTS.md §13.2): every value a bonus destination can name on
 * the value side. Amounts are stored and accrue per tick; capacities are stored
 * maxima whose effective value multiplies with capacity bonuses; derived attributes
 * (stats) are computed from state on read and never stored. The unit attributes
 * planned for the battle system (§13.2) will extend the key space, not this registry.
 */
export type AttributeFamily = "amount" | "capacity" | "derived";

export type ProductionResourceKey = "food" | "wood" | "stone" | "gold";
export type CapacityResourceKey =
  | "peopleCapacity"
  | "houseCapacity"
  | "farmCapacity"
  | "lumber-yardCapacity"
  | "quarryCapacity"
  | "gold-mineCapacity"
  | "marketCapacity"
  | "town-hallCapacity"
  | "smithyCapacity"
  | "barracksCapacity"
  | "universityCapacity";
export type ResourceKey =
  | ProductionResourceKey
  | "population"
  | "science"
  | "military"
  | "metalwork"
  | CapacityResourceKey;

/** Derived attributes: computed from state on read, never stored (§13.2 decision 2). */
export type DerivedAttributeKey =
  | "clickPower"
  | "autoClickRate"
  | "buildingPower"
  | `${BuildingKey}Power`;

/** Every value-side key a bonus destination may name; buyable ids are separate. */
export type AttributeKey = ResourceKey | DerivedAttributeKey;

const attributeDescription = (family: AttributeFamily, label: string): string =>
  family === "amount" ? `${label} resource` : `${label} attribute`;

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
];

export const populationDefinition = new AttributeDefinition(
  "population",
  "Population",
  "amount",
);
export const scienceDefinition = new AttributeDefinition(
  "science",
  "Science",
  "amount",
);
export const militaryDefinition = new AttributeDefinition(
  "military",
  "Military",
  "amount",
);
export const metalworkDefinition = new AttributeDefinition(
  "metalwork",
  "Metalwork",
  "amount",
);

/** Capacity is stored as a resource (§4.3): one per building, default 10. */
export const capacityDefinitions: AttributeDefinition[] = [
  new AttributeDefinition("peopleCapacity", "People Capacity", "capacity"),
  new AttributeDefinition("houseCapacity", "House Capacity", "capacity"),
  new AttributeDefinition("farmCapacity", "Farm Capacity", "capacity"),
  new AttributeDefinition(
    "lumber-yardCapacity",
    "Lumber Yard Capacity",
    "capacity",
  ),
  new AttributeDefinition("quarryCapacity", "Quarry Capacity", "capacity"),
  new AttributeDefinition(
    "gold-mineCapacity",
    "Gold Mine Capacity",
    "capacity",
  ),
  new AttributeDefinition("marketCapacity", "Market Capacity", "capacity"),
  new AttributeDefinition(
    "town-hallCapacity",
    "Town Hall Capacity",
    "capacity",
  ),
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

/**
 * Every building owns a derived power attribute (§13.2): base 1, raised by
 * bonuses targeting `<buildingKey>Power`. Derived from the building registry so
 * new buildings get their power automatically — the building list is the single
 * source of truth.
 */
export const buildingPowerAttributeDefinitions: AttributeDefinition[] =
  buildingDefinitions.map(
    ({ key, name }) =>
      new AttributeDefinition(
        `${key}Power`,
        `${name} power`,
        "derived",
        `${name} power multiplies this building's effects. Milestones raise it.`,
      ),
  );

/** Every attribute definition, in Gamepedia registration order. */
derivedAttributeDefinitions.push(...buildingPowerAttributeDefinitions);

export const attributeDefinitions: AttributeDefinition[] = [
  ...productionDefinitions,
  populationDefinition,
  scienceDefinition,
  militaryDefinition,
  metalworkDefinition,
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
  scienceDefinition.key,
  militaryDefinition.key,
  metalworkDefinition.key,
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
  peopleCapacity: ExpNumber.ZERO,
  houseCapacity: ExpNumber.ZERO,
  farmCapacity: ExpNumber.fromNumber(10),
  "lumber-yardCapacity": ExpNumber.fromNumber(10),
  quarryCapacity: ExpNumber.fromNumber(10),
  "gold-mineCapacity": ExpNumber.fromNumber(10),
  marketCapacity: ExpNumber.fromNumber(10),
  "town-hallCapacity": ExpNumber.fromNumber(1),
  smithyCapacity: ExpNumber.fromNumber(10),
  barracksCapacity: ExpNumber.fromNumber(10),
  universityCapacity: ExpNumber.fromNumber(10),
});

export const emptyWorkerAssignments = (): WorkerAssignments => ({
  food: ExpNumber.ZERO,
  wood: ExpNumber.ZERO,
  stone: ExpNumber.ZERO,
  gold: ExpNumber.ZERO,
});

export const emptyResourceFactors = (): ResourceFactorMap => ({
  food: { additional: [], multiplicative: [], drain: [] },
  wood: { additional: [], multiplicative: [], drain: [] },
  stone: { additional: [], multiplicative: [], drain: [] },
  gold: { additional: [], multiplicative: [], drain: [] },
  population: { additional: [], multiplicative: [], drain: [] },
  science: { additional: [], multiplicative: [], drain: [] },
  military: { additional: [], multiplicative: [], drain: [] },
  metalwork: { additional: [], multiplicative: [], drain: [] },
  peopleCapacity: { additional: [], multiplicative: [], drain: [] },
  houseCapacity: { additional: [], multiplicative: [], drain: [] },
  farmCapacity: { additional: [], multiplicative: [], drain: [] },
  "lumber-yardCapacity": { additional: [], multiplicative: [], drain: [] },
  quarryCapacity: { additional: [], multiplicative: [], drain: [] },
  "gold-mineCapacity": { additional: [], multiplicative: [], drain: [] },
  marketCapacity: { additional: [], multiplicative: [], drain: [] },
  "town-hallCapacity": { additional: [], multiplicative: [], drain: [] },
  smithyCapacity: { additional: [], multiplicative: [], drain: [] },
  barracksCapacity: { additional: [], multiplicative: [], drain: [] },
  universityCapacity: { additional: [], multiplicative: [], drain: [] },
});

export const computeResourceRate = ({
  additional,
  multiplicative,
  drain,
}: ResourceFactors): ExpNumber => {
  const additionalTotal = additional.reduce(
    (total, [, value]) => total.add(value),
    ExpNumber.ZERO,
  );
  const multiplier = multiplicative.reduce(
    (total, [, value]) => total.mul(value),
    ExpNumber.ONE,
  );
  const drainTotal = drain.reduce(
    (total, [, value]) => total.add(value),
    ExpNumber.ZERO,
  );

  return additionalTotal.mul(multiplier).sub(drainTotal);
};