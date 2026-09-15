import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";

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
  | "universityCapacity"
  | "monumentCapacity";
export type ResourceKey =
  | ProductionResourceKey
  | "population"
  | "science"
  | "military"
  | "metalwork"
  | CapacityResourceKey;

export class ResourceDefinition extends GameObject {
  readonly key: ResourceKey;
  readonly label: string;
  readonly productionPerWorker: number;

  constructor(key: ResourceKey, label: string, productionPerWorker = 1) {
    super(key, `${label} resource`);
    this.key = key;
    this.label = label;
    this.productionPerWorker = productionPerWorker;
  }
}

export const resourceDefinitions: ResourceDefinition[] = [
  new ResourceDefinition("wood", "Wood"),
  new ResourceDefinition("stone", "Stone"),
  new ResourceDefinition("food", "Food"),
  new ResourceDefinition("gold", "Gold"),
];

export const populationDefinition = new ResourceDefinition(
  "population",
  "Population",
);
export const scienceDefinition = new ResourceDefinition("science", "Science");
export const militaryDefinition = new ResourceDefinition("military", "Military");
export const metalworkDefinition = new ResourceDefinition(
  "metalwork",
  "Metalwork",
);

export const capacityDefinitions: ResourceDefinition[] = [
  new ResourceDefinition("peopleCapacity", "People Capacity"),
  new ResourceDefinition("houseCapacity", "House Capacity"),
  new ResourceDefinition("farmCapacity", "Farm Capacity"),
  new ResourceDefinition("lumber-yardCapacity", "Lumber Yard Capacity"),
  new ResourceDefinition("quarryCapacity", "Quarry Capacity"),
  new ResourceDefinition("gold-mineCapacity", "Gold Mine Capacity"),
  new ResourceDefinition("marketCapacity", "Market Capacity"),
  new ResourceDefinition("town-hallCapacity", "Town Hall Capacity"),
  new ResourceDefinition("smithyCapacity", "Smithy Capacity"),
  new ResourceDefinition("barracksCapacity", "Barracks Capacity"),
  new ResourceDefinition("universityCapacity", "University Capacity"),
  new ResourceDefinition("monumentCapacity", "Monument Capacity"),
];

/** Resources whose amount accrues per tick: worker production + building output. */
export const producerResourceKeys: ResourceKey[] = [
  ...resourceDefinitions.map(({ key }) => key),
  scienceDefinition.key,
  militaryDefinition.key,
  metalworkDefinition.key,
];

export const isCapacityResourceKey = (key: string): key is CapacityResourceKey =>
  capacityDefinitions.some(({ key: capacityKey }) => capacityKey === key);

export type ResourceAmounts = Record<ResourceKey, ExpNumber>;
export type WorkerAssignments = Record<ProductionResourceKey, ExpNumber>;

export type ResourceFactorSource = ResourceDefinition | string;
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
  houseCapacity: ExpNumber.fromNumber(10),
  farmCapacity: ExpNumber.fromNumber(10),
  "lumber-yardCapacity": ExpNumber.fromNumber(10),
  quarryCapacity: ExpNumber.fromNumber(10),
  "gold-mineCapacity": ExpNumber.fromNumber(10),
  marketCapacity: ExpNumber.fromNumber(10),
  "town-hallCapacity": ExpNumber.fromNumber(10),
  smithyCapacity: ExpNumber.fromNumber(10),
  barracksCapacity: ExpNumber.fromNumber(10),
  universityCapacity: ExpNumber.fromNumber(10),
  monumentCapacity: ExpNumber.fromNumber(10),
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
  monumentCapacity: { additional: [], multiplicative: [], drain: [] },
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
