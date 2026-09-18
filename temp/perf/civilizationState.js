"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CivilizationState = void 0;
const attributes_1 = require("./attributes");
const expNumber_1 = require("./expNumber");
const workerProduction_1 = require("./workerProduction");
const buildings_1 = require("./buildings");
const achievements_1 = require("./achievements");
const battle_1 = require("./battle");
const encounters_1 = require("./encounters");
const units_1 = require("./units");
const statistics_1 = require("./statistics");
const upgrades_1 = require("./upgrades");
const bonus_1 = require("./bonus");
const ages_1 = require("./ages");
/** Units have no capacity limit (§13.3), so the MAX probe stops here. */
const maximumUnitPurchase = 1000000;
/**
 * Identity-keyed recompute caches. Every state array is replaced immutably and
 * never mutated, so array identity is a free "did anything change" test: a tick
 * that changes nothing reuses the cached values, and the one call after a real
 * change (a build, purchase, victory or earn) rebuilds once. This keeps tick
 * cost independent of building count and earned-achievement count.
 */
const buildingCountCaches = new WeakMap();
const earnedAchievementSets = new WeakMap();
const activeBonusCaches = new WeakMap();
/**
 * The largest N for which `canAffordCount(N)` holds, given per-unit costs that
 * never decrease. A doubling probe finds a tight upper bound and a binary search
 * finishes, so the whole thing is O(log N) evaluations of an O(1) cost check —
 * shared by buildings and units so both keep buy-N and buy-MAX on one evaluator.
 */
const maxAffordableCount = (canAffordCount, upperBound) => {
    if (!canAffordCount(1))
        return 0;
    let probe = 1;
    while (probe < upperBound && canAffordCount(probe * 2)) {
        probe *= 2;
    }
    if (probe >= upperBound && canAffordCount(upperBound))
        return upperBound;
    let low = probe;
    let high = Math.min(probe * 2, upperBound);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (canAffordCount(middle)) {
            low = middle;
        }
        else {
            high = middle - 1;
        }
    }
    return low;
};
const capacityKey = (buildingKey) => `${buildingKey}Capacity`;
/**
 * Factor-source label for a manual click. It is the click power stat's id, so the
 * Gamepedia factor list links the row to the stat page (§13.2 decision 2).
 */
const clickPowerStatSource = attributes_1.derivedAttributeDefinitions.find(({ key }) => key === "clickPower")?.key ??
    "manual click";
/**
 * Per-derived-attribute computations (§13.2): stats are never stored, so each one
 * states how its value and its bonus-free base are read. New computed attributes
 * arrive by extending this record — no per-content branching elsewhere.
 */
const derivedAttributeComputations = {
    clickPower: {
        value: (state) => state.computeClickPower(),
        base: () => expNumber_1.ExpNumber.ONE,
    },
    autoClickRate: {
        value: (state) => expNumber_1.ExpNumber.fromNumber(state.autoClicksPerSecond),
        base: (state) => expNumber_1.ExpNumber.fromNumber(state.autoClicksPerSecond),
    },
    armyPower: {
        // Like the auto-click rate, the base *is* the current reading: army power is
        // summed from unit stats, so no bonus targets this attribute directly.
        value: (state) => state.getArmyPower(),
        base: (state) => state.getArmyPower(),
    },
};
/**
 * Compound stats (base 1, flats sum, multipliers compound) — the same rule as
 * `computeClickPower()`, applied to the global building power and to every
 * building's own power attribute. Building powers also fold in the global
 * layer through the synthetic row added by `getDerivedAttributeFactors()`.
 */
const compoundStatValue = (state, key) => {
    const factors = state.getDerivedAttributeFactors(key);
    if (!factors)
        return expNumber_1.ExpNumber.ONE;
    const flat = factors.additional.reduce((total, [, value]) => total.add(value), factors.base);
    const multiplier = factors.multiplicative.reduce((total, [, value]) => total.mul(value), expNumber_1.ExpNumber.ONE);
    return flat.mul(multiplier);
};
for (const key of [
    "buildingPower",
    "buildingCostMultiplier",
    "wastedResources",
    ...buildings_1.buildingDefinitions.map(({ key }) => `${key}Power`),
]) {
    derivedAttributeComputations[key] = {
        value: key === "wastedResources"
            ? (state) => state.statistics.wastedResources
            : (state) => compoundStatValue(state, key),
        base: () => expNumber_1.ExpNumber.ONE,
    };
}
/** Applies a tick rate to a resource amount, clamped so it never goes negative. */
const applyRate = (amount, rate) => {
    const next = amount.add(rate);
    return next.sign < 0 ? expNumber_1.ExpNumber.ZERO : next;
};
class CivilizationState {
    constructor(resources = (0, attributes_1.emptyResourceAmounts)(), workers = (0, attributes_1.emptyWorkerAssignments)(), builtBuildings = ["town-hall"], resourceFactors = (0, attributes_1.emptyResourceFactors)(), buildingCostOverrides = {}, autoClicksPerSecond = 0, boughtUpgrades = [], defeatedEncounters = [], enteredAges = [], earnedAchievements = [], statistics = (0, statistics_1.emptyStatistics)(), unitCounts = {}, devProductionMultiplier = expNumber_1.ExpNumber.ONE, freeBuildings = false, freeUnits = false) {
        this.resources = resources;
        this.workers = workers;
        this.builtBuildings = builtBuildings;
        this.resourceFactors = resourceFactors;
        this.buildingCostOverrides = buildingCostOverrides;
        this.autoClicksPerSecond = autoClicksPerSecond;
        this.boughtUpgrades = boughtUpgrades;
        this.defeatedEncounters = defeatedEncounters;
        this.enteredAges = enteredAges;
        this.earnedAchievements = earnedAchievements;
        this.statistics = statistics;
        this.unitCounts = unitCounts;
        this.devProductionMultiplier = devProductionMultiplier;
        this.freeBuildings = freeBuildings;
        this.freeUnits = freeUnits;
        const houses = this.buildingCount("house");
        const townHalls = this.buildingCount("town-hall");
        const peopleFloor = expNumber_1.ExpNumber.fromNumber(houses * 10);
        this.resources.peopleCapacity = this.resources.peopleCapacity.gte(peopleFloor)
            ? this.resources.peopleCapacity
            : peopleFloor;
        const houseFloor = expNumber_1.ExpNumber.fromNumber(townHalls * 10);
        this.resources.houseCapacity = this.resources.houseCapacity.gte(houseFloor)
            ? this.resources.houseCapacity
            : houseFloor;
        this.resources.population = expNumber_1.ExpNumber.fromNumber(this.buildingCount("people"));
    }
    get population() {
        return this.resources.population;
    }
    get maximumPopulation() {
        return this.resources.peopleCapacity;
    }
    get housingCapacity() {
        return this.resources.peopleCapacity;
    }
    get assignedWorkers() {
        return Object.values(this.workers).reduce((total, count) => total + count.toNumber(), 0);
    }
    get availableWorkers() {
        return Math.floor(this.population.toNumber()) - this.assignedWorkers;
    }
    getWorkerProduction(resourceKey) {
        const definition = attributes_1.productionDefinitions.find(({ key }) => key === resourceKey);
        return new workerProduction_1.WorkerProduction(resourceKey, definition?.label ?? resourceKey, this.workers[resourceKey], definition?.productionPerWorker ?? 1, resourceKey === "population"
            ? 0
            : this.autoClicksPerSecond, 1);
    }
    gather(resourceKey) {
        if (!(resourceKey in this.resources))
            return this;
        const amount = this.computeClickGain(resourceKey);
        return this.withStatistics({
            ...this.statistics,
            productionClicks: this.statistics.productionClicks.add(expNumber_1.ExpNumber.ONE),
        }).withResources({
            ...this.resources,
            [resourceKey]: this.resources[resourceKey].add(amount),
        });
    }
    /**
     * Counts one click anywhere in the UI shell. Production clicks are counted by
     * `gather()` instead, so the UI marks its gather buttons to be skipped.
     */
    recordUiClick() {
        return this.withStatistics({
            ...this.statistics,
            uiClicks: this.statistics.uiClicks.add(expNumber_1.ExpNumber.ONE),
        });
    }
    assignWorker(resourceKey, count = 1) {
        if (!(resourceKey in this.workers) || this.availableWorkers <= 0)
            return this;
        const actualCount = Math.min(count, this.availableWorkers);
        if (actualCount <= 0)
            return this;
        return this.withWorkers({
            ...this.workers,
            [resourceKey]: this.workers[resourceKey].add(expNumber_1.ExpNumber.fromNumber(actualCount)),
        });
    }
    unassignWorker(resourceKey, count = 1) {
        if (!(resourceKey in this.workers) ||
            this.workers[resourceKey].lte(expNumber_1.ExpNumber.ZERO))
            return this;
        const actualCount = Math.min(count, this.workers[resourceKey].toNumber());
        if (actualCount <= 0)
            return this;
        return this.withWorkers({
            ...this.workers,
            [resourceKey]: this.workers[resourceKey].sub(expNumber_1.ExpNumber.fromNumber(actualCount)),
        });
    }
    /**
     * Assign all idle workers (or up to `count` when given).
     * Food workers are maintained at roughly 10 times each other resource,
     * starting with food, while equalizing the other resources among themselves.
     */
    autoAssignWorkers(count = Infinity) {
        const others = Object.keys(this.workers).filter((key) => key !== "food");
        let workers = { ...this.workers };
        let available = this.availableWorkers;
        let remaining = count;
        while (available > 0 && remaining > 0) {
            if (others.length === 0) {
                workers.food = workers.food.add(expNumber_1.ExpNumber.ONE);
                available -= 1;
                remaining -= 1;
                continue;
            }
            // Find the other resource with the minimum workers to keep others equalized
            let targetOther = others[0];
            let minOtherCount = workers[targetOther].toNumber();
            for (const key of others) {
                if (workers[key].toNumber() < minOtherCount) {
                    minOtherCount = workers[key].toNumber();
                    targetOther = key;
                }
            }
            // Start with food (first 10), then ensure food is roughly 10x the next tier of other resources
            if (workers.food.toNumber() < 10 * (minOtherCount + 1)) {
                workers.food = workers.food.add(expNumber_1.ExpNumber.ONE);
            }
            else {
                workers[targetOther] = workers[targetOther].add(expNumber_1.ExpNumber.ONE);
            }
            available -= 1;
            remaining -= 1;
        }
        return this.availableWorkers === available
            ? this
            : this.withWorkers(workers);
    }
    /** Buy every building that is currently affordable and under its cap, one pass in definition order. */
    autoBuyBuildings() {
        return buildings_1.buildingDefinitions.reduce((state, building) => {
            const next = state.build(building.key, state.getMaxAffordableBuildings(building.key));
            return next === state ? state : next;
        }, this);
    }
    isUpgradeUnlocked(upgradeId) {
        const upgrade = upgrades_1.upgradeDefinitions.find(({ key }) => key === upgradeId);
        if (!upgrade)
            return false;
        return (upgrade.unlock.source === "building-count" &&
            this.buildingCount(upgrade.unlock.building) >= upgrade.unlock.threshold);
    }
    isUpgradeBought(upgradeId) {
        return this.boughtUpgrades.includes(upgradeId);
    }
    getUpgradeCost(upgradeId) {
        return upgrades_1.upgradeDefinitions.find(({ key }) => key === upgradeId)?.costs ?? [];
    }
    hasResourcesForUpgrade(upgradeId) {
        return this.getUpgradeCost(upgradeId).every(({ resource, base }) => this.resources[resource].gte(base));
    }
    getUpgradeFailureReason(upgradeId) {
        const upgrade = upgrades_1.upgradeDefinitions.find(({ key }) => key === upgradeId);
        if (!upgrade ||
            this.isUpgradeBought(upgradeId) ||
            !this.isUpgradeUnlocked(upgradeId))
            return "locked";
        if (!this.hasResourcesForUpgrade(upgradeId))
            return "resources";
        return null;
    }
    /**
     * Buys a one-shot upgrade: pays its costs and records its id. Bonuses are never
     * accumulated into state — factors and capacities derive them from this list.
     */
    buyUpgrade(upgradeId) {
        if (this.getUpgradeFailureReason(upgradeId) !== null)
            return this;
        const upgrade = upgrades_1.upgradeDefinitions.find(({ key }) => key === upgradeId);
        if (!upgrade)
            return this;
        const resources = { ...this.resources };
        for (const { resource, base } of upgrade.costs) {
            resources[resource] = resources[resource].sub(base);
        }
        return this.withState(resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, [...this.boughtUpgrades, upgradeId]);
    }
    tick() {
        const resources = { ...this.resources };
        for (const resourceKey of attributes_1.producerResourceKeys) {
            resources[resourceKey] = applyRate(resources[resourceKey], this.computeResourceRate(resourceKey));
        }
        // One tick is one second of play time for both the lifetime counter and the
        // current run (a future prestige resets `runTimeMs` only).
        const statistics = {
            ...this.statistics,
            playTimeMs: this.statistics.playTimeMs + statistics_1.tickMilliseconds,
            runTimeMs: this.statistics.runTimeMs + statistics_1.tickMilliseconds,
        };
        // Achievements are evaluated after the tick's changes so the check always runs
        // after a domain event has landed (roadmap Milestone 6). Age-reach times are
        // recorded first, so a record reflects the tick the threshold was met.
        return this.withState(resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, statistics)
            .recordReachedAges()
            .checkAchievements();
    }
    getFactors(resourceKey) {
        const factors = this.resourceFactors[resourceKey];
        // `workers` only ever holds the four production keys, so membership is the
        // honest "is this a production resource?" test (AGENTS.md §9 guard).
        const isProductionKey = resourceKey in this.workers;
        const workerProduction = this.getWorkerProduction(resourceKey);
        const buildingFactors = {
            additional: [],
            multiplicative: [],
            drain: [],
        };
        for (const building of buildings_1.buildingDefinitions) {
            const count = this.buildingCount(building.key);
            if (count === 0)
                continue;
            const { resourceMultiplier, resourceDrain, resourceProduction } = this.getBuildingEffects(building.key, count);
            if (resourceMultiplier?.resource === resourceKey) {
                buildingFactors.multiplicative.push([
                    building.key,
                    resourceMultiplier.factor,
                ]);
            }
            if (resourceDrain?.resource === resourceKey) {
                buildingFactors.drain.push([building.key, resourceDrain.amount]);
            }
            if (resourceProduction?.resource === resourceKey) {
                buildingFactors.additional.push([
                    building.key,
                    resourceProduction.amount,
                ]);
            }
        }
        // Attribute bonuses from every source (upgrades, encounters, achievements)
        // land in the existing factor path (§13.6); drains from bonuses stay
        // unimplemented until data needs them.
        const bonusFactors = {
            additional: [],
            multiplicative: [],
            drain: [],
        };
        for (const [sourceId, bonus] of this.activeBonuses()) {
            if (String(bonus.destination) !== resourceKey)
                continue;
            if (bonus.type === "attributeMultiplier") {
                bonusFactors.multiplicative.push([sourceId, bonus.value]);
            }
            else if (bonus.type === "attributeFlat") {
                bonusFactors.additional.push([sourceId, bonus.value]);
            }
        }
        const workerAdditional = [
            [workerProduction, workerProduction.workerProduction],
        ];
        if (workerProduction.autoClickProduction.gt(expNumber_1.ExpNumber.ZERO)) {
            workerAdditional.push([
                "dev auto clicker",
                workerProduction.autoClickProduction,
            ]);
        }
        return {
            additional: [
                ...(isProductionKey ? workerAdditional : []),
                ...factors.additional,
                ...buildingFactors.additional,
                ...bonusFactors.additional,
            ],
            multiplicative: [
                ...factors.multiplicative,
                ...buildingFactors.multiplicative,
                ...bonusFactors.multiplicative,
            ],
            drain: [
                ...factors.drain,
                ...buildingFactors.drain,
                ...bonusFactors.drain,
            ],
        };
    }
    getProductionFactors(resourceKey) {
        const base = this.getFactors(resourceKey);
        if (this.devProductionMultiplier.eq(expNumber_1.ExpNumber.ONE))
            return base;
        return {
            ...base,
            multiplicative: [
                ...base.multiplicative,
                ["dev production multiplier", this.devProductionMultiplier],
            ],
        };
    }
    computeResourceRate(resourceKey) {
        return (0, attributes_1.computeResourceRate)(this.getProductionFactors(resourceKey));
    }
    computeClickGain(resourceKey) {
        const factors = this.getProductionFactors(resourceKey);
        const definition = attributes_1.productionDefinitions.find(({ key }) => key === resourceKey);
        // The global click power stat scales every manual click (§13.2 decision 2);
        // the resource's own `productionPerWorker` stays resource data.
        const clickPower = this.computeClickPower().mul(expNumber_1.ExpNumber.fromNumber(definition?.productionPerWorker ?? 1));
        return (0, attributes_1.computeResourceRate)({
            additional: [[clickPowerStatSource, clickPower]],
            multiplicative: factors.multiplicative,
            drain: [],
        });
    }
    /**
     * The effective power of one building: its own power attribute — which
     * already folds in the global building-power layer — defaulting to 1 for any
     * key without a power attribute.
     */
    buildingPower(buildingKey) {
        const value = this.getAttributeValue(`${buildingKey}Power`);
        return value.gt(expNumber_1.ExpNumber.ZERO) ? value : expNumber_1.ExpNumber.ONE;
    }
    /**
     * The global click power stat: base 1 plus every `clickPower` bonus in force.
     * Flats sum, multipliers compound — the attribute-bonus rule of §13.1, reused.
     */
    computeClickPower() {
        let flat = expNumber_1.ExpNumber.ONE;
        let multiplier = expNumber_1.ExpNumber.ONE;
        for (const [, bonus] of this.activeBonuses()) {
            if (!this.isClickPowerDestination(String(bonus.destination)))
                continue;
            if (bonus.type === "attributeFlat")
                flat = flat.add(bonus.value);
            else if (bonus.type === "attributeMultiplier")
                multiplier = multiplier.mul(bonus.value);
        }
        return flat.mul(multiplier);
    }
    /**
     * The current value of an attribute: computed for derived stats, stored amount or
     * capacity base otherwise (§13.2).
     */
    getAttributeValue(key) {
        const attribute = (0, attributes_1.findAttributeDefinition)(key);
        if (!attribute)
            return expNumber_1.ExpNumber.ZERO;
        if (attribute.family !== "derived") {
            return this.resources[key] ?? expNumber_1.ExpNumber.ZERO;
        }
        return derivedAttributeComputations[key]?.value(this) ?? expNumber_1.ExpNumber.ZERO;
    }
    /**
     * The composition of a derived attribute (stat): its bonus-free base plus every
     * active flat/multiplier bonus targeting it, paired with their source ids so the
     * Gamepedia stat page can render linked factor rows (§13.2).
     */
    getDerivedAttributeFactors(key) {
        const attribute = (0, attributes_1.findAttributeDefinition)(key);
        const computation = derivedAttributeComputations[key];
        if (attribute?.family !== "derived" || !computation)
            return undefined;
        const factors = {
            base: computation.base(this),
            additional: [],
            multiplicative: [],
        };
        for (const [sourceId, bonus] of this.activeBonuses()) {
            if (String(bonus.destination) !== key)
                continue;
            if (bonus.type === "attributeFlat") {
                factors.additional.push([sourceId, bonus.value]);
            }
            else if (bonus.type === "attributeMultiplier") {
                factors.multiplicative.push([sourceId, bonus.value]);
            }
        }
        // Building powers fold in the global layer so the displayed value is the
        // effective one; the row links the global stat's Gamepedia page (§13.2).
        const isBuildingPower = buildings_1.buildingDefinitions.some(({ key: buildingKey }) => `${buildingKey}Power` === key);
        if (isBuildingPower) {
            factors.multiplicative.push([
                "buildingPower",
                this.getAttributeValue("buildingPower"),
            ]);
        }
        return factors;
    }
    /** True when `destination` names the global click power attribute. */
    isClickPowerDestination(destination) {
        return destination === clickPowerStatSource;
    }
    setAutoClicksPerSecond(autoClicksPerSecond) {
        return this.withState(this.resources, this.buildingCostOverrides, this.builtBuildings, Math.max(0, autoClicksPerSecond));
    }
    getBuildingMax(buildingKey) {
        const building = buildings_1.buildingDefinitions.find(({ key }) => key === buildingKey);
        if (!building)
            return expNumber_1.ExpNumber.ZERO;
        const capacity = capacityKey(building.key);
        // Effective capacity: the stored base amount times every capacity multiplier in
        // force, from any bonus source (§13.7 decision 3 — capacity keeps its own
        // representation).
        let max = this.resources[capacity];
        for (const [, bonus] of this.activeBonuses()) {
            if (bonus.type === "attributeMultiplier" &&
                bonus.destination === capacity) {
                max = max.mul(bonus.value);
            }
        }
        return max;
    }
    /** Shared production/stat recap; the base remains distinct from bonus additions. */
    getModifierSummary(key) {
        const derived = this.getDerivedAttributeFactors(key);
        const factors = derived
            ? {
                additional: derived.additional,
                multiplicative: derived.multiplicative,
                drain: [],
            }
            : this.getProductionFactors(key);
        const totals = (0, attributes_1.summarizeResourceFactors)(factors);
        const base = derived?.base ?? expNumber_1.ExpNumber.ZERO;
        return {
            ...totals,
            base,
            result: base
                .add(totals.additional)
                .mul(totals.multiplier)
                .sub(totals.drain),
        };
    }
    /** Effective effects for one or more buildings, shared by simulation and Pedia. */
    getBuildingEffects(buildingKey, count = 1) {
        const effects = buildings_1.buildingDefinitions.find(({ key }) => key === buildingKey)?.effects;
        if (!effects)
            return {};
        const power = this.buildingPower(buildingKey);
        const quantity = expNumber_1.ExpNumber.fromNumber(count);
        return {
            resourceMultiplier: effects.resourceMultiplier && {
                ...effects.resourceMultiplier,
                factor: expNumber_1.ExpNumber.ONE.add(effects.resourceMultiplier.factor.sub(expNumber_1.ExpNumber.ONE).mul(power)).pow(quantity),
            },
            resourceProduction: effects.resourceProduction && {
                ...effects.resourceProduction,
                amount: effects.resourceProduction.amount.mul(power).mul(quantity),
            },
            resourceDrain: effects.resourceDrain && {
                ...effects.resourceDrain,
                amount: effects.resourceDrain.amount.mul(quantity),
            },
            capacityProvided: effects.capacityProvided && {
                ...effects.capacityProvided,
                perBuilding: effects.capacityProvided.perBuilding.mul(quantity),
            },
        };
    }
    /** Cost-reduction bonuses targeting one buyable, folded the §13.1 way. */
    costReductionsFor(buyableId) {
        const sources = this.activeBonuses().filter(([, bonus]) => bonus.destination === buyableId &&
            bonus.type.startsWith("costReduction"));
        return {
            sources,
            reductions: (0, bonus_1.collectCostReductions)(sources.map(([, bonus]) => bonus)),
        };
    }
    getBuildingCostModifiers(buildingKey) {
        const { sources, reductions } = this.costReductionsFor(buildingKey);
        const globalMultiplier = expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ZERO, this.getAttributeValue("buildingCostMultiplier"));
        return {
            sources,
            globalMultiplier,
            reductions: {
                ...reductions,
                base: reductions.base.mul(globalMultiplier),
            },
        };
    }
    /** Units are buyables (§13.3), so they take the same four cost-reduction types. */
    getUnitCostModifiers(unitId) {
        return this.costReductionsFor(unitId);
    }
    /** Per-unit pipeline inputs, shared by buildings, units and their previews. */
    costParameters(costs, reductions) {
        return costs.map((cost) => ({
            cost,
            unitBase: expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ZERO, cost.base.mul(reductions.base)),
            unitFactor: expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ONE, expNumber_1.ExpNumber.fromNumber(cost.factor).sub(reductions.factor)),
            reductions,
        }));
    }
    getBuildingCostParameters(buildingKey) {
        const building = buildings_1.buildingDefinitions.find(({ key }) => key === buildingKey);
        if (!building)
            return [];
        const costs = this.buildingCostOverrides[building.key] ?? building.costs;
        const { reductions } = this.getBuildingCostModifiers(buildingKey);
        return this.costParameters(costs, reductions);
    }
    getUnitCostParameters(unitId) {
        const unit = (0, units_1.findUnitDefinition)(unitId);
        if (!unit)
            return [];
        const { reductions } = this.getUnitCostModifiers(unitId);
        return this.costParameters(unit.costs, reductions);
    }
    getBuildingCost(buildingKey, buildingsAlreadyBuilt, count = 1) {
        return this.costSeries(this.getBuildingCostParameters(buildingKey), expNumber_1.ExpNumber.fromNumber(buildingsAlreadyBuilt), count);
    }
    /** Cost of the next `count` units, growing with the number already owned. */
    getUnitCost(unitId, count = 1) {
        return this.costSeries(this.getUnitCostParameters(unitId), this.getUnitCount(unitId), count);
    }
    /** Owned count of one unit (units have no capacity ceiling, §13.3). */
    getUnitCount(unitId) {
        return this.unitCounts[unitId] ?? expNumber_1.ExpNumber.ZERO;
    }
    /**
     * Every unit-stat bonus aimed at one unit, split per stat into summed flats
     * and compounded multipliers — the §13.1 stacking rule applied to units.
     */
    collectUnitStatFactors(unit, sources) {
        const factors = {
            hp: { flat: expNumber_1.ExpNumber.ZERO, multiplier: expNumber_1.ExpNumber.ONE },
            attack: { flat: expNumber_1.ExpNumber.ZERO, multiplier: expNumber_1.ExpNumber.ONE },
            armor: { flat: expNumber_1.ExpNumber.ZERO, multiplier: expNumber_1.ExpNumber.ONE },
            range: { flat: expNumber_1.ExpNumber.ZERO, multiplier: expNumber_1.ExpNumber.ONE },
            speed: { flat: expNumber_1.ExpNumber.ZERO, multiplier: expNumber_1.ExpNumber.ONE },
            accuracy: { flat: expNumber_1.ExpNumber.ZERO, multiplier: expNumber_1.ExpNumber.ONE },
        };
        for (const [, bonus] of sources) {
            if (bonus.type !== "attributeFlat" &&
                bonus.type !== "attributeMultiplier")
                continue;
            const target = (0, units_1.parseUnitStatTarget)(bonus.destination);
            if (!target || !(0, units_1.unitMatchesStatTarget)(unit, target))
                continue;
            const bucket = factors[target.stat];
            if (bonus.type === "attributeFlat")
                bucket.flat = bucket.flat.add(bonus.value);
            else
                bucket.multiplier = bucket.multiplier.mul(bonus.value);
        }
        return factors;
    }
    /** Base stats, then summed flats, then compounded multipliers — per stat. */
    unitStatsFromFactors(unit, factors) {
        const grown = (stat) => {
            const base = stat === "hp" || stat === "attack"
                ? unit.stats[stat]
                : expNumber_1.ExpNumber.fromNumber(unit.stats[stat]);
            return expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ZERO, base.add(factors[stat].flat).mul(factors[stat].multiplier));
        };
        const scalar = (stat, upper) => Math.min(upper, Math.max(0, grown(stat).toNumber()));
        return {
            hp: grown("hp"),
            attack: grown("attack"),
            armor: scalar("armor", units_1.maximumArmor),
            range: Math.max(0, grown("range").toNumber()),
            speed: Math.max(0, grown("speed").toNumber()),
            accuracy: scalar("accuracy", 1),
        };
    }
    /**
     * Cumulative cost of `count` units starting at `alreadyBuilt`. Per unit:
     * base → factor → percent → flat, clamped at zero. The closed-form series keeps
     * buy-N and buy-MAX on one O(1) evaluator (§13.1/§13.6).
     */
    costSeries(parameters, buildingsAlreadyBuilt, count) {
        return parameters.map(({ cost, unitBase, unitFactor, reductions }) => {
            // Per-unit pipeline: base → factor → percent → flat, clamped at zero.
            const firstGross = unitBase
                .mul(unitFactor.pow(buildingsAlreadyBuilt))
                .mul(reductions.percent);
            // Leading units whose gross cost the flat reduction absorbs entirely. The
            // gross grows by unitFactor per unit, so the prefix is short for any sane
            // data; a zero first gross clamps everything.
            let clamped = 0;
            if (reductions.flat.gt(expNumber_1.ExpNumber.ZERO)) {
                if (firstGross.lte(expNumber_1.ExpNumber.ZERO)) {
                    clamped = count;
                }
                else if (firstGross.lte(reductions.flat)) {
                    if (unitFactor.gt(expNumber_1.ExpNumber.ONE)) {
                        let gross = firstGross;
                        while (clamped < count && gross.lte(reductions.flat)) {
                            clamped += 1;
                            gross = gross.mul(unitFactor);
                        }
                    }
                    else {
                        clamped = count;
                    }
                }
            }
            const remaining = count - clamped;
            let total;
            if (remaining <= 0) {
                total = expNumber_1.ExpNumber.ZERO;
            }
            else {
                // Geometric series: sum_{i=0}^{remaining-1} gross_(clamped+i), minus the
                // flat reduction for every unclamped unit. For large counts the precise
                // per-item ceil barely matters vs the formula, so we round up at the end.
                const seriesFirst = firstGross.mul(unitFactor.pow(clamped));
                const grossSum = unitFactor.gt(expNumber_1.ExpNumber.ONE)
                    ? seriesFirst
                        .mul(unitFactor.pow(remaining).sub(expNumber_1.ExpNumber.ONE))
                        .div(unitFactor.sub(expNumber_1.ExpNumber.ONE))
                    : seriesFirst.mul(expNumber_1.ExpNumber.fromNumber(remaining));
                total = expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ZERO, grossSum.sub(reductions.flat.mul(expNumber_1.ExpNumber.fromNumber(remaining))));
            }
            return { ...cost, base: total.ceil() };
        });
    }
    formatBuildingCost(buildingKey, buildingsAlreadyBuilt, count = 1, format = String) {
        return this.getBuildingCost(buildingKey, buildingsAlreadyBuilt, count)
            .map(({ resource, base }) => `${format(base)} ${resource}`)
            .join(" + ");
    }
    getMaxAffordableBuildings(buildingKey) {
        const building = buildings_1.buildingDefinitions.find(({ key }) => key === buildingKey);
        if (!building)
            return 0;
        const capacityLimit = this.getBuildingMax(building.key).toNumber();
        const currentCount = this.buildingCount(building.key);
        let maxPossible = capacityLimit > 0 ? Math.max(0, capacityLimit - currentCount) : Infinity;
        if (buildingKey === "people") {
            maxPossible = Math.min(maxPossible, Math.max(0, this.maximumPopulation.toNumber() - this.population.toNumber()));
        }
        // Dev-tools free mode: capacity still gates, but every in-capacity count is
        // affordable — the next cost stays displayed while the purchase skips payment.
        const canAffordCount = (n) => this.freeBuildings ||
            this.getBuildingCost(building.key, currentCount, n).every(({ resource, base }) => this.resources[resource].gte(base));
        // Upper bound: capacity-limited. Enhancer tiers push capacity to 1e9 by the
        // endgame, so allow the full range; the doubling probe stays O(log N).
        const upperBound = Math.min(maxPossible === Infinity ? 1000000000 : maxPossible, 1000000000);
        if (!canAffordCount(1))
            return 0;
        // Doubling probe to find a tight upper bound (O(log N) calls, each O(1))
        let probe = 1;
        while (probe < upperBound && canAffordCount(probe * 2)) {
            probe *= 2;
        }
        if (probe >= upperBound && canAffordCount(upperBound))
            return upperBound;
        // Binary search in [probe, probe*2] for the exact max
        let lo = probe;
        let hi = Math.min(probe * 2, upperBound);
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (canAffordCount(mid)) {
                lo = mid;
            }
            else {
                hi = mid - 1;
            }
        }
        return lo;
    }
    upgradeBuildingLimit(buildingKey, additionalSlots) {
        const capacity = capacityKey(buildingKey);
        const resources = {
            ...this.resources,
            // Raises the stored base, never the multiplied effective capacity —
            // otherwise bought capacity multipliers would compound twice.
            [capacity]: this.resources[capacity].add(expNumber_1.ExpNumber.fromNumber(additionalSlots)),
        };
        return this.withState(resources, this.buildingCostOverrides);
    }
    upgradeBuildingCosts(buildingKey, costs) {
        return this.withState(this.resources, {
            ...this.buildingCostOverrides,
            [buildingKey]: costs,
        });
    }
    addFactor(resourceKey, factorType, factor) {
        const factors = this.resourceFactors[resourceKey];
        return this.withResourceFactors({
            ...this.resourceFactors,
            [resourceKey]: {
                ...factors,
                [factorType]: [...factors[factorType], factor],
            },
        });
    }
    getBuildingCount(buildingKey) {
        return this.buildingCount(buildingKey);
    }
    isBuildingAtCapacity(buildingKey) {
        const building = buildings_1.buildingDefinitions.find(({ key }) => key === buildingKey);
        if (!building)
            return false;
        const count = this.buildingCount(building.key);
        if (count >= this.getBuildingMax(building.key).toNumber())
            return true;
        if (buildingKey === "people" && this.population.gte(this.maximumPopulation))
            return true;
        return false;
    }
    hasResourcesForBuilding(buildingKey, count = 1) {
        if (this.freeBuildings)
            return true;
        const currentCount = this.buildingCount(buildingKey);
        return this.getBuildingCost(buildingKey, currentCount, count).every(({ resource, base }) => this.resources[resource].gte(base));
    }
    isBuildingAvailable(buildingKey) {
        const building = buildings_1.buildingDefinitions.find(({ key }) => key === buildingKey);
        if (!building || !building.available)
            return false;
        const { unlock } = building;
        if (!unlock)
            return true;
        switch (unlock.source) {
            case "building-count":
                return this.buildingCount(unlock.building) >= unlock.threshold;
            case "battle":
                return this.defeatedEncounters.includes(unlock.encounterId);
            case "age":
                return this.enteredAges.includes(unlock.ageId);
            default:
                return false;
        }
    }
    getBuildFailureReason(buildingKey, count = 1) {
        const building = buildings_1.buildingDefinitions.find(({ key }) => key === buildingKey);
        if (!building || !this.isBuildingAvailable(building.key))
            return "locked";
        const currentCount = this.buildingCount(building.key);
        if (currentCount + count > this.getBuildingMax(building.key).toNumber())
            return "capacity";
        if (buildingKey === "people" &&
            this.population.toNumber() + count > this.maximumPopulation.toNumber())
            return "capacity";
        if (!this.hasResourcesForBuilding(building.key, count))
            return "resources";
        return null;
    }
    build(buildingKey, count = 1) {
        if (count <= 0)
            return this;
        if (!this.canBuild(buildingKey, count))
            return this;
        const builtCount = this.buildingCount(buildingKey);
        const cost = this.freeBuildings
            ? []
            : this.getBuildingCost(buildingKey, builtCount, count);
        const resources = { ...this.resources };
        for (const { resource, base } of cost) {
            resources[resource] = resources[resource].sub(base);
        }
        if (buildingKey === "people") {
            resources.population = resources.population.add(expNumber_1.ExpNumber.fromNumber(count));
        }
        if (buildingKey === "house") {
            resources.peopleCapacity = resources.peopleCapacity.add(expNumber_1.ExpNumber.fromNumber(10 * count));
        }
        if (buildingKey === "town-hall") {
            resources.houseCapacity = resources.houseCapacity.add(expNumber_1.ExpNumber.fromNumber(10 * count));
        }
        const newBuildings = [...this.builtBuildings];
        for (let i = 0; i < count; i++) {
            newBuildings.push(buildingKey);
        }
        return this.withState(resources, this.buildingCostOverrides, newBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, {
            ...this.statistics,
            // Cumulative: a building count never falls, so these are lifetime totals.
            buildingsBuilt: this.statistics.buildingsBuilt.add(expNumber_1.ExpNumber.fromNumber(count)),
            buildingsBuiltByKey: {
                ...this.statistics.buildingsBuiltByKey,
                [buildingKey]: (this.statistics.buildingsBuiltByKey[buildingKey] ?? expNumber_1.ExpNumber.ZERO).add(expNumber_1.ExpNumber.fromNumber(count)),
            },
        });
    }
    canBuild(buildingKey, count = 1) {
        if (this.isBuildingAtCapacity(buildingKey))
            return false;
        if (!this.hasResourcesForBuilding(buildingKey, count))
            return false;
        return true;
    }
    buildingCount(buildingKey) {
        // O(1) per call: the per-key map rebuilds once per builtBuildings identity
        // (i.e. once per actual construction), never per tick or per query.
        let counts = buildingCountCaches.get(this.builtBuildings);
        if (!counts) {
            counts = new Map();
            for (const key of this.builtBuildings) {
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            buildingCountCaches.set(this.builtBuildings, counts);
        }
        return counts.get(buildingKey) ?? 0;
    }
    /** Bonuses from bought upgrades, paired with the upgrade id as the factor source. */
    boughtUpgradeBonuses() {
        return this.boughtUpgrades.flatMap((upgradeId) => (upgrades_1.upgradeDefinitions.find(({ key }) => key === upgradeId)?.bonuses ?? []).map((bonus) => [upgradeId, bonus]));
    }
    /** Bonuses from defeated encounters, paired with the encounter id as the source. */
    defeatedEncounterBonuses() {
        return this.defeatedEncounters.flatMap((encounterId) => (encounters_1.encounterDefinitions.find(({ key }) => key === encounterId)?.bonuses ??
            []).map((bonus) => [encounterId, bonus]));
    }
    /**
     * Bonuses from earned achievements, paired with the achievement id as the source.
     * Achievements never carry unlock lists, but their *rewards* are ordinary bonuses
     * (§13.1/§13.4), derived from the earned id list rather than stored as values.
     * Open-ended hoarder tiers collapse into one summed `attributeFlat` per chain —
     * additive stacking (§13.7 decision 1) makes the math identical — under the
     * source id `<family>-total`, so the factor list stays one row per chain and
     * links the aggregate Gamepedia entry.
     */
    earnedAchievementBonuses() {
        const results = [];
        for (const achievementId of this.earnedAchievements) {
            if ((0, achievements_1.chainFamilyForId)(achievementId))
                continue;
            const definition = (0, achievements_1.findAchievementDefinition)(achievementId);
            for (const bonus of definition?.bonuses ?? []) {
                results.push([achievementId, bonus]);
            }
        }
        for (const chain of achievements_1.openEndedHoarderChains) {
            const prefix = `${chain.family}-e`;
            let total = expNumber_1.ExpNumber.ZERO;
            let earned = false;
            for (const achievementId of this.earnedAchievements) {
                if (!achievementId.startsWith(prefix))
                    continue;
                earned = true;
                for (const bonus of (0, achievements_1.findAchievementDefinition)(achievementId)?.bonuses ??
                    []) {
                    if (bonus.type === "attributeFlat" &&
                        bonus.destination === chain.resource) {
                        total = total.add(bonus.value);
                    }
                }
            }
            if (earned && !total.isZero) {
                results.push([
                    `${chain.family}-total`,
                    { type: "attributeFlat", destination: chain.resource, value: total },
                ]);
            }
        }
        return results;
    }
    /**
     * Every bonus currently in force, paired with its source id. One seam for all
     * bonus sources keeps capacities, costs and stats on the same application path.
     * Cached on the identity of the three source id lists: rebuilt once per real
     * change, reused by every query in between (see the module cache note).
     */
    activeBonuses() {
        let byEncounters = activeBonusCaches.get(this.boughtUpgrades);
        if (!byEncounters) {
            byEncounters = new WeakMap();
            activeBonusCaches.set(this.boughtUpgrades, byEncounters);
        }
        let byAchievements = byEncounters.get(this.defeatedEncounters);
        if (!byAchievements) {
            byAchievements = new WeakMap();
            byEncounters.set(this.defeatedEncounters, byAchievements);
        }
        const cached = byAchievements.get(this.earnedAchievements);
        if (cached)
            return cached;
        const computed = [
            ...this.boughtUpgradeBonuses(),
            ...this.defeatedEncounterBonuses(),
            ...this.earnedAchievementBonuses(),
        ];
        byAchievements.set(this.earnedAchievements, computed);
        return computed;
    }
    defeatEncounter(encounterId) {
        if (this.defeatedEncounters.includes(encounterId))
            return this;
        return this.withState(this.resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, [...this.defeatedEncounters, encounterId], this.enteredAges, this.earnedAchievements, {
            ...this.statistics,
            fastestBattleMs: this.recordFastest(this.statistics.fastestBattleMs, encounterId),
        });
    }
    isAchievementEarned(achievementId) {
        return this.earnedAchievementSet().has(achievementId);
    }
    /** O(1) membership via a Set cached on the earned id list's identity. */
    earnedAchievementSet() {
        let set = earnedAchievementSets.get(this.earnedAchievements);
        if (!set) {
            set = new Set(this.earnedAchievements);
            earnedAchievementSets.set(this.earnedAchievements, set);
        }
        return set;
    }
    /** Can the player buy this unit: base-available, or unlocked by a won battle. */
    isUnitAvailable(unitId) {
        const unit = (0, units_1.findUnitDefinition)(unitId);
        if (!unit || !(0, units_1.isBuyableUnit)(unit))
            return false;
        if (unit.available)
            return true;
        return encounters_1.encounterDefinitions.some((encounter) => encounter.unlocks.includes(unitId) &&
            this.defeatedEncounters.includes(encounter.key));
    }
    /** The Army tab's buyable roster: current + previous age, unlocked only. */
    getRosterUnits() {
        const currentAge = this.getCurrentAge();
        if (!currentAge)
            return [];
        const currentAgeIndex = ages_1.ageDefinitions.findIndex((a) => a.key === currentAge.key);
        return units_1.unitDefinitions.filter((unit) => (0, units_1.isBuyableUnit)(unit) &&
            this.isUnitAvailable(unit.key) &&
            unit.age >= currentAgeIndex - 1 &&
            unit.age <= currentAgeIndex);
    }
    hasResourcesForUnit(unitId, count = 1) {
        if (this.freeUnits)
            return true;
        return this.getUnitCost(unitId, count).every(({ resource, base }) => this.resources[resource].gte(base));
    }
    getUnitFailureReason(unitId, count = 1) {
        if (!this.isUnitAvailable(unitId))
            return "locked";
        if (!this.hasResourcesForUnit(unitId, count))
            return "resources";
        return null;
    }
    canBuyUnit(unitId, count = 1) {
        return this.getUnitFailureReason(unitId, count) === null;
    }
    /** Buy-MAX for units (no capacity cap): the shared O(log n) probe. */
    getMaxAffordableUnits(unitId) {
        if (!this.isUnitAvailable(unitId))
            return 0;
        return maxAffordableCount((n) => this.hasResourcesForUnit(unitId, n), maximumUnitPurchase);
    }
    buyUnit(unitId, count = 1) {
        if (count <= 0 || !this.canBuyUnit(unitId, count))
            return this;
        const cost = this.freeUnits
            ? []
            : this.getUnitCost(unitId, count);
        const resources = { ...this.resources };
        for (const { resource, base } of cost) {
            resources[resource] = resources[resource].sub(base);
        }
        return this.withResources(resources).withUnitCount(unitId, this.getUnitCount(unitId).add(expNumber_1.ExpNumber.fromNumber(count)));
    }
    /** The player's army as battle stacks, with every bonus in force applied. */
    getArmyStacks() {
        const stacks = [];
        for (const unit of units_1.unitDefinitions) {
            const count = this.getUnitCount(unit.key);
            if (count.lte(expNumber_1.ExpNumber.ZERO))
                continue;
            const stats = this.getUnitStats(unit.key);
            if (stats)
                stacks.push({ unitId: unit.key, count, stats });
        }
        return stacks;
    }
    getArmyPower() {
        return (0, battle_1.armyPower)(this.getArmyStacks());
    }
    /** Effective stats of one unit, with every active bonus applied. */
    getUnitStats(unitId) {
        const unit = (0, units_1.findUnitDefinition)(unitId);
        if (!unit)
            return undefined;
        return this.unitStatsFromFactors(unit, this.collectUnitStatFactors(unit, this.activeBonuses()));
    }
    /** One enemy army, with the battle's "fake research" boosts applied. */
    getEnemyStacks(encounterId) {
        const encounter = (0, encounters_1.findEncounterDefinition)(encounterId);
        if (!encounter)
            return [];
        const boosts = encounter.enemyBoosts.map((bonus) => [encounter.key, bonus]);
        const stacks = [];
        for (const { unitId, count } of encounter.enemyArmy) {
            const unit = (0, units_1.findUnitDefinition)(unitId);
            if (!unit)
                continue;
            const stats = this.unitStatsFromFactors(unit, this.collectUnitStatFactors(unit, boosts));
            stacks.push({ unitId, count: expNumber_1.ExpNumber.fromNumber(count), stats });
        }
        return stacks;
    }
    /** The next battle the campaign offers: the first not-yet-won encounter in the
     *  current age only. Battles outside the current age are never offered. */
    getNextBattle() {
        const currentAge = this.getCurrentAge();
        if (!currentAge)
            return undefined;
        const currentAgeIndex = ages_1.ageDefinitions.findIndex((a) => a.key === currentAge.key);
        return encounters_1.encounterDefinitions.find((encounter) => encounter.age === currentAgeIndex &&
            !this.defeatedEncounters.includes(encounter.key));
    }
    /** Whether more battles exist but are locked behind entering the next age. */
    hasLockedBattles() {
        return encounters_1.encounterDefinitions.some((encounter) => !this.defeatedEncounters.includes(encounter.key) &&
            !this.isAgeUnlocked(`age-${encounter.age}`));
    }
    /**
     * Runs the fight without touching any state, so the UI can play the round log
     * back one round per second before the result is applied. The seed folds in
     * the battle id, so the same armies fight the same battle every replay.
     */
    simulateEncounter(encounterId) {
        const encounter = (0, encounters_1.findEncounterDefinition)(encounterId);
        if (!encounter)
            return undefined;
        // Battles outside the current age cannot be fought.
        const currentAge = this.getCurrentAge();
        if (!currentAge)
            return undefined;
        const currentAgeIndex = ages_1.ageDefinitions.findIndex((a) => a.key === currentAge.key);
        if (encounter.age !== currentAgeIndex)
            return undefined;
        const player = this.getArmyStacks();
        const enemy = this.getEnemyStacks(encounterId);
        if (player.length === 0 || enemy.length === 0)
            return undefined;
        return (0, battle_1.simulateBattle)(player, enemy, {
            seed: (0, battle_1.battleSeed)(player, enemy, encounter.key),
        });
    }
    /**
     * Applies a finished battle: a player win records the victory (and its
     * unlocks); a loss or stalemate changes nothing. Casualties never persist —
     * `unitCounts` is untouched, so armies are restored after every battle.
     */
    resolveBattle(encounterId, simulation) {
        if (this.defeatedEncounters.includes(encounterId))
            return this;
        const encounter = (0, encounters_1.findEncounterDefinition)(encounterId);
        if (!encounter)
            return this;
        // Battles outside the current age cannot be fought.
        const currentAge = this.getCurrentAge();
        if (!currentAge)
            return this;
        const currentAgeIndex = ages_1.ageDefinitions.findIndex((a) => a.key === currentAge.key);
        if (encounter.age !== currentAgeIndex)
            return this;
        const result = simulation ?? this.simulateEncounter(encounterId);
        if (!result || result.outcome !== "player")
            return this;
        return this.defeatEncounter(encounterId);
    }
    /**
     * The fastest run time at which `id` was reached, kept across runs: a record
     * already set is only replaced by a strictly faster one.
     */
    recordFastest(times, id) {
        const best = times[id];
        if (best !== undefined && best <= this.statistics.runTimeMs)
            return times;
        return { ...times, [id]: this.statistics.runTimeMs };
    }
    /**
     * Records the run time at which each age's population threshold was first met.
     * `getCurrentAge()` keys an age off population, so crossing the threshold is what
     * "arriving" at an age means — the fastest time is the first tick that sees it.
     * `enterAge()` records too (it is the later of the two events), and both go through
     * the min-keeping `recordFastest()` rule, so the earliest sighting always wins.
     */
    recordReachedAges() {
        let fastestAgeMs = this.statistics.fastestAgeMs;
        for (const age of ages_1.ageDefinitions) {
            if (this.population.toNumber() < age.populationThreshold)
                continue;
            if (fastestAgeMs[age.key] !== undefined)
                continue;
            fastestAgeMs = { ...fastestAgeMs, [age.key]: this.statistics.runTimeMs };
        }
        if (fastestAgeMs === this.statistics.fastestAgeMs)
            return this;
        return this.withStatistics({ ...this.statistics, fastestAgeMs });
    }
    /** Play time (ms) of the fastest recorded run that won this encounter, if any. */
    getFastestBattleTime(encounterId) {
        return this.statistics.fastestBattleMs[encounterId];
    }
    /** The live value a requirement is measured against (feeds the achievements tab). */
    getRequirementValue(requirement) {
        switch (requirement.type) {
            case "resource":
                return this.resources[requirement.resource];
            case "population":
                return this.resources.population;
            case "clicks":
                return this.statistics.productionClicks;
            case "building-count":
                return expNumber_1.ExpNumber.fromNumber(this.buildingCount(requirement.building));
            case "buildings-total":
                return this.statistics.buildingsBuilt;
            case "encounter":
                return this.defeatedEncounters.includes(requirement.encounterId)
                    ? expNumber_1.ExpNumber.ONE
                    : expNumber_1.ExpNumber.ZERO;
            case "upgrade-count":
                return expNumber_1.ExpNumber.fromNumber(this.boughtUpgrades.length);
        }
    }
    requirementThreshold(requirement) {
        switch (requirement.type) {
            case "resource":
            case "population":
            case "clicks":
                return requirement.amount;
            case "building-count":
            case "buildings-total":
                return expNumber_1.ExpNumber.fromNumber(requirement.count);
            case "encounter":
                return expNumber_1.ExpNumber.ONE;
            case "upgrade-count":
                return expNumber_1.ExpNumber.fromNumber(requirement.count);
        }
    }
    /**
     * The next milestone of an achievement family: its name, the threshold the
     * family is measured against, and the reward it will grant. Concrete tiers
     * come first; once they run out, an open-ended chain reports its next
     * exponent. `undefined` when the family has no tiers left.
     */
    getNextAchievementGoal(family) {
        const earned = this.earnedAchievementSet();
        const concrete = achievements_1.achievementDefinitions
            .filter(({ family: achievementFamily }) => achievementFamily === family)
            .sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
        const nextTier = concrete.find(({ key }) => !earned.has(key));
        if (nextTier) {
            return {
                name: nextTier.name,
                threshold: this.requirementThreshold(nextTier.requirement),
                bonuses: nextTier.bonuses,
            };
        }
        const chain = achievements_1.openEndedHoarderChains.find(({ family: chainFamily }) => chainFamily === family);
        if (!chain)
            return undefined;
        const exponent = (0, achievements_1.nextHoarderExponent)(chain, this.earnedAchievements);
        const tier = (0, achievements_1.materializeOpenEndedTier)(chain, exponent);
        return {
            name: tier.name,
            threshold: expNumber_1.ExpNumber.fromLog10(exponent),
            bonuses: tier.bonuses,
        };
    }
    /**
     * Open-ended hoarder chains: every multiple of the step exponent at or below
     * the held amount's magnitude is an earnable tier. Tiers are earned in order
     * from the highest recorded milestone, so spending resources cannot roll the
     * chain back; a jump spanning more than 1,000 tiers collapses into one range
     * record (`…-through-e…`) whose reward sums every spanned tier.
     */
    openEndedChainEarnings() {
        const newlyEarned = [];
        for (const chain of achievements_1.openEndedHoarderChains) {
            const held = this.resources[chain.resource];
            if (held.lte(expNumber_1.ExpNumber.ZERO))
                continue;
            const heldExponent = Math.floor(held.log10());
            let exponent = (0, achievements_1.nextHoarderExponent)(chain, this.earnedAchievements);
            const endExponent = chain.startExponent +
                Math.floor((heldExponent - chain.startExponent) / chain.exponentStep) *
                    chain.exponentStep;
            if (!Number.isSafeInteger(endExponent) || exponent > endExponent)
                continue;
            const count = (endExponent - exponent) / chain.exponentStep + 1;
            if (count > 1000) {
                newlyEarned.push(`${chain.family}-e${exponent}-through-e${endExponent}`);
                continue;
            }
            for (; exponent <= endExponent; exponent += chain.exponentStep) {
                newlyEarned.push(`${chain.family}-e${exponent}`);
            }
        }
        return newlyEarned;
    }
    meetsRequirement(requirement) {
        switch (requirement.type) {
            case "resource":
                return this.resources[requirement.resource].gte(requirement.amount);
            case "population":
                return this.resources.population.gte(requirement.amount);
            case "clicks":
                return this.statistics.productionClicks.gte(requirement.amount);
            case "building-count":
                return this.buildingCount(requirement.building) >= requirement.count;
            case "buildings-total":
                return this.statistics.buildingsBuilt.gte(expNumber_1.ExpNumber.fromNumber(requirement.count));
            case "encounter":
                return this.defeatedEncounters.includes(requirement.encounterId);
            case "upgrade-count":
                return this.boughtUpgrades.length >= requirement.count;
            default:
                return false;
        }
    }
    /**
     * Records every achievement whose requirement is met, once. Earned ids are the
     * only achievement data in state – never applied bonuses – so migrations and
     * re-balancing stay safe (roadmap Milestone 6). Returns `this` when nothing is new.
     */
    checkAchievements() {
        const earned = this.earnedAchievementSet();
        const newlyEarned = [
            ...achievements_1.achievementDefinitions
                .filter(({ key, requirement }) => !earned.has(key) && this.meetsRequirement(requirement))
                .map(({ key }) => key),
            ...this.openEndedChainEarnings(),
        ];
        if (newlyEarned.length === 0)
            return this;
        return this.withState(this.resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, [...this.earnedAchievements, ...newlyEarned]);
    }
    withResources(resources) {
        return this.withState(resources, this.buildingCostOverrides);
    }
    withWorkers(workers) {
        return new CivilizationState(this.resources, workers, this.builtBuildings, this.resourceFactors, this.buildingCostOverrides, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, this.statistics, this.unitCounts, this.devProductionMultiplier, this.freeBuildings, this.freeUnits);
    }
    withResourceFactors(resourceFactors) {
        return new CivilizationState(this.resources, this.workers, this.builtBuildings, resourceFactors, this.buildingCostOverrides, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, this.statistics, this.unitCounts, this.devProductionMultiplier, this.freeBuildings, this.freeUnits);
    }
    withStatistics(statistics) {
        return this.withState(this.resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, statistics);
    }
    withUnitCount(unitId, count) {
        const unitCounts = { ...this.unitCounts };
        if (count.lte(expNumber_1.ExpNumber.ZERO))
            delete unitCounts[unitId];
        else
            unitCounts[unitId] = count;
        return this.withState(this.resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, this.statistics, unitCounts);
    }
    withState(resources, costOverrides, builtBuildings = this.builtBuildings, autoClicksPerSecond = this.autoClicksPerSecond, boughtUpgrades = this.boughtUpgrades, defeatedEncounters = this.defeatedEncounters, enteredAges = this.enteredAges, earnedAchievements = this.earnedAchievements, statistics = this.statistics, unitCounts = this.unitCounts, devProductionMultiplier = this.devProductionMultiplier, freeBuildings = this.freeBuildings, freeUnits = this.freeUnits) {
        return new CivilizationState(resources, this.workers, builtBuildings, this.resourceFactors, costOverrides, autoClicksPerSecond, boughtUpgrades, defeatedEncounters, enteredAges, earnedAchievements, statistics, unitCounts, devProductionMultiplier, freeBuildings, freeUnits);
    }
    /** Dev-tools: global production multiplier (×N on every producer rate). */
    setDevProductionMultiplier(multiplier) {
        const value = multiplier.isFinite && !multiplier.isNegative && !multiplier.isZero
            ? multiplier
            : expNumber_1.ExpNumber.ONE;
        if (value.eq(this.devProductionMultiplier))
            return this;
        return this.withState(this.resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, this.statistics, this.unitCounts, value);
    }
    /** Dev-tools: free buildings (skip affordability + deduction, keep capacity). */
    setFreeBuildings(free) {
        if (free === this.freeBuildings)
            return this;
        return this.withState(this.resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, this.statistics, this.unitCounts, this.devProductionMultiplier, free);
    }
    /** Dev-tools: free units (skip affordability + deduction, keep availability). */
    setFreeUnits(free) {
        if (free === this.freeUnits)
            return this;
        return this.withState(this.resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, this.statistics, this.unitCounts, this.devProductionMultiplier, this.freeBuildings, free);
    }
    /**
     * Dev-tools: advance the simulation by whole seconds in one step. Every
     * production rate is constant across the window — nothing in the model feeds
     * resource amounts back into the rates — so the skip is one multiply per
     * producer resource instead of a per-second loop. Auto clicks are already
     * part of the rate; auto-buy and auto-assign stay with the live loop.
     */
    advanceTime(seconds) {
        const wholeSeconds = Math.floor(seconds);
        if (!Number.isFinite(wholeSeconds) || wholeSeconds <= 0)
            return this;
        const elapsed = Math.min(wholeSeconds, 86400);
        const elapsedFactor = expNumber_1.ExpNumber.fromNumber(elapsed);
        const resources = { ...this.resources };
        for (const resourceKey of attributes_1.producerResourceKeys) {
            resources[resourceKey] = applyRate(resources[resourceKey], this.computeResourceRate(resourceKey).mul(elapsedFactor));
        }
        const statistics = {
            ...this.statistics,
            playTimeMs: this.statistics.playTimeMs + elapsed * statistics_1.tickMilliseconds,
            runTimeMs: this.statistics.runTimeMs + elapsed * statistics_1.tickMilliseconds,
        };
        return this.withState(resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, this.enteredAges, this.earnedAchievements, statistics)
            .recordReachedAges()
            .checkAchievements();
    }
    enterAge(ageId) {
        if (this.enteredAges.includes(ageId))
            return this;
        const age = (0, ages_1.findAgeDefinition)(ageId);
        if (!age)
            return this;
        // Retire units from N-2 age (units from two ages ago)
        const currentAgeIndex = ages_1.ageDefinitions.findIndex((a) => a.key === ageId);
        const retireAgeIndex = currentAgeIndex - 2;
        let wasted = expNumber_1.ExpNumber.ZERO;
        const newUnitCounts = { ...this.unitCounts };
        if (retireAgeIndex >= 0) {
            for (const [unitId, count] of Object.entries(this.unitCounts)) {
                const unitDef = (0, units_1.findUnitDefinition)(unitId);
                if (unitDef && unitDef.age === retireAgeIndex) {
                    // Compute the cost of these units (what was "wasted")
                    const unitCost = this.getUnitCost(unitId, 0);
                    const totalCost = unitCost.reduce((total, { base }) => total.add(base.mul(count)), expNumber_1.ExpNumber.ZERO);
                    wasted = wasted.add(totalCost);
                    delete newUnitCounts[unitId];
                }
            }
        }
        // Multiply town hall capacity by 10
        const resources = { ...this.resources };
        const townHallCapacity = resources["town-hallCapacity"];
        resources["town-hallCapacity"] = townHallCapacity.mul(expNumber_1.ExpNumber.fromNumber(10));
        return this.withState(resources, this.buildingCostOverrides, this.builtBuildings, this.autoClicksPerSecond, this.boughtUpgrades, this.defeatedEncounters, [...this.enteredAges, ageId], this.earnedAchievements, {
            ...this.statistics,
            fastestAgeMs: this.recordFastest(this.statistics.fastestAgeMs, ageId),
            wastedResources: this.statistics.wastedResources.add(wasted),
        }, newUnitCounts);
    }
    /** The current age, based on population thresholds (highest threshold ≤ population).
     *  Capped at the first unentered age so population can never skip an unfinished
     *  age: the current age only advances past an age once it has been entered. */
    getCurrentAge() {
        let popIndex = -1;
        const pop = this.population.toNumber();
        for (let i = 0; i < ages_1.ageDefinitions.length; i++) {
            if (pop >= ages_1.ageDefinitions[i].populationThreshold)
                popIndex = i;
        }
        // Below the first threshold the village is still in the first age.
        if (popIndex < 0)
            popIndex = 0;
        const firstUnentered = ages_1.ageDefinitions.findIndex((a) => !this.enteredAges.includes(a.key));
        // Every age entered: the pop-based age is current.
        if (firstUnentered < 0)
            return ages_1.ageDefinitions[popIndex];
        return ages_1.ageDefinitions[Math.min(popIndex, firstUnentered)];
    }
    /** Battle progress in the current age: [wonCount, totalCount]. */
    getAgeBattleProgress() {
        const age = this.getCurrentAge();
        if (!age)
            return [0, 0];
        const ageIndex = parseInt(age.key.slice(-1), 10);
        const totalBattles = encounters_1.encounterDefinitions.filter((e) => e.age === ageIndex).length;
        const wonBattles = encounters_1.encounterDefinitions.filter((e) => e.age === ageIndex && this.defeatedEncounters.includes(e.key)).length;
        return [wonBattles, totalBattles];
    }
    /** Building progress in the current age: [buildings, target].
     *  Target is 125% of the age's pop max (the next age's population threshold). */
    getAgeBuildingProgress() {
        const age = this.getCurrentAge();
        if (!age)
            return [0, 0];
        const buildings = this.builtBuildings.length;
        const target = this.getAgeBuildingTarget(age);
        return [buildings, target];
    }
    /** Building target for an age: 125% of the next age's threshold (this age's pop max). */
    getAgeBuildingTarget(age) {
        const ageIndex = ages_1.ageDefinitions.findIndex((a) => a.key === age.key);
        const next = ageIndex >= 0 ? ages_1.ageDefinitions[ageIndex + 1] : undefined;
        const base = next ? next.populationThreshold : age.populationThreshold;
        return Math.ceil(base * 1.25);
    }
    /** Whether the player can enter the given age (battles done + buildings ≥ 125% age pop max). */
    canEnterAge(ageId) {
        const age = (0, ages_1.findAgeDefinition)(ageId);
        if (!age)
            return false;
        if (this.enteredAges.includes(ageId))
            return false;
        // Check battles: all battles in this age must be won
        const ageIndex = parseInt(age.key.slice(-1), 10);
        const ageBattles = encounters_1.encounterDefinitions.filter((e) => e.age === ageIndex);
        const allBattlesWon = ageBattles.every((b) => this.defeatedEncounters.includes(b.key));
        if (!allBattlesWon)
            return false;
        // Check buildings: total buildings ≥ 125% of the age's pop max
        const target = this.getAgeBuildingTarget(age);
        if (this.builtBuildings.length < target)
            return false;
        return true;
    }
    /** Whether the given age is currently "unlocked" (winnable) — all prior ages entered. */
    isAgeUnlocked(ageId) {
        const ageIndex = parseInt(ageId.slice(-1), 10);
        // Age 0 is always unlocked
        if (ageIndex === 0)
            return true;
        // Check that the previous age has been entered
        const prevAgeId = `age-${ageIndex - 1}`;
        return this.enteredAges.includes(prevAgeId);
    }
    getFastestAgeTime(ageId) {
        return this.statistics.fastestAgeMs[ageId];
    }
}
exports.CivilizationState = CivilizationState;
