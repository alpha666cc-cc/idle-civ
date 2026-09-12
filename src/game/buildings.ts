export type BuildingKey =
  | "people"
  | "house"
  | "farm"
  | "quarry"
  | "gold-mine"
  | "market"
  | "town-hall"
  | "smithy"
  | "barracks"
  | "academy"
  | "monument";

import type { ResourceKey } from "./resources";

export type BuildingCost = {
  resource: ResourceKey;
  base: number;
  factor: number;
};

export class BuildingDefinition {
  readonly key: BuildingKey;
  readonly name: string;
  readonly description: string;
  readonly costs: BuildingCost[];
  readonly available: boolean;
  readonly maxCount: number;

  constructor(
    key: BuildingKey,
    name: string,
    description: string,
    costs: BuildingCost[],
    available: boolean,
    maxCount = 10,
  ) {
    this.key = key;
    this.name = name;
    this.description = description;
    this.costs = costs;
    this.available = available;
    this.maxCount = maxCount;
  }

  costAt(buildingsAlreadyBuilt: number): BuildingCost[] {
    return this.costs.map((cost) => ({
      ...cost,
      base: Math.ceil(cost.base * cost.factor ** buildingsAlreadyBuilt),
    }));
  }

  formatCost(buildingsAlreadyBuilt: number): string {
    return this.costAt(buildingsAlreadyBuilt)
      .map(({ resource, base }) => `${base} ${resource}`)
      .join(" + ");
  }
}

export const buildingDefinitions: BuildingDefinition[] = [
  new BuildingDefinition(
    "people",
    "People",
    "+1 population",
    [{ resource: "food", base: 10, factor: 1.3 }],
    true,
  ),
  new BuildingDefinition(
    "house",
    "House",
    "+12 housing",
    [{ resource: "wood", base: 80, factor: 1.15 }],
    true,
  ),
  new BuildingDefinition(
    "farm",
    "Farm",
    "+6 food / min",
    [
      { resource: "wood", base: 120, factor: 1.18 },
      { resource: "food", base: 40, factor: 1.1 },
    ],
    true,
  ),
  new BuildingDefinition(
    "quarry",
    "Quarry",
    "+4 stone / min",
    [
      { resource: "wood", base: 160, factor: 1.18 },
      { resource: "stone", base: 60, factor: 1.12 },
    ],
    true,
  ),
  new BuildingDefinition(
    "gold-mine",
    "Gold Mine",
    "+2 gold / min",
    [
      { resource: "wood", base: 240, factor: 1.2 },
      { resource: "stone", base: 140, factor: 1.16 },
      { resource: "gold", base: 40, factor: 1.1 },
    ],
    true,
  ),
  new BuildingDefinition(
    "market",
    "Market",
    "Trade resources",
    [
      { resource: "wood", base: 300, factor: 1.2 },
      { resource: "stone", base: 120, factor: 1.15 },
    ],
    true,
  ),
  new BuildingDefinition(
    "town-hall",
    "Town Hall",
    "+1 civic slot",
    [
      { resource: "wood", base: 500, factor: 1.25 },
      { resource: "stone", base: 500, factor: 1.2 },
      { resource: "gold", base: 100, factor: 1.15 },
    ],
    true,
  ),
  new BuildingDefinition(
    "smithy",
    "Smithy",
    "Unlocks equipment",
    [
      { resource: "wood", base: 360, factor: 1.2 },
      { resource: "stone", base: 180, factor: 1.15 },
    ],
    true,
  ),
  new BuildingDefinition(
    "barracks",
    "Barracks",
    "Train units",
    [
      { resource: "wood", base: 420, factor: 1.22 },
      { resource: "stone", base: 260, factor: 1.18 },
      { resource: "food", base: 100, factor: 1.1 },
    ],
    true,
  ),
  new BuildingDefinition(
    "academy",
    "Academy",
    "+3 science / min",
    [
      { resource: "wood", base: 520, factor: 1.24 },
      { resource: "stone", base: 300, factor: 1.18 },
      { resource: "gold", base: 180, factor: 1.16 },
    ],
    true,
  ),
  new BuildingDefinition(
    "monument",
    "Monument",
    "Coming soon",
    [
      { resource: "stone", base: 900, factor: 1.3 },
      { resource: "gold", base: 400, factor: 1.2 },
    ],
    false,
  ),
];
