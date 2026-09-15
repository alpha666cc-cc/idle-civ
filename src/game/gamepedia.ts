import { buildingDefinitions, type BuildingDefinition } from "./buildings";
import { GameObject } from "./gameObject";
import { upgradeDefinitions } from "./upgrades";
import {
  capacityDefinitions,
  populationDefinition,
  resourceDefinitions,
  scienceDefinition,
} from "./resources";

export type GamepediaCategory =
  | "resource"
  | "capacity"
  | "building"
  | "upgrade"
  | "research"
  | "combat";

export type GamepediaEntry = {
  object: GameObject;
  category: GamepediaCategory;
  relatedIds: string[];
};

export class Gamepedia {
  private readonly entries = new Map<string, GamepediaEntry>();

  register(entry: GamepediaEntry): void {
    if (this.entries.has(entry.object.id)) {
      throw new Error(`Duplicate Gamepedia id: ${entry.object.id}`);
    }
    this.entries.set(entry.object.id, entry);
  }

  get(id: string): GamepediaEntry | undefined {
    return this.entries.get(id);
  }

  require(id: string): GamepediaEntry {
    const entry = this.get(id);
    if (!entry) throw new Error(`Unknown Gamepedia id: ${id}`);
    return entry;
  }

  relatedTo(id: string): GamepediaEntry[] {
    const entry = this.require(id);
    return entry.relatedIds
      .map((relatedId) => this.get(relatedId))
      .filter(
        (related): related is GamepediaEntry =>
          related !== undefined && related.object.seen,
      );
  }

  /** Marks an entry as discovered so it appears in visible()/search() results. */
  reveal(id: string): void {
    const entry = this.get(id);
    if (entry) entry.object.seen = true;
  }

  /** Entries the player has discovered; use this for anything shown to the player. */
  visible(): GamepediaEntry[] {
    return this.all().filter(({ object }) => object.seen);
  }

  search(query: string): GamepediaEntry[] {
    const normalizedQuery = query.trim().toLowerCase();
    return this.visible().filter(({ object }) => {
      const { id, description } = object;
      const { name, label } = object as { name?: string; label?: string };
      return `${id} ${name ?? ""} ${label ?? ""} ${description}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }

  /** Makes relatedIds bidirectional so relatedTo() resolves from either side. */
  buildRelations(): void {
    for (const entry of this.entries.values()) {
      for (const relatedId of entry.relatedIds) {
        const related = this.entries.get(relatedId);
        if (related && !related.relatedIds.includes(entry.object.id)) {
          related.relatedIds.push(entry.object.id);
        }
      }
    }
  }

  /** Raw registry access, including undiscovered entries; used for internal engine lookups. */
  all(): GamepediaEntry[] {
    return [...this.entries.values()];
  }
}

const resourceObjects = [
  ...resourceDefinitions,
  populationDefinition,
  scienceDefinition,
];

export const gamepedia = new Gamepedia();

for (const resource of resourceObjects) {
  resource.seen = true;
  gamepedia.register({
    object: resource,
    category: "resource",
    relatedIds: [],
  });
}

for (const capacity of capacityDefinitions) {
  capacity.seen = true;
  gamepedia.register({
    object: capacity,
    category: "capacity",
    relatedIds: [],
  });
}

for (const building of buildingDefinitions) {
  const relatedIds = [
    ...building.costs.map(({ resource }) => resource),
    ...(building.effects.resourceMultiplier
      ? [building.effects.resourceMultiplier.resource]
      : []),
    ...(building.effects.resourceDrain
      ? [building.effects.resourceDrain.resource]
      : []),
    ...(building.effects.resourceProduction
      ? [building.effects.resourceProduction.resource]
      : []),
    ...(building.effects.capacityProvided
      ? [building.effects.capacityProvided.building]
      : []),
  ];

  building.seen = building.available;
  gamepedia.register({
    object: building,
    category: "building",
    relatedIds: [...new Set(relatedIds)],
  });
}

for (const upgrade of upgradeDefinitions) {
  const relatedIds = [
    ...upgrade.costs.map(({ resource }) => resource),
    ...upgrade.bonuses.map(({ destination }) => destination),
  ];
  // seen stays false at registration: upgrades are revealed when their
  // unlock condition fires (App reveals on every state change).
  gamepedia.register({
    object: upgrade,
    category: "upgrade",
    relatedIds: [...new Set(relatedIds)],
  });
}

gamepedia.buildRelations();

export const buildingsForResource = (
  resourceId: string,
): BuildingDefinition[] =>
  gamepedia
    .all()
    .filter(
      ({ category, relatedIds }) =>
        category === "building" && relatedIds.includes(resourceId),
    )
    .map(({ object }) => object as BuildingDefinition);
