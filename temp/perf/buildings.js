"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildingDefinitions = exports.BuildingDefinition = void 0;
const gameObject_1 = require("./gameObject");
const expNumber_1 = require("./expNumber");
const numberFormat_1 = require("./numberFormat");
const buildings_json_1 = __importDefault(require("./data/buildings.json"));
class BuildingDefinition extends gameObject_1.GameObject {
    constructor(key, name, description, costs, available, maxCount = 10, effects = {}, unlock) {
        super(key, description);
        this.key = key;
        this.name = name;
        this.description = description;
        this.costs = costs;
        this.available = available;
        this.maxCount = maxCount;
        this.effects = effects;
        this.unlock = unlock;
    }
    costAt(buildingsAlreadyBuilt) {
        return this.costs.map((cost) => ({
            ...cost,
            base: expNumber_1.ExpNumber.from(cost.base)
                .mul(expNumber_1.ExpNumber.fromNumber(cost.factor).pow(buildingsAlreadyBuilt))
                .ceil(),
        }));
    }
    formatCost(buildingsAlreadyBuilt) {
        return this.costAt(buildingsAlreadyBuilt)
            .map(({ resource, base }) => `${(0, numberFormat_1.formatNumber)(base, "named")} ${resource}`)
            .join(" + ");
    }
}
exports.BuildingDefinition = BuildingDefinition;
const toBuildingDefinition = (data) => {
    const effects = data.effects;
    return new BuildingDefinition(data.key, data.name, data.description, data.costs.map(({ resource, base, factor }) => ({
        resource,
        base: expNumber_1.ExpNumber.fromNumber(base),
        factor,
    })), data.available, data.maxCount, effects
        ? {
            capacityProvided: effects.capacityProvided
                ? {
                    building: effects.capacityProvided.building,
                    perBuilding: expNumber_1.ExpNumber.fromNumber(effects.capacityProvided.perBuilding),
                }
                : undefined,
            resourceMultiplier: effects.resourceMultiplier
                ? {
                    resource: effects.resourceMultiplier.resource,
                    factor: expNumber_1.ExpNumber.fromNumber(effects.resourceMultiplier.factor),
                }
                : undefined,
            resourceDrain: effects.resourceDrain
                ? {
                    resource: effects.resourceDrain.resource,
                    amount: expNumber_1.ExpNumber.fromNumber(effects.resourceDrain.amount),
                }
                : undefined,
            resourceProduction: effects.resourceProduction
                ? {
                    resource: effects.resourceProduction.resource,
                    amount: expNumber_1.ExpNumber.fromNumber(effects.resourceProduction.amount),
                }
                : undefined,
        }
        : undefined, data.unlock);
};
exports.buildingDefinitions = buildings_json_1.default.map(toBuildingDefinition);
