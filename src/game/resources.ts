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
  | "academyCapacity"
  | "monumentCapacity";
export type ResourceKey =
  | ProductionResourceKey
  | "population"
  | "science"
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
  new ResourceDefinition("academyCapacity", "Academy Capacity"),
  new ResourceDefinition("monumentCapacity", "Monument Capacity"),
];

export type ResourceAmounts = Record<ResourceKey, number>;
export type WorkerAssignments = Record<ProductionResourceKey, number>;

export type ResourceFactorSource = ResourceDefinition | string;
export type ResourceFactor = readonly [
  source: ResourceFactorSource,
  value: number,
];

export type ResourceFactors = {
  additional: ResourceFactor[];
  multiplicative: ResourceFactor[];
  drain: ResourceFactor[];
};

export type ResourceFactorMap = Record<ResourceKey, ResourceFactors>;

export const emptyResourceAmounts = (): ResourceAmounts => ({
  food: 0,
  wood: 0,
  stone: 0,
  gold: 0,
  population: 0,
  science: 0,
  peopleCapacity: 0,
  houseCapacity: 10,
  farmCapacity: 10,
  "lumber-yardCapacity": 10,
  quarryCapacity: 10,
  "gold-mineCapacity": 10,
  marketCapacity: 10,
  "town-hallCapacity": 10,
  smithyCapacity: 10,
  barracksCapacity: 10,
  academyCapacity: 10,
  monumentCapacity: 10,
});

export const emptyWorkerAssignments = (): WorkerAssignments => ({
  food: 0,
  wood: 0,
  stone: 0,
  gold: 0,
});

export const emptyResourceFactors = (): ResourceFactorMap => ({
  food: { additional: [], multiplicative: [], drain: [] },
  wood: { additional: [], multiplicative: [], drain: [] },
  stone: { additional: [], multiplicative: [], drain: [] },
  gold: { additional: [], multiplicative: [], drain: [] },
  population: { additional: [], multiplicative: [], drain: [] },
  science: { additional: [], multiplicative: [], drain: [] },
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
  academyCapacity: { additional: [], multiplicative: [], drain: [] },
  monumentCapacity: { additional: [], multiplicative: [], drain: [] },
});

export const computeResourceRate = ({
  additional,
  multiplicative,
  drain,
}: ResourceFactors): number => {
  const additionalTotal = additional.reduce(
    (total, [, value]) => total + value,
    0,
  );
  const multiplier = multiplicative.reduce(
    (total, [, value]) => total * value,
    1,
  );
  const drainTotal = drain.reduce((total, [, value]) => total + value, 0);

  return additionalTotal * multiplier - drainTotal;
};
