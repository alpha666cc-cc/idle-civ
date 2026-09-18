"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upgradeDefinitions = exports.UpgradeDefinition = void 0;
const upgrades_json_1 = __importDefault(require("./data/upgrades.json"));
const expNumber_1 = require("./expNumber");
const gameObject_1 = require("./gameObject");
const buildings_1 = require("./buildings");
const bonus_1 = require("./bonus");
/** A one-shot purchase that permanently applies its bonuses (limit of one). */
class UpgradeDefinition extends gameObject_1.GameObject {
    constructor(key, name, description, costs, bonuses, unlock) {
        super(key, description);
        this.key = key;
        this.name = name;
        this.costs = costs;
        this.bonuses = bonuses;
        this.unlock = unlock;
    }
}
exports.UpgradeDefinition = UpgradeDefinition;
const toUpgradeDefinition = (data) => new UpgradeDefinition(data.key, data.name, data.description, data.costs.map(({ resource, base, factor }) => ({
    resource,
    base: expNumber_1.ExpNumber.from(base),
    factor,
})), data.bonuses.map(({ type, destination, value }) => ({
    type: (0, bonus_1.parseBonusType)(type),
    destination,
    value: expNumber_1.ExpNumber.fromNumber(value),
})), {
    source: "building-count",
    building: data.building,
    threshold: data.threshold,
});
for (const data of upgrades_json_1.default) {
    if (!buildings_1.buildingDefinitions.some(({ key }) => key === data.building)) {
        throw new Error(`Unknown upgrade building: ${data.building}`);
    }
}
exports.upgradeDefinitions = upgrades_json_1.default.map(toUpgradeDefinition);
