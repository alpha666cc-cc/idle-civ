"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectCostReductions = exports.parseBonusType = exports.costReductionBonus = exports.capacityMultiplierBonus = exports.attributeBonus = void 0;
const expNumber_1 = require("./expNumber");
const attributeBonus = (type, destination, value) => ({ type, destination, value: expNumber_1.ExpNumber.from(value) });
exports.attributeBonus = attributeBonus;
/**
 * Capacity keeps its own representation (§13.7 decision 3): a capacity multiplier is an
 * `attributeMultiplier` whose destination is the capacity resource, so the capacity door
 * stays open for flat grants and future multiplier variants alike.
 */
const capacityMultiplierBonus = (building, factor) => ({
    type: "attributeMultiplier",
    destination: `${building}Capacity`,
    value: expNumber_1.ExpNumber.from(factor),
});
exports.capacityMultiplierBonus = capacityMultiplierBonus;
const costReductionBonus = (type, buyableId, value) => ({ type, destination: buyableId, value: expNumber_1.ExpNumber.from(value) });
exports.costReductionBonus = costReductionBonus;
const bonusTypes = [
    "attributeFlat",
    "attributeMultiplier",
    "attributeDrain",
    "costReductionFlat",
    "costReductionPercent",
    "costReductionBase",
    "costReductionFactor",
];
/**
 * Validates a bonus type arriving from JSON data. Definition payloads are
 * `as`-cast, so a stale type string would otherwise match no engine branch and
 * silently no-op; this fails loudly instead.
 */
const parseBonusType = (type) => {
    if (bonusTypes.includes(type))
        return type;
    throw new Error(`Unknown bonus type: ${type}`);
};
exports.parseBonusType = parseBonusType;
/**
 * Folds every cost-reduction bonus targeting one buyable into the per-unit adjustment
 * record the engine applies inside `getBuildingCost()` in the fixed order
 * `base → factor → percent → flat`.
 */
const collectCostReductions = (bonuses) => {
    const reductions = {
        base: expNumber_1.ExpNumber.ONE,
        factor: expNumber_1.ExpNumber.ZERO,
        percent: expNumber_1.ExpNumber.ONE,
        flat: expNumber_1.ExpNumber.ZERO,
    };
    for (const bonus of bonuses) {
        switch (bonus.type) {
            case "costReductionBase":
                reductions.base = reductions.base.mul(expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ZERO, expNumber_1.ExpNumber.ONE.sub(bonus.value)));
                break;
            case "costReductionFactor":
                reductions.factor = reductions.factor.add(bonus.value);
                break;
            case "costReductionPercent":
                reductions.percent = reductions.percent.mul(expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ZERO, expNumber_1.ExpNumber.ONE.sub(bonus.value)));
                break;
            case "costReductionFlat":
                reductions.flat = reductions.flat.add(bonus.value);
                break;
            default:
                break;
        }
    }
    return reductions;
};
exports.collectCostReductions = collectCostReductions;
