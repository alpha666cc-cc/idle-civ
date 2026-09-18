"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildingsForResource = exports.gamepedia = exports.Gamepedia = void 0;
const buildings_1 = require("./buildings");
const achievements_1 = require("./achievements");
const encounters_1 = require("./encounters");
const upgrades_1 = require("./upgrades");
const units_1 = require("./units");
const attributes_1 = require("./attributes");
/**
 * Achievement relation derivation shared by the static registration loop and the
 * lazy registration of materialized open-ended tiers: requirements name
 * resources, buildings and encounters by id, and rewards name their destination
 * the same way, so the graph links achievements both ways.
 */
const achievementRelatedIds = (achievement) => {
    const { requirement } = achievement;
    return [
        ...(requirement.type === "resource"
            ? [requirement.resource]
            : requirement.type === "population"
                ? [attributes_1.populationDefinition.id]
                : requirement.type === "building-count"
                    ? [requirement.building]
                    : requirement.type === "encounter"
                        ? [requirement.encounterId]
                        : []),
        ...achievement.bonuses.map(({ destination }) => String(destination).split(".")[0]),
    ];
};
class Gamepedia {
    constructor() {
        this.entries = new Map();
    }
    register(entry) {
        if (this.entries.has(entry.object.id)) {
            throw new Error(`Duplicate Gamepedia id: ${entry.object.id}`);
        }
        this.entries.set(entry.object.id, entry);
    }
    get(id) {
        return this.entries.get(id);
    }
    require(id) {
        const entry = this.get(id);
        if (!entry)
            throw new Error(`Unknown Gamepedia id: ${id}`);
        return entry;
    }
    relatedTo(id) {
        const entry = this.require(id);
        return entry.relatedIds
            .map((relatedId) => this.get(relatedId))
            .filter((related) => related !== undefined && related.object.seen);
    }
    /** Marks an entry as discovered so it appears in visible()/search() results. */
    reveal(id) {
        const entry = this.get(id);
        if (entry)
            entry.object.seen = true;
    }
    /**
     * Registers a materialized open-ended achievement tier the first time it is
     * earned (no-op when already present). `buildRelations()` has already run at
     * import time, so the late entry patches its reverse links itself.
     */
    ensureAchievementEntry(definition) {
        // Open-ended hoarder tiers aggregate into one `<family>-total` record per
        // chain family instead of one entry per exponent tier (§13.4): earned tier
        // ids resolve to the aggregate, keeping the achievement category readable.
        const family = (0, achievements_1.chainFamilyForId)(definition.id);
        if (family) {
            const aggregate = (0, achievements_1.aggregateHoarderDefinition)(family);
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
        if (this.entries.has(definition.id))
            return;
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
    visible() {
        return this.all().filter(({ object }) => object.seen);
    }
    search(query) {
        const normalizedQuery = query.trim().toLowerCase();
        return this.visible().filter(({ object }) => {
            const { id, description } = object;
            const { name, label } = object;
            return `${id} ${name ?? ""} ${label ?? ""} ${description}`
                .toLowerCase()
                .includes(normalizedQuery);
        });
    }
    /** Makes relatedIds bidirectional so relatedTo() resolves from either side. */
    buildRelations() {
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
    all() {
        return [...this.entries.values()];
    }
}
exports.Gamepedia = Gamepedia;
/** The Gamepedia category an attribute family registers under. */
const attributeCategory = (family) => family === "amount"
    ? "resource"
    : family === "capacity"
        ? "capacity"
        : "stat";
exports.gamepedia = new Gamepedia();
for (const attribute of attributes_1.attributeDefinitions) {
    // Attributes are values the player always sees, not discoveries: seen = true.
    attribute.seen = true;
    exports.gamepedia.register({
        object: attribute,
        category: attributeCategory(attribute.family),
        relatedIds: [],
    });
}
for (const building of buildings_1.buildingDefinitions) {
    const relatedIds = [
        ...building.costs.map(({ resource }) => resource),
        "buildingCostMultiplier",
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
    exports.gamepedia.register({
        object: building,
        category: "building",
        relatedIds: [...new Set(relatedIds)],
    });
}
for (const upgrade of upgrades_1.upgradeDefinitions) {
    const relatedIds = [
        ...upgrade.costs.map(({ resource }) => resource),
        ...upgrade.bonuses.map(({ destination }) => String(destination).split(".")[0]),
    ];
    // seen stays false at registration: upgrades are revealed when their
    // unlock condition fires (App reveals on every state change).
    exports.gamepedia.register({
        object: upgrade,
        category: "upgrade",
        relatedIds: [...new Set(relatedIds)],
    });
}
for (const encounter of encounters_1.encounterDefinitions) {
    const relatedIds = [
        ...encounter.bonuses.map(({ destination }) => String(destination)),
        // Battles link to every unit in the opposing army; buildRelations() makes
        // the reverse unit → battle link.
        ...encounter.enemyArmy.map(({ unitId }) => unitId),
    ];
    exports.gamepedia.register({
        object: encounter,
        category: "combat",
        relatedIds: [...new Set(relatedIds)],
    });
}
for (const unit of units_1.unitDefinitions) {
    // Units are revealed when their roster window opens (App reveals on state
    // change); seen stays false at registration.
    exports.gamepedia.register({
        object: unit,
        category: "unit",
        relatedIds: [...new Set(unit.costs.map(({ resource }) => resource))],
    });
}
for (const achievement of achievements_1.achievementDefinitions) {
    // seen stays false at registration: an achievement is a permanent record that
    // appears in the Gamepedia the moment it is earned (App reveals on every
    // state change), per AGENTS.md §13.4.
    exports.gamepedia.register({
        object: achievement,
        category: "achievement",
        relatedIds: [...new Set(achievementRelatedIds(achievement))],
    });
}
exports.gamepedia.buildRelations();
const buildingsForResource = (resourceId) => exports.gamepedia
    .all()
    .filter(({ category, relatedIds }) => category === "building" && relatedIds.includes(resourceId))
    .map(({ object }) => object);
exports.buildingsForResource = buildingsForResource;
