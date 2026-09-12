export type ResourceKey = "food" | "wood" | "stone" | "gold";

export const baseResourceGenerator = "baseResourceGenerator";

export class ResourceDefinition {
  readonly key: ResourceKey;
  readonly label: string;
  readonly productionPerWorker: number;

  constructor(key: ResourceKey, label: string, productionPerWorker = 1) {
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

export type ResourceAmounts = Record<ResourceKey, number>;
export type WorkerAssignments = Record<ResourceKey, number>;

export type ResourceFactor = readonly [source: string, value: number];

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
