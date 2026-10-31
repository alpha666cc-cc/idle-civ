export type BuildingKey =
  | "people"
  | "house"
  | "farm"
  | "lumberYard"
  | "quarry"
  | "goldMine"
  | "market"
  | "townHall"
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
  exponent: number;
};

export const DEFAULT_COST_EXPONENT = 0.5;

export type BuildingEffectEntry<T extends object> = T[];
export type BuildingEffectTag = "nopower";

export const hasBuildingEffectTag = (
  effect: { readonly tags?: readonly BuildingEffectTag[] },
  tag: BuildingEffectTag,
): boolean => effect.tags?.includes(tag) ?? false;

export type BuildingEffects = {
  capacityProvided?: BuildingEffectEntry<{
    building: BuildingKey;
    perBuilding: ExpNumber;
    tags?: readonly BuildingEffectTag[];
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
  bonus?: BuildingEffectEntry<{
    type: string;
    destination: string;
    value: number;
  }>;
};

/**
 * Data-driven building unlock gate (AGENTS.md §13.4). A building with an unlock stays
 * locked until the engine reports the condition satisfied; `available: false`
 * remains permanently locked.
 */
export type BuildingUnlock =
  | { source: "buildingCount"; building: BuildingKey; threshold: number }
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
  /**
   * The building's own power, the base of its `${key}Power` derived stat (§13.2).
   * It is data rather than a hardcoded 1 so a building can start stronger or
   * weaker; bonuses (enhancers, ages, encounters) then move it from there.
   * Buildings with no production effect carry no power and leave this undefined.
   */
  readonly power?: ExpNumber;

  constructor(
    key: BuildingKey,
    name: string,
    description: string,
    costs: BuildingCost[],
    available: boolean,
    maxCount = 10,
    effects: BuildingEffects = {},
    unlock?: BuildingUnlock,
    power?: ExpNumber,
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
    this.power = power;
  }
}

type BuildingData = {
  key: BuildingKey;
  name: string;
  description: string;
  costs: {
    resource: ResourceKey;
    base: number;
    factor: number;
    exponent?: number;
  }[];
  available: boolean;
  maxCount?: number;
  effects?: {
    capacityProvided?:
      | {
          building: BuildingKey;
          perBuilding: number;
          tags?: string[];
        }
      | {
          building: BuildingKey;
          perBuilding: number;
          tags?: string[];
        }[];
    additiveMultiplier?:
      | { resource: ResourceKey; perBuilding: number }
      | { resource: ResourceKey; perBuilding: number }[];
    resourceDrain?:
      | { resource: ResourceKey; amount: number }
      | { resource: ResourceKey; amount: number }[];
    resourceProduction?:
      | { resource: ResourceKey; amount: number }
      | { resource: ResourceKey; amount: number }[];
    bonus?:
      | { type: string; destination: string; value: number }
      | { type: string; destination: string; value: number }[];
  };
  unlock?: BuildingUnlock;
  /** Base power for this building's `${key}Power` stat; absent for non-producers. */
  power?: number;
};

const normalizeBuildingEffects = <T extends object>(
  value: T | T[] | undefined,
): T[] | undefined => {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
};

const parseBuildingEffectTags = (
  tags: string[] | undefined,
): readonly BuildingEffectTag[] | undefined => {
  if (tags === undefined) return undefined;
  return tags.map((tag): BuildingEffectTag => {
    if (tag === "nopower") return tag;
    throw new Error(`Unknown building effect tag: ${tag}`);
  });
};

const toBuildingDefinition = (data: BuildingData): BuildingDefinition => {
  const effects = data.effects;
  return new BuildingDefinition(
    data.key,
    data.name,
    data.description,
    data.costs.map(({ resource, base, factor, exponent }) => ({
      resource,
      base: ExpNumber.fromNumber(base),
      factor,
      exponent: exponent ?? DEFAULT_COST_EXPONENT,
    })),
    data.available,
    data.maxCount,
    effects
      ? {
          capacityProvided: normalizeBuildingEffects(
            effects.capacityProvided,
          )?.map(({ building, perBuilding, tags }) => ({
            building,
            perBuilding: ExpNumber.fromNumber(perBuilding),
            tags: parseBuildingEffectTags(tags),
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
          bonus: normalizeBuildingEffects(effects.bonus),
        }
      : undefined,
    data.unlock,
    // A building that produces something owns a power stat; `power` is its base
    // value, so the JSON decides whether it starts at 1 or somewhere else.
    // If the JSON explicitly defines power (even as 0), honor it.
    data.power !== undefined
      ? ExpNumber.fromNumber(data.power)
      : data.effects?.additiveMultiplier || data.effects?.resourceProduction
        ? ExpNumber.fromNumber(1)
        : undefined,
  );
};

export const buildingDefinitions: BuildingDefinition[] = (
  buildingData as BuildingData[]
).map(toBuildingDefinition);
