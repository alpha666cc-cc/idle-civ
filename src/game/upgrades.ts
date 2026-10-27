import upgradeData from "./data/upgrades.json";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";
import {
  buildingDefinitions,
  DEFAULT_COST_EXPONENT,
  type BuildingCost,
  type BuildingKey,
} from "./buildings";
import { parseBonusType, type Bonus, isValidBonusDestination } from "./bonus";
import type { ResourceKey } from "./attributes";

/** Unlock conditions for upgrades (AGENTS.md §13.4). Sources own their id lists. */
export type UpgradeUnlock = {
  source: "buildingCount";
  building: BuildingKey;
  threshold: number;
};

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

type UpgradeData = {
  key: string;
  name: string;
  description: string;
  building: BuildingKey;
  threshold: number;
  tier: number;
  costs: {
    resource: ResourceKey;
    base: number | string;
    factor: number;
    exponent?: number;
  }[];
  bonuses: {
    type: string;
    destination: string;
    value: number;
  }[];
};

const toUpgradeDefinition = (data: UpgradeData): UpgradeDefinition =>
  new UpgradeDefinition(
    data.key,
    data.name,
    data.description,
    data.costs.map(({ resource, base, factor, exponent }) => ({
      resource,
      base: ExpNumber.from(base),
      factor,
      exponent: exponent ?? DEFAULT_COST_EXPONENT,
    })),
    data.bonuses.map(({ type, destination, value }) => {
      const dest = String(destination);
      if (!isValidBonusDestination(dest)) {
        throw new Error(
          `Unknown upgrade bonus destination: ${data.key} → ${dest}`,
        );
      }
      return {
        type: parseBonusType(type),
        destination,
        value: ExpNumber.fromNumber(value),
      };
    }),
    {
      source: "buildingCount",
      building: data.building,
      threshold: data.threshold,
    },
  );

for (const data of upgradeData as UpgradeData[]) {
  if (!buildingDefinitions.some(({ key }) => key === data.building)) {
    throw new Error(`Unknown upgrade building: ${data.building}`);
  }
}

export const upgradeDefinitions: UpgradeDefinition[] = (
  upgradeData as UpgradeData[]
).map(toUpgradeDefinition);
