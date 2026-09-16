import { buildingDefinitions, type BuildingDefinition } from "./buildings";
import {
  achievementDefinitions,
  type AchievementDefinition,
} from "./achievements";
import { encounterDefinitions } from "./encounters";
import { GameObject } from "./gameObject";
import { upgradeDefinitions } from "./upgrades";
import {
  attributeDefinitions,
  populationDefinition,
  type AttributeDefinition,
} from "./attributes";

export type GamepediaCategory =
  | "resource"
  | "capacity"
  | "building"
  | "upgrade"
  | "achievement"
  | "stat"
  | "research"
  | "combat";

export type GamepediaEntry = {
  object: GameObject;
  category: GamepediaCategory;
  relatedIds: string[];
};

/**
 * Achievement relation derivation shared by the static registration loop and the
 * lazy registration of materialized open-ended tiers: requirements name
 * resources, buildings and encounters by id, and rewards name their destination
 * the same way, so the graph links achievements both ways.
 */
const achievementRelatedIds = (achievement: AchievementDefinition): string[] => {
  const { requirement } = achievement;
  return [
    ...(requirement.type === "resource"
      ? [requirement.resource]
      : requirement.type === "population"
        ? [populationDefinition.id]
        : requirement.type === "building-count"
          ? [requirement.building]
          : requirement.type === "encounter"
            ? [requirement.encounterId]
            : []),
    ...achievement.bonuses.map(({ destination }) => String(destination)),
  ];
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

  /**
   * Registers a materialized open-ended achievement tier the first time it is
   * earned (no-op when already present). `buildRelations()` has already run at
   * import time, so the late entry patches its reverse links itself.
   */
  ensureAchievementEntry(definition: AchievementDefinition): void {
    if (this.entries.has(definition.id)) return;
    const relatedIds = [...new Set(achievementRelatedIds(definition))];
    this.register({
      object: definition,
      category: "achievement",
      relatedIds,
    });
    for (const relatedId of relatedIds) {
      const related = this.entries.get(relatedId);
      if (related && !related.relatedIds.includes(definition.id)) {
        related.relatedIds.push(definition.id);
      }
    }
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

/** The Gamepedia category an attribute family registers under. */
const attributeCategory = (
  family: AttributeDefinition["family"],
): GamepediaCategory =>
  family === "amount"
    ? "resource"
    : family === "capacity"
      ? "capacity"
      : "stat";

export const gamepedia = new Gamepedia();

for (const attribute of attributeDefinitions) {
  // Attributes are values the player always sees, not discoveries: seen = true.
  attribute.seen = true;
  gamepedia.register({
    object: attribute,
    category: attributeCategory(attribute.family),
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

for (const encounter of encounterDefinitions) {
  const relatedIds = encounter.bonuses.map(({ destination }) =>
    String(destination),
  );
  gamepedia.register({
    object: encounter,
    category: "combat",
    relatedIds: [...new Set(relatedIds)],
  });
}

for (const achievement of achievementDefinitions) {
  // seen stays false at registration: an achievement is a permanent record that
  // appears in the Gamepedia the moment it is earned (App reveals on every
  // state change), per AGENTS.md §13.4.
  gamepedia.register({
    object: achievement,
    category: "achievement",
    relatedIds: [...new Set(achievementRelatedIds(achievement))],
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
