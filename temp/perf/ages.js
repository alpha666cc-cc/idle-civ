"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ageOfUnit = exports.findAgeDefinition = exports.ageDefinitions = exports.AgeDefinition = void 0;
const ages_json_1 = __importDefault(require("./data/ages.json"));
const gameObject_1 = require("./gameObject");
/** One age in the campaign: a population band with a name and optional unlocks. */
class AgeDefinition extends gameObject_1.GameObject {
    constructor(key, name, description, populationThreshold, unlocks = []) {
        super(key, description);
        this.key = key;
        this.name = name;
        this.description = description;
        this.populationThreshold = populationThreshold;
        this.unlocks = unlocks;
    }
}
exports.AgeDefinition = AgeDefinition;
const toAgeDefinition = (data) => new AgeDefinition(data.key, data.name, data.description, data.populationThreshold, data.unlocks ?? []);
exports.ageDefinitions = ages_json_1.default.map(toAgeDefinition);
const findAgeDefinition = (ageId) => exports.ageDefinitions.find(({ key }) => key === ageId);
exports.findAgeDefinition = findAgeDefinition;
/** The age that owns a unit, so the engine can retire N-2 units on entry. */
const ageOfUnit = (unitAge) => unitAge;
exports.ageOfUnit = ageOfUnit;
