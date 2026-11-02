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
/**
 * Scaling of `value × building count`: `none` ignores power, `multiply`
 * multiplies by power, and `exponent` raises it to power (zero disables it).
 */
export type BuildingPowerMode = "none" | "multiply" | "exponent";

type BuildingEffectPower = {
  power: BuildingPowerMode;
};
type BuildingDataEntries<T extends object> =
  | (T & BuildingEffectPower)
  | (T & BuildingEffectPower)[];

export type BuildingEffects = {
  capacityProvided?: BuildingEffectEntry<BuildingEffectPower & {
    building: BuildingKey;
    perBuilding: ExpNumber;
  }>;
  additiveMultiplier?: BuildingEffectEntry<BuildingEffectPower & {
    resource: ResourceKey;
    perBuilding: ExpNumber;
  }>;
  resourceDrain?: BuildingEffectEntry<BuildingEffectPower & {
    resource: ResourceKey;
    amount: ExpNumber;
  }>;
  resourceProduction?: BuildingEffectEntry<BuildingEffectPower & {
    resource: ResourceKey;
    amount: ExpNumber;
  }>;
  bonus?: BuildingEffectEntry<BuildingEffectPower & {
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
    capacityProvided?: BuildingDataEntries<{
      building: BuildingKey;
      perBuilding: number;
    }>;
    additiveMultiplier?: BuildingDataEntries<{
      resource: ResourceKey;
      perBuilding: number;
    }>;
    resourceDrain?: BuildingDataEntries<{
      resource: ResourceKey;
      amount: number;
    }>;
    resourceProduction?: BuildingDataEntries<{
      resource: ResourceKey;
      amount: number;
    }>;
    bonus?: BuildingDataEntries<{
      type: string;
      destination: string;
      value: number;
    }>;
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

const parseBuildingPowerMode = (mode: string): BuildingPowerMode => {
  if (mode === "none" || mode === "multiply" || mode === "exponent") {
    return mode;
  }
  throw new Error(`Unknown building effect power mode: ${mode}`);
};

const toBuildingDefinition = (data: BuildingData): BuildingDefinition => {
  const effects = data.effects;
  const normalizePower = <T extends BuildingEffectPower>(effect: T) => ({
    ...effect,
    power: parseBuildingPowerMode(effect.power),
  });
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
          )?.map(({ building, perBuilding, power }) => ({
            building,
            perBuilding: ExpNumber.fromNumber(perBuilding),
            ...normalizePower({ power }),
          })),
          additiveMultiplier: normalizeBuildingEffects(
            effects.additiveMultiplier,
          )?.map(({ resource, perBuilding, power }) => ({
            resource,
            perBuilding: ExpNumber.fromNumber(perBuilding),
            ...normalizePower({ power }),
          })),
          resourceDrain: normalizeBuildingEffects(effects.resourceDrain)?.map(
            ({ resource, amount, power }) => ({
              resource,
              amount: ExpNumber.fromNumber(amount),
              ...normalizePower({ power }),
            }),
          ),
          resourceProduction: normalizeBuildingEffects(
            effects.resourceProduction,
          )?.map(({ resource, amount, power }) => ({
            resource,
            amount: ExpNumber.fromNumber(amount),
            ...normalizePower({ power }),
          })),
          bonus: normalizeBuildingEffects(effects.bonus)?.map(normalizePower),
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
