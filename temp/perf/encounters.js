"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findEncounterDefinition = exports.encounterDefinitions = exports.EncounterDefinition = void 0;
const encounters_json_1 = __importDefault(require("./data/encounters.json"));
const bonus_1 = require("./bonus");
const expNumber_1 = require("./expNumber");
const gameObject_1 = require("./gameObject");
const units_1 = require("./units");
/**
 * A battle (AGENTS.md §13.4/§14, roadmap Milestone 8). Encounters are ordered:
 * the campaign is a sequence and the engine offers the first battle not yet won.
 * A battle owns its enemy army, its victory bonuses, the unit ids its victory
 * unlocks, and the enemy's "fake research" boosts that keep an older enemy army
 * relevant in its own age.
 */
class EncounterDefinition extends gameObject_1.GameObject {
    constructor(key, name, description, age, year, isBoss, enemyArmy, enemyBoosts, bonuses, unlocks, historical) {
        super(key, description);
        this.key = key;
        this.name = name;
        this.age = age;
        this.year = year;
        this.isBoss = isBoss;
        this.historical = historical;
        this.enemyArmy = enemyArmy;
        this.enemyBoosts = enemyBoosts;
        this.bonuses = bonuses;
        this.unlocks = unlocks;
    }
    /** Total enemy units committed, for the battle card's summary line. */
    get enemyUnitCount() {
        return this.enemyArmy.reduce((total, stack) => total + stack.count, 0);
    }
}
exports.EncounterDefinition = EncounterDefinition;
const toBonus = (data) => ({
    type: (0, bonus_1.parseBonusType)(data.type),
    destination: data.destination,
    value: expNumber_1.ExpNumber.fromNumber(data.value),
});
const toEncounterDefinition = (data) => new EncounterDefinition(data.key, data.name, data.description, data.age, data.year, data.isBoss, data.enemyArmy.map(({ unitId, count, label }) => ({
    unitId,
    count,
    label,
})), data.enemyBoosts.map(toBonus), data.bonuses.map(toBonus), data.unlocks, data.historical);
exports.encounterDefinitions = encounters_json_1.default.map(toEncounterDefinition);
const findEncounterDefinition = (encounterId) => exports.encounterDefinitions.find(({ key }) => key === encounterId);
exports.findEncounterDefinition = findEncounterDefinition;
// A typo in the campaign data would otherwise silently drop a stack or leave a
// unit permanently locked, so fail loudly at import time (as upgrades.ts does).
for (const encounter of exports.encounterDefinitions) {
    for (const stack of encounter.enemyArmy) {
        if (!(0, units_1.findUnitDefinition)(stack.unitId)) {
            throw new Error(`Unknown enemy unit in ${encounter.key}: ${stack.unitId}`);
        }
    }
    for (const unitId of encounter.unlocks) {
        if (!(0, units_1.findUnitDefinition)(unitId)) {
            throw new Error(`Unknown unlock in ${encounter.key}: ${unitId}`);
        }
    }
}
