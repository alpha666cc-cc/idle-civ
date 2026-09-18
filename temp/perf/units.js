"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.unitPower = exports.effectiveHitPoints = exports.maximumArmor = exports.unitStatTargetLabel = exports.unitsForStatTarget = exports.unitMatchesStatTarget = exports.parseUnitStatTarget = exports.isBuyableUnit = exports.findUnitDefinition = exports.unitDefinitions = exports.UnitDefinition = exports.unitDomainLabels = exports.unitStatLabels = exports.unitStatKeys = void 0;
const units_json_1 = __importDefault(require("./data/units.json"));
const expNumber_1 = require("./expNumber");
const gameObject_1 = require("./gameObject");
exports.unitStatKeys = [
    "hp",
    "attack",
    "armor",
    "range",
    "speed",
    "accuracy",
];
exports.unitStatLabels = {
    hp: "Health",
    attack: "Attack",
    armor: "Armour",
    range: "Range",
    speed: "Speed",
    accuracy: "Accuracy",
};
exports.unitDomainLabels = {
    ground: "Ground",
    air: "Air",
    naval: "Naval",
};
class UnitDefinition extends gameObject_1.GameObject {
    constructor(key, name, description, age, domain, tags, canHit, bonusVs, available, costs, stats) {
        super(key, description);
        this.key = key;
        this.name = name;
        this.age = age;
        this.domain = domain;
        this.tags = tags;
        this.canHit = canHit;
        this.bonusVs = bonusVs;
        this.available = available;
        this.costs = costs;
        this.stats = stats;
    }
    /** "Ground · infantry, armored" — the domain/tags line in the Gamepedia. */
    get typeSummary() {
        return [exports.unitDomainLabels[this.domain], this.tags.join(", ")]
            .filter((part) => part.length > 0)
            .join(" · ");
    }
    /** Domains this unit can shoot at, for the "can hit" line. */
    get targetSummary() {
        return this.canHit.map((domain) => exports.unitDomainLabels[domain]).join(", ");
    }
}
exports.UnitDefinition = UnitDefinition;
const toUnitDefinition = (data) => new UnitDefinition(data.id, data.name, data.description, data.age, data.domain, data.tags, data.canHit, data.bonusVs ?? [], data.available, data.costs?.map(({ resource, base, factor }) => ({
    resource,
    base: expNumber_1.ExpNumber.from(base),
    factor,
})) ?? [], {
    hp: expNumber_1.ExpNumber.fromNumber(data.hp),
    attack: expNumber_1.ExpNumber.fromNumber(data.attack),
    armor: data.armor,
    range: data.range,
    speed: data.speed,
    accuracy: data.accuracy,
});
exports.unitDefinitions = units_json_1.default.map(toUnitDefinition);
const findUnitDefinition = (unitId) => exports.unitDefinitions.find(({ key }) => key === unitId);
exports.findUnitDefinition = findUnitDefinition;
/** Units the player can ever buy; `false` for enemy-only beasts. */
const isBuyableUnit = (unit) => unit.costs.length > 0;
exports.isBuyableUnit = isBuyableUnit;
const unitStatPattern = new RegExp("^([a-z0-9-]+)\\.(hp|attack|armor|range|speed|accuracy)$");
const tagStatPattern = new RegExp("^tag\\.([a-z-]+)\\.(hp|attack|armor|range|speed|accuracy)$");
const allStatPattern = new RegExp("^unitAll\\.(hp|attack|armor|range|speed|accuracy)$");
const parseUnitStatTarget = (destination) => {
    const all = allStatPattern.exec(destination);
    if (all)
        return { scope: "all", stat: all[1] };
    const tag = tagStatPattern.exec(destination);
    if (tag)
        return { scope: "tag", tag: tag[1], stat: tag[2] };
    const unit = unitStatPattern.exec(destination);
    if (unit && (0, exports.findUnitDefinition)(unit[1])) {
        return { scope: "unit", unitId: unit[1], stat: unit[2] };
    }
    return undefined;
};
exports.parseUnitStatTarget = parseUnitStatTarget;
const unitMatchesStatTarget = (unit, target) => target.scope === "all"
    ? true
    : target.scope === "tag"
        ? unit.tags.includes(target.tag)
        : unit.key === target.unitId;
exports.unitMatchesStatTarget = unitMatchesStatTarget;
/** Units a destination reaches, so the Gamepedia can link modifiers both ways. */
const unitsForStatTarget = (target) => exports.unitDefinitions.filter((unit) => (0, exports.unitMatchesStatTarget)(unit, target));
exports.unitsForStatTarget = unitsForStatTarget;
const unitStatTargetLabel = (target) => {
    const stat = exports.unitStatLabels[target.stat].toLowerCase();
    if (target.scope === "all")
        return `every unit's ${stat}`;
    if (target.scope === "tag")
        return `${target.tag} units' ${stat}`;
    return `${(0, exports.findUnitDefinition)(target.unitId)?.name ?? target.unitId} ${stat}`;
};
exports.unitStatTargetLabel = unitStatTargetLabel;
/** Armour is capped below 1: a hit always lands at least some damage. */
exports.maximumArmor = 0.9;
/** Effective hit points — armour divides incoming damage, so it multiplies HP. */
const effectiveHitPoints = (stats) => stats.hp.div(expNumber_1.ExpNumber.ONE.sub(expNumber_1.ExpNumber.fromNumber(Math.min(stats.armor, exports.maximumArmor))));
exports.effectiveHitPoints = effectiveHitPoints;
/**
 * Army power (AGENTS.md §14): `attack × accuracy × √(effective HP)` per unit,
 * summed over stacks by the caller. It is a heuristic — range, speed and domain
 * matchups decide who can shoot whom and are not priced in — but it is monotone
 * in every combat stat and predicts the stack model well under the square law.
 */
const unitPower = (stats) => stats.attack
    .mul(expNumber_1.ExpNumber.fromNumber(stats.accuracy))
    .mul((0, exports.effectiveHitPoints)(stats).pow(0.5));
exports.unitPower = unitPower;
