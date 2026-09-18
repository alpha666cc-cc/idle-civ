"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeResourceRate = exports.summarizeResourceFactors = exports.emptyResourceFactors = exports.emptyWorkerAssignments = exports.emptyResourceAmounts = exports.producerResourceKeys = exports.findAttributeDefinition = exports.attributeDefinitions = exports.wastedResourcesDefinition = exports.buildingPowerAttributeDefinitions = exports.derivedAttributeDefinitions = exports.capacityDefinitions = exports.metalworkDefinition = exports.militaryDefinition = exports.scienceDefinition = exports.populationDefinition = exports.productionDefinitions = exports.AttributeDefinition = void 0;
const stats_json_1 = __importDefault(require("./data/stats.json"));
const buildings_1 = require("./buildings");
const expNumber_1 = require("./expNumber");
const gameObject_1 = require("./gameObject");
const attributeDescription = (family, label) => family === "amount" ? `${label} resource` : `${label} attribute`;
class AttributeDefinition extends gameObject_1.GameObject {
    constructor(key, label, family, description, productionPerWorker = 1) {
        super(key, description ?? attributeDescription(family, label));
        this.key = key;
        this.label = label;
        this.family = family;
        this.productionPerWorker = productionPerWorker;
    }
}
exports.AttributeDefinition = AttributeDefinition;
/** Worker-assignable production resources (§13.2). */
exports.productionDefinitions = [
    new AttributeDefinition("wood", "Wood", "amount"),
    new AttributeDefinition("stone", "Stone", "amount"),
    new AttributeDefinition("food", "Food", "amount"),
    new AttributeDefinition("gold", "Gold", "amount"),
];
exports.populationDefinition = new AttributeDefinition("population", "Population", "amount");
exports.scienceDefinition = new AttributeDefinition("science", "Science", "amount");
exports.militaryDefinition = new AttributeDefinition("military", "Military", "amount");
exports.metalworkDefinition = new AttributeDefinition("metalwork", "Metalwork", "amount");
/** Capacity is stored as a resource (§4.3): one per building, default 10. */
exports.capacityDefinitions = [
    new AttributeDefinition("peopleCapacity", "People Capacity", "capacity"),
    new AttributeDefinition("houseCapacity", "House Capacity", "capacity"),
    new AttributeDefinition("farmCapacity", "Farm Capacity", "capacity"),
    new AttributeDefinition("lumber-yardCapacity", "Lumber Yard Capacity", "capacity"),
    new AttributeDefinition("quarryCapacity", "Quarry Capacity", "capacity"),
    new AttributeDefinition("gold-mineCapacity", "Gold Mine Capacity", "capacity"),
    new AttributeDefinition("marketCapacity", "Market Capacity", "capacity"),
    new AttributeDefinition("town-hallCapacity", "Town Hall Capacity", "capacity"),
    new AttributeDefinition("smithyCapacity", "Smithy Capacity", "capacity"),
    new AttributeDefinition("barracksCapacity", "Barracks Capacity", "capacity"),
    new AttributeDefinition("universityCapacity", "University Capacity", "capacity"),
];
/**
 * Computed stats (§13.2 decision 2): `clickPower` and `autoClickRate`. They are
 * never stored — bonuses whose destination is the stat id feed their value, so
 * `+1 per click` is an ordinary `attributeFlat` bonus on `clickPower` and
 * `×2 click power` is an `attributeMultiplier` bonus.
 */
exports.derivedAttributeDefinitions = stats_json_1.default.map(({ key, label, description }) => new AttributeDefinition(key, label, "derived", description));
/**
 * Every building owns a derived power attribute (§13.2): base 1, raised by
 * bonuses targeting `<buildingKey>Power`. Derived from the building registry so
 * new buildings get their power automatically — the building list is the single
 * source of truth.
 */
exports.buildingPowerAttributeDefinitions = buildings_1.buildingDefinitions.map(({ key, name }) => new AttributeDefinition(`${key}Power`, `${name} power`, "derived", `${name} power multiplies this building's effects. Milestones raise it.`));
/** Every attribute definition, in Gamepedia registration order. */
exports.derivedAttributeDefinitions.push(...exports.buildingPowerAttributeDefinitions);
/** Wasted resources: accumulated resource cost of retired units (§Age system). */
exports.wastedResourcesDefinition = new AttributeDefinition("wastedResources", "Wasted Resources", "derived", "Resources spent on units that were retired at an age boundary.");
exports.derivedAttributeDefinitions.push(exports.wastedResourcesDefinition);
exports.attributeDefinitions = [
    ...exports.productionDefinitions,
    exports.populationDefinition,
    exports.scienceDefinition,
    exports.militaryDefinition,
    exports.metalworkDefinition,
    ...exports.capacityDefinitions,
    ...exports.derivedAttributeDefinitions,
];
const findAttributeDefinition = (key) => exports.attributeDefinitions.find(({ key: attributeKey }) => attributeKey === key);
exports.findAttributeDefinition = findAttributeDefinition;
/** Resources whose amount accrues per tick: worker production + building output. */
exports.producerResourceKeys = [
    ...exports.productionDefinitions.map(({ key }) => key),
    exports.scienceDefinition.key,
    exports.militaryDefinition.key,
    exports.metalworkDefinition.key,
];
const emptyResourceAmounts = () => ({
    food: expNumber_1.ExpNumber.ZERO,
    wood: expNumber_1.ExpNumber.ZERO,
    stone: expNumber_1.ExpNumber.ZERO,
    gold: expNumber_1.ExpNumber.ZERO,
    population: expNumber_1.ExpNumber.ZERO,
    science: expNumber_1.ExpNumber.ZERO,
    military: expNumber_1.ExpNumber.ZERO,
    metalwork: expNumber_1.ExpNumber.ZERO,
    peopleCapacity: expNumber_1.ExpNumber.ZERO,
    houseCapacity: expNumber_1.ExpNumber.ZERO,
    farmCapacity: expNumber_1.ExpNumber.fromNumber(10),
    "lumber-yardCapacity": expNumber_1.ExpNumber.fromNumber(10),
    quarryCapacity: expNumber_1.ExpNumber.fromNumber(10),
    "gold-mineCapacity": expNumber_1.ExpNumber.fromNumber(10),
    marketCapacity: expNumber_1.ExpNumber.fromNumber(10),
    "town-hallCapacity": expNumber_1.ExpNumber.fromNumber(1),
    smithyCapacity: expNumber_1.ExpNumber.fromNumber(10),
    barracksCapacity: expNumber_1.ExpNumber.fromNumber(10),
    universityCapacity: expNumber_1.ExpNumber.fromNumber(10),
});
exports.emptyResourceAmounts = emptyResourceAmounts;
const emptyWorkerAssignments = () => ({
    food: expNumber_1.ExpNumber.ZERO,
    wood: expNumber_1.ExpNumber.ZERO,
    stone: expNumber_1.ExpNumber.ZERO,
    gold: expNumber_1.ExpNumber.ZERO,
});
exports.emptyWorkerAssignments = emptyWorkerAssignments;
const emptyResourceFactors = () => ({
    food: { additional: [], multiplicative: [], drain: [] },
    wood: { additional: [], multiplicative: [], drain: [] },
    stone: { additional: [], multiplicative: [], drain: [] },
    gold: { additional: [], multiplicative: [], drain: [] },
    population: { additional: [], multiplicative: [], drain: [] },
    science: { additional: [], multiplicative: [], drain: [] },
    military: { additional: [], multiplicative: [], drain: [] },
    metalwork: { additional: [], multiplicative: [], drain: [] },
    peopleCapacity: { additional: [], multiplicative: [], drain: [] },
    houseCapacity: { additional: [], multiplicative: [], drain: [] },
    farmCapacity: { additional: [], multiplicative: [], drain: [] },
    "lumber-yardCapacity": { additional: [], multiplicative: [], drain: [] },
    quarryCapacity: { additional: [], multiplicative: [], drain: [] },
    "gold-mineCapacity": { additional: [], multiplicative: [], drain: [] },
    marketCapacity: { additional: [], multiplicative: [], drain: [] },
    "town-hallCapacity": { additional: [], multiplicative: [], drain: [] },
    smithyCapacity: { additional: [], multiplicative: [], drain: [] },
    barracksCapacity: { additional: [], multiplicative: [], drain: [] },
    universityCapacity: { additional: [], multiplicative: [], drain: [] },
});
exports.emptyResourceFactors = emptyResourceFactors;
const summarizeResourceFactors = ({ additional, multiplicative, drain, }) => {
    const additionalTotal = additional.reduce((total, [, value]) => total.add(value), expNumber_1.ExpNumber.ZERO);
    const multiplier = multiplicative.reduce((total, [, value]) => total.mul(value), expNumber_1.ExpNumber.ONE);
    const drainTotal = drain.reduce((total, [, value]) => total.add(value), expNumber_1.ExpNumber.ZERO);
    return {
        additional: additionalTotal,
        multiplier,
        drain: drainTotal,
        result: additionalTotal.mul(multiplier).sub(drainTotal),
    };
};
exports.summarizeResourceFactors = summarizeResourceFactors;
const computeResourceRate = (factors) => (0, exports.summarizeResourceFactors)(factors).result;
exports.computeResourceRate = computeResourceRate;
