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
import buildingData from "./data/buildings.json";

export type BuildingCost = {
  resource: ResourceKey;
  base: ExpNumber;
  factor: number;
};

export type BuildingEffectEntry<T extends object> = T[];

export type BuildingEffects = {
  capacityProvided?: BuildingEffectEntry<{
    building: BuildingKey;
    perBuilding: ExpNumber;
  }>;
  additiveMultiplier?: BuildingEffectEntry<{
    resource: ResourceKey;
    perBuilding: ExpNumber;
  }>;
  resourceDrain?: BuildingEffectEntry<{
    resource: ResourceKey;
    amount: ExpNumber;
  }>;
  resourceProduction?: BuildingEffectEntry<{
    resource: ResourceKey;
    amount: ExpNumber;
  }>;
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
}

type BuildingData = {
  key: BuildingKey;
  name: string;
  description: string;
  costs: { resource: ResourceKey; base: number; factor: number }[];
  available: boolean;
  maxCount?: number;
  effects?: {
    capacityProvided?:
      | { building: BuildingKey; perBuilding: number }
      | { building: BuildingKey; perBuilding: number }[];
    additiveMultiplier?:
      | { resource: ResourceKey; perBuilding: number }
      | { resource: ResourceKey; perBuilding: number }[];
    resourceDrain?:
      | { resource: ResourceKey; amount: number }
      | { resource: ResourceKey; amount: number }[];
    resourceProduction?:
      | { resource: ResourceKey; amount: number }
      | { resource: ResourceKey; amount: number }[];
  };
  unlock?: BuildingUnlock;
};

const normalizeBuildingEffects = <T extends object>(
  value: T | T[] | undefined,
): T[] | undefined => {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
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
          capacityProvided: normalizeBuildingEffects(
            effects.capacityProvided,
          )?.map(({ building, perBuilding }) => ({
            building,
            perBuilding: ExpNumber.fromNumber(perBuilding),
          })),
          additiveMultiplier: normalizeBuildingEffects(
            effects.additiveMultiplier,
          )?.map(({ resource, perBuilding }) => ({
            resource,
            perBuilding: ExpNumber.fromNumber(perBuilding),
          })),
          resourceDrain: normalizeBuildingEffects(effects.resourceDrain)?.map(
            ({ resource, amount }) => ({
              resource,
              amount: ExpNumber.fromNumber(amount),
            }),
          ),
          resourceProduction: normalizeBuildingEffects(
            effects.resourceProduction,
          )?.map(({ resource, amount }) => ({
            resource,
            amount: ExpNumber.fromNumber(amount),
          })),
        }
      : undefined,
    data.unlock,
  );
};

export const buildingDefinitions: BuildingDefinition[] = (
  buildingData as BuildingData[]
).map(toBuildingDefinition);
