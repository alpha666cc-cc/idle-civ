export type BuildingKey =
  | "people"
  | "house"
  | "farm"
  | "lumber-yard"
  | "quarry"
  | "gold-mine"
  | "market"
  | "town-hall"
  | "smithy"
  | "barracks"
  | "university";

import type { ResourceKey } from "./attributes";
import { GameObject } from "./gameObject";
import { ExpNumber } from "./expNumber";
import { formatNumber } from "./numberFormat";
import buildingData from "./data/buildings.json";

export type BuildingCost = {
  resource: ResourceKey;
  base: ExpNumber;
  factor: number;
};

export type BuildingEffects = {
  capacityProvided?: { building: BuildingKey; perBuilding: ExpNumber };
  resourceMultiplier?: { resource: ResourceKey; factor: ExpNumber };
  resourceDrain?: { resource: ResourceKey; amount: ExpNumber };
  resourceProduction?: { resource: ResourceKey; amount: ExpNumber };
};

/**
 * Data-driven building unlock gate (AGENTS.md §13.4). A building with an unlock stays
 * locked until the engine reports the condition satisfied; `available: false`
 * remains permanently locked.
 */
export type BuildingUnlock =
  | { source: "building-count"; building: BuildingKey; threshold: number }
  | { source: "battle"; encounterId: string }
  | { source: "age"; ageId: string };

export class BuildingDefinition extends GameObject {
  readonly key: BuildingKey;
  readonly name: string;
  readonly description: string;
  readonly costs: BuildingCost[];
  readonly available: boolean;
  readonly maxCount: number;
  readonly effects: BuildingEffects;
  readonly unlock?: BuildingUnlock;

  constructor(
    key: BuildingKey,
    name: string,
    description: string,
    costs: BuildingCost[],
    available: boolean,
    maxCount = 10,
    effects: BuildingEffects = {},
    unlock?: BuildingUnlock,
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.description = description;
    this.costs = costs;
    this.available = available;
    this.maxCount = maxCount;
    this.effects = effects;
    this.unlock = unlock;
  }

  costAt(buildingsAlreadyBuilt: number): BuildingCost[] {
    return this.costs.map((cost) => ({
      ...cost,
      base: ExpNumber.from(cost.base)
        .mul(ExpNumber.fromNumber(cost.factor).pow(buildingsAlreadyBuilt))
        .ceil(),
    }));
  }

  formatCost(buildingsAlreadyBuilt: number): string {
    return this.costAt(buildingsAlreadyBuilt)
      .map(({ resource, base }) => `${formatNumber(base, "named")} ${resource}`)
      .join(" + ");
  }
}

type BuildingData = {
  key: BuildingKey;
  name: string;
  description: string;
  costs: { resource: ResourceKey; base: number; factor: number }[];
  available: boolean;
  maxCount?: number;
  effects?: {
    capacityProvided?: { building: BuildingKey; perBuilding: number };
    resourceMultiplier?: { resource: ResourceKey; factor: number };
    resourceDrain?: { resource: ResourceKey; amount: number };
    resourceProduction?: { resource: ResourceKey; amount: number };
  };
  unlock?: BuildingUnlock;
};

const toBuildingDefinition = (data: BuildingData): BuildingDefinition => {
  const effects = data.effects;
  return new BuildingDefinition(
    data.key,
    data.name,
    data.description,
    data.costs.map(({ resource, base, factor }) => ({
      resource,
      base: ExpNumber.fromNumber(base),
      factor,
    })),
    data.available,
    data.maxCount,
    effects
      ? {
          capacityProvided: effects.capacityProvided
            ? {
                building: effects.capacityProvided.building,
                perBuilding: ExpNumber.fromNumber(
                  effects.capacityProvided.perBuilding,
                ),
              }
            : undefined,
          resourceMultiplier: effects.resourceMultiplier
            ? {
                resource: effects.resourceMultiplier.resource,
                factor: ExpNumber.fromNumber(effects.resourceMultiplier.factor),
              }
            : undefined,
          resourceDrain: effects.resourceDrain
            ? {
                resource: effects.resourceDrain.resource,
                amount: ExpNumber.fromNumber(effects.resourceDrain.amount),
              }
            : undefined,
          resourceProduction: effects.resourceProduction
            ? {
                resource: effects.resourceProduction.resource,
                amount: ExpNumber.fromNumber(effects.resourceProduction.amount),
              }
            : undefined,
        }
      : undefined,
    data.unlock,
  );
};

export const buildingDefinitions: BuildingDefinition[] = (
  buildingData as BuildingData[]
).map(toBuildingDefinition);
