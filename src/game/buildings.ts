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
  | "university"
  | "monument";

import type { ResourceKey } from "./resources";
import { GameObject } from "./gameObject";

export type BuildingCost = {
  resource: ResourceKey;
  base: number;
  factor: number;
};

export type BuildingEffects = {
  capacityProvided?: { building: BuildingKey; perBuilding: number };
  resourceMultiplier?: { resource: ResourceKey; factor: number };
  resourceDrain?: { resource: ResourceKey; amount: number };
};

export class BuildingDefinition extends GameObject {
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
    super(key, description);
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
    "Citizen",
    "add population",
    [{ resource: "food", base: 10, factor: 1.2 }],
    true,
    10,
    { resourceDrain: { resource: "food", amount: 1 } },
  ),
  new BuildingDefinition(
    "house",
    "House",
    "Increase citizen capacity",
    [{ resource: "wood", base: 10, factor: 1.3 }],
    true,
    10,
    { capacityProvided: { building: "people", perBuilding: 10 } },
  ),
  new BuildingDefinition(
    "farm",
    "Farm",
    "help gather food",
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
    "help gather wood",
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
    "help mine stone",
    [{ resource: "stone", base: 20, factor: 1.3 }],
    true,
    10,
    { resourceMultiplier: { resource: "stone", factor: 1.1 } },
  ),
  new BuildingDefinition(
    "gold-mine",
    "Gold Mine",
    "help gold miner",
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
    "Increase house capacity",
    [
      { resource: "wood", base: 1000, factor: 1.25 },
      { resource: "stone", base: 500, factor: 1.25 },
      { resource: "gold", base: 500, factor: 1.25 },
    ],
    true,
    10,
    { capacityProvided: { building: "house", perBuilding: 10 } },
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
    "university",
    "University",
    "generate science",
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
