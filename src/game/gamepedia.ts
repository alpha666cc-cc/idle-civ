import { buildingDefinitions, type BuildingDefinition } from "./buildings";
import {
  achievementDefinitions,
  aggregateHoarderDefinition,
  chainFamilyForId,
  type AchievementDefinition,
} from "./achievements";
import { encounterDefinitions } from "./encounters";
import { ageDefinitions } from "./ages";
import { GameObject } from "./gameObject";
import { upgradeDefinitions } from "./upgrades";
import { researchDefinitions } from "./research";
import { unitDefinitions } from "./units";
import {
  attributeDefinitions,
  populationDefinition,
  type AttributeDefinition,
} from "./attributes";
import {
  normalizeBonusDestination,
  parseCostParameterTarget,
} from "./bonus";

export type GamepediaCategory =
  | "resource"
  | "capacity"
  | "building"
  | "unit"
  | "upgrade"
  | "achievement"
  | "stat"
  | "research"
  | "age"
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
const achievementRelatedIds = (
  achievement: AchievementDefinition,
): string[] => {
  const { requirement } = achievement;
  return [
    ...(requirement.type === "resource"
      ? [requirement.resource]
      : requirement.type === "population"
        ? [populationDefinition.id]
        : requirement.type === "buildingCount"
          ? [requirement.building]
          : requirement.type === "encounter" ||
              requirement.type === "battle"
            ? [requirement.encounterId]
            : []),
    ...achievement.bonuses.flatMap(({ destination }) =>
      bonusDestinationRelatedIds(String(destination)),
    ),
  ];
};

const bonusDestinationRelatedIds = (destination: string): string[] => {
  const normalized = normalizeBonusDestination(destination);
  const target = parseCostParameterTarget(normalized);
  if (!target) {
    if (normalized === "civilBuildings") return ["house", "townHall"];
    if (normalized === "allBuildings")
      return buildingDefinitions.map(({ key }) => key);
    if (normalized === "allUnits")
      return unitDefinitions.map(({ key }) => key);
    if (normalized === "basicProductionBuildings")
      return ["farm", "lumberYard", "quarry", "goldMine"];
    if (normalized === "advancedProductionBuildings")
      return ["barracks", "university", "smithy", "market"];
    return [normalized.split(".")[0]];
  }

  const owners =
    target.buyable === "all"
      ? [
          ...buildingDefinitions.map(({ key }) => key),
          ...unitDefinitions.map(({ key }) => key),
          ...upgradeDefinitions.map(({ key }) => key),
          ...researchDefinitions.map(({ key }) => key),
        ]
      : target.buyable === "allBuildings"
        ? buildingDefinitions.map(({ key }) => key)
        : target.buyable === "allUnits"
          ? unitDefinitions.map(({ key }) => key)
          : target.buyable === "civilBuildings"
            ? ["house", "townHall"]
            : target.buyable === "basicProductionBuildings"
              ? ["farm", "lumberYard", "quarry", "goldMine"]
              : target.buyable === "advancedProductionBuildings"
                ? ["barracks", "university", "smithy", "market"]
                : target.buyable === "research"
                  ? researchDefinitions.map(({ key }) => key)
                  : target.buyable.startsWith("tag.")
                    ? unitDefinitions
                        .filter(({ tags }) =>
                          tags.includes(target.buyable.slice("tag.".length)),
                        )
                        .map(({ key }) => key)
                    : target.buyable.startsWith("domain.")
                      ? unitDefinitions
                          .filter(
                            ({ domain }) =>
                              domain ===
                              target.buyable.slice("domain.".length),
                          )
                          .map(({ key }) => key)
                      : [target.buyable];
  return [
    ...owners,
    ...(target.resource === "all" ? [] : [target.resource]),
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
    // Open-ended hoarder tiers aggregate into one `<family>-total` record per
    // chain family instead of one entry per exponent tier (§13.4): earned tier
    // ids resolve to the aggregate, keeping the achievement category readable.
    const family = chainFamilyForId(definition.id);
    if (family) {
      const aggregate = aggregateHoarderDefinition(family);
      if (aggregate) {
        if (!this.entries.has(aggregate.id)) {
          aggregate.seen = true;
          const relatedIds = [...new Set(achievementRelatedIds(aggregate))];
          this.register({
            object: aggregate,
            category: "achievement",
            relatedIds,
          });
          for (const relatedId of relatedIds) {
            const related = this.entries.get(relatedId);
            if (related && !related.relatedIds.includes(aggregate.id)) {
              related.relatedIds.push(aggregate.id);
            }
          }
        }
        return;
      }
    }
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
    "buildingCostMultiplier",
    ...(building.effects.additiveMultiplier ?? []).map(
      ({ resource }) => resource,
    ),
    ...(building.effects.resourceDrain ?? []).map(({ resource }) => resource),
    ...(building.effects.resourceProduction ?? []).map(
      ({ resource }) => resource,
    ),
    ...(building.effects.capacityProvided ?? []).map(
      ({ building: capacityBuilding }) => capacityBuilding,
    ),
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
    ...upgrade.bonuses.flatMap(
      ({ destination }) => bonusDestinationRelatedIds(String(destination)),
    ),
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
  const relatedIds = [
    ...encounter.bonuses.flatMap(({ destination }) =>
      bonusDestinationRelatedIds(String(destination)),
    ),
    // Battles link to every unit in the opposing army; buildRelations() makes
    // the reverse unit → battle link.
    ...encounter.enemyArmy.map(({ unitId }) => unitId),
  ];
  gamepedia.register({
    object: encounter,
    category: "combat",
    relatedIds: [...new Set(relatedIds)],
  });
}

for (const age of ageDefinitions) {
  gamepedia.register({
    object: age,
    category: "age",
    relatedIds: [
      ...age.unlocks,
      ...age.bonuses.flatMap(({ destination }) =>
        bonusDestinationRelatedIds(String(destination)),
      ),
    ],
  });
}

for (const research of researchDefinitions) {
  const relatedIds = [
    ...research.prerequisites,
    ...research.bonuses.flatMap(({ destination }) =>
      bonusDestinationRelatedIds(String(destination)),
    ),
    ...research.unlocks,
  ];
  // seen stays false at registration: researches are revealed when their
  // prerequisites and age gates fire (App reveals on every state change).
  gamepedia.register({
    object: research,
    category: "research",
    relatedIds: [...new Set(relatedIds)],
  });
}

for (const unit of unitDefinitions) {
  // Units are revealed when their roster window opens (App reveals on state
  // change); seen stays false at registration.
  gamepedia.register({
    object: unit,
    category: "unit",
    relatedIds: [...new Set(unit.costs.map(({ resource }) => resource))],
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
