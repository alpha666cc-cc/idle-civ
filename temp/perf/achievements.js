"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextHoarderExponent = exports.findAchievementDefinition = exports.materializeOpenEndedTier = exports.aggregateHoarderDefinition = exports.chainFamilyForId = exports.openEndedHoarderChains = exports.achievementDefinitions = exports.AchievementDefinition = void 0;
const achievements_json_1 = __importDefault(require("./data/achievements.json"));
const bonus_1 = require("./bonus");
const expNumber_1 = require("./expNumber");
const gameObject_1 = require("./gameObject");
const buildings_1 = require("./buildings");
const encounters_1 = require("./encounters");
const attributes_1 = require("./attributes");
const numberFormat_1 = require("./numberFormat");
/**
 * An achievement is a permanent record, but it may still carry a **reward**: a
 * bonus list applied for as long as the achievement is earned (AGENTS.md §13.1,
 * §13.4 — rewards are bonuses, only *unlock lists* stay off achievements).
 */
class AchievementDefinition extends gameObject_1.GameObject {
    constructor(key, name, description, requirement, bonuses = [], family, tier) {
        super(key, description);
        this.key = key;
        this.name = name;
        this.requirement = requirement;
        this.bonuses = bonuses;
        this.family = family;
        this.tier = tier;
    }
}
exports.AchievementDefinition = AchievementDefinition;
const toRequirement = (data) => {
    switch (data.type) {
        case "resource":
            return {
                type: "resource",
                resource: data.resource,
                amount: expNumber_1.ExpNumber.fromNumber(data.amount),
            };
        case "population":
            return { type: "population", amount: expNumber_1.ExpNumber.fromNumber(data.amount) };
        case "clicks":
            return { type: "clicks", amount: expNumber_1.ExpNumber.fromNumber(data.amount) };
        case "building-count":
            return {
                type: "building-count",
                building: data.building,
                count: data.count,
            };
        case "buildings-total":
            return { type: "buildings-total", count: data.count };
        case "encounter":
            return { type: "encounter", encounterId: data.encounterId };
        case "upgrade-count":
            return { type: "upgrade-count", count: data.count };
    }
};
for (const data of achievements_json_1.default) {
    const { requirement } = data;
    if (requirement.type === "building-count" &&
        !buildings_1.buildingDefinitions.some(({ key }) => key === requirement.building)) {
        throw new Error(`Unknown achievement building: ${requirement.building}`);
    }
    if (requirement.type === "encounter" &&
        !encounters_1.encounterDefinitions.some(({ key }) => key === requirement.encounterId)) {
        throw new Error(`Unknown achievement encounter: ${requirement.encounterId}`);
    }
}
exports.achievementDefinitions = achievements_json_1.default.map((data) => new AchievementDefinition(data.key, data.name, data.description, toRequirement(data.requirement), (data.bonuses ?? []).map(({ type, destination, value }) => ({
    type: (0, bonus_1.parseBonusType)(type),
    destination,
    value: expNumber_1.ExpNumber.fromNumber(value),
})), data.family, data.tier));
exports.openEndedHoarderChains = [
    { family: "food-hoarder", resource: "food", startExponent: 9, exponentStep: 3, label: "Food Hoarder" },
    { family: "wood-hoarder", resource: "wood", startExponent: 9, exponentStep: 3, label: "Wood Hoarder" },
    { family: "stone-hoarder", resource: "stone", startExponent: 9, exponentStep: 3, label: "Stone Hoarder" },
    { family: "gold-hoarder", resource: "gold", startExponent: 9, exponentStep: 3, label: "Gold Hoarder" },
];
const chainForId = (id) => {
    for (const chain of exports.openEndedHoarderChains) {
        const prefix = `${chain.family}-e`;
        if (!id.startsWith(prefix))
            continue;
        const parts = id.slice(prefix.length).split("-through-e");
        if (parts.length > 2)
            return undefined;
        const exponent = Number(parts[0]);
        const endExponent = Number(parts[1] ?? parts[0]);
        if (![exponent, endExponent].every((value) => Number.isSafeInteger(value) && value >= chain.startExponent &&
            (value - chain.startExponent) % chain.exponentStep === 0) || endExponent < exponent)
            return undefined;
        return { chain, exponent, endExponent };
    }
    return undefined;
};
/** The open-ended chain family an id belongs to, or undefined for anything else. */
const chainFamilyForId = (id) => exports.openEndedHoarderChains.find(({ family }) => id.startsWith(`${family}-e`))
    ?.family;
exports.chainFamilyForId = chainFamilyForId;
const aggregateDefinitions = new Map();
/**
 * One aggregate record per open-ended chain family (`<family>-total`): the
 * Gamepedia registers this instead of one entry per exponent tier, and the
 * summed chain reward reaches the player as a single factor row on the
 * resource page (the engine sums the earned tiers at read time).
 */
const aggregateHoarderDefinition = (family) => {
    const cached = aggregateDefinitions.get(family);
    if (cached)
        return cached;
    const chain = exports.openEndedHoarderChains.find(({ family: chainFamily }) => chainFamily === family);
    if (!chain)
        return undefined;
    const resourceLabel = (0, attributes_1.findAttributeDefinition)(chain.resource)?.label ?? chain.resource;
    const definition = new AchievementDefinition(`${family}-total`, `${chain.label} — total`, `Open-ended hoarder chain: each further 1e${chain.exponentStep} milestone in held ${resourceLabel.toLowerCase()} earns another tier. The summed reward applies as one production bonus, listed on the ${resourceLabel.toLowerCase()} page.`, {
        type: "resource",
        resource: chain.resource,
        amount: expNumber_1.ExpNumber.fromLog10(chain.startExponent),
    }, [], chain.family, chain.startExponent);
    aggregateDefinitions.set(family, definition);
    return definition;
};
exports.aggregateHoarderDefinition = aggregateHoarderDefinition;
const materializedTiers = new Map();
/** Builds the synthetic achievement tier for an open-ended chain milestone. */
const materializeOpenEndedTier = (chain, exponent) => {
    const key = `${chain.family}-e${exponent}`;
    const cached = materializedTiers.get(key);
    if (cached)
        return cached;
    const threshold = expNumber_1.ExpNumber.fromLog10(exponent);
    const resourceLabel = (0, attributes_1.findAttributeDefinition)(chain.resource)?.label ?? chain.resource;
    const definition = new AchievementDefinition(key, chain.label, `Hold ${(0, numberFormat_1.formatNumber)(threshold, "named")} ${resourceLabel.toLowerCase()}. Reward: +${exponent} ${resourceLabel.toLowerCase()}/sec.`, { type: "resource", resource: chain.resource, amount: threshold }, [
        {
            type: "attributeFlat",
            destination: chain.resource,
            value: expNumber_1.ExpNumber.fromNumber(exponent),
        },
    ], chain.family, exponent);
    materializedTiers.set(key, definition);
    return definition;
};
exports.materializeOpenEndedTier = materializeOpenEndedTier;
/**
 * Resolves any achievement id — concrete data or a materialized open-ended tier —
 * so bonus application and the Gamepedia treat both shapes identically.
 */
const findAchievementDefinition = (id) => {
    const concrete = exports.achievementDefinitions.find(({ key }) => key === id);
    if (concrete)
        return concrete;
    const match = chainForId(id);
    if (!match)
        return undefined;
    if (match.exponent === match.endExponent) {
        return (0, exports.materializeOpenEndedTier)(match.chain, match.exponent);
    }
    const cached = materializedTiers.get(id);
    if (cached)
        return cached;
    const { chain, exponent, endExponent } = match;
    const count = (endExponent - exponent) / chain.exponentStep + 1;
    const reward = expNumber_1.ExpNumber.fromNumber(exponent)
        .add(expNumber_1.ExpNumber.fromNumber(endExponent))
        .mul(expNumber_1.ExpNumber.fromNumber(count))
        .div(expNumber_1.ExpNumber.fromNumber(2));
    const definition = new AchievementDefinition(id, chain.label, `Hoarder milestones from 1e${exponent} through 1e${endExponent}. Rewards from every tier are included.`, { type: "resource", resource: chain.resource, amount: expNumber_1.ExpNumber.fromLog10(endExponent) }, [{ type: "attributeFlat", destination: chain.resource, value: reward }], chain.family, endExponent);
    materializedTiers.set(id, definition);
    return definition;
};
exports.findAchievementDefinition = findAchievementDefinition;
/** Next unearned exponent, independent of resources subsequently spent. */
const nextHoarderExponent = (chain, earnedIds) => earnedIds.reduce((next, id) => {
    const match = chainForId(id);
    return match?.chain.family === chain.family
        ? Math.max(next, match.endExponent + chain.exponentStep)
        : next;
}, chain.startExponent);
exports.nextHoarderExponent = nextHoarderExponent;
