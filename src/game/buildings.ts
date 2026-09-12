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
  | "academy"
  | "monument";

import type { ResourceKey } from "./resources";

export type BuildingCost = {
  resource: ResourceKey;
  base: number;
  factor: number;
};

export type BuildingEffects = {
  housingProvided?: number;
  resourceMultiplier?: { resource: ResourceKey; factor: number };
  resourceDrain?: { resource: ResourceKey; amount: number };
};

export class BuildingDefinition {
  readonly key: BuildingKey;
  readonly name: string;
  readonly description: string;
  readonly costs: BuildingCost[];
  readonly available: boolean;
  readonly maxCount: number;
  readonly effects: BuildingEffects;

  constructor(
    key: BuildingKey,
    name: string,
    description: string,
    costs: BuildingCost[],
    available: boolean,
    maxCount = 10,
    effects: BuildingEffects = {},
  ) {
    this.key = key;
    this.name = name;
    this.description = description;
    this.costs = costs;
    this.available = available;
    this.maxCount = maxCount;
    this.effects = effects;
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
    "+1 population, -1 food / sec",
    [{ resource: "food", base: 10, factor: 1.25 }],
    true,
    10,
    { resourceDrain: { resource: "food", amount: 1 } },
  ),
  new BuildingDefinition(
    "house",
    "House",
    "+10 max population",
    [{ resource: "wood", base: 10, factor: 1.3 }],
    true,
    10,
    { housingProvided: 10 },
  ),
  new BuildingDefinition(
    "farm",
    "Farm",
    "+10% food gain",
    [
      { resource: "food", base: 10, factor: 1.25 },
      { resource: "wood", base: 10, factor: 1.25 },
    ],
    true,
    10,
    { resourceMultiplier: { resource: "food", factor: 1.1 } },
  ),
  new BuildingDefinition(
    "lumber-yard",
    "Lumber Yard",
    "+10% wood gain",
    [
      { resource: "wood", base: 10, factor: 1.25 },
      { resource: "stone", base: 5, factor: 1.25 },
    ],
    true,
    10,
    { resourceMultiplier: { resource: "wood", factor: 1.1 } },
  ),
  new BuildingDefinition(
    "quarry",
    "Quarry",
    "+10% stone gain",
    [{ resource: "stone", base: 20, factor: 1.3 }],
    true,
    10,
    { resourceMultiplier: { resource: "stone", factor: 1.1 } },
  ),
  new BuildingDefinition(
    "gold-mine",
    "Gold Mine",
    "+10% gold gain",
    [
      { resource: "wood", base: 100, factor: 1.25 },
      { resource: "stone", base: 50, factor: 1.3 },
    ],
    true,
    10,
    { resourceMultiplier: { resource: "gold", factor: 1.1 } },
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
    "+10 max Houses",
    [
      { resource: "wood", base: 1000, factor: 1.25 },
      { resource: "stone", base: 500, factor: 1.25 },
      { resource: "gold", base: 500, factor: 1.25 },
    ],
    true,
    10,
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
