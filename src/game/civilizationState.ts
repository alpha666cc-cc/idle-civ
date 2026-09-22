import {
  achievementDefinitions,
  chainFamilyForId,
  findAchievementDefinition,
  materializeOpenEndedTier,
  nextHoarderExponent,
  openEndedHoarderChains,
  type AchievementRequirement,
} from "./achievements";
import { ageDefinitions, findAgeDefinition, type AgeDefinition } from "./ages";
import {
  computeResourceRate,
  derivedAttributeDefinitions,
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  findAttributeDefinition,
  producerResourceKeys,
  productionDefinitions,
  summarizeResourceFactors,
  type CapacityResourceKey,
  type DerivedAttributeFactors,
  type ProductionResourceKey,
  type ResourceAmounts,
  type ResourceFactor,
  type ResourceFactorMap,
  type ResourceFactors,
  type ResourceKey,
  type WorkerAssignments,
} from "./attributes";
import {
  armyPower,
  battleSeed,
  simulateBattle,
  type ArmyStack,
  type BattleSimulation,
} from "./battle";
import {
  collectCostReductions,
  type Bonus,
  type CostReductions,
} from "./bonus";
import {
  calculateTradeMultiplier,
  DEFAULT_TRADE_SPREAD,
  goldToResource,
  isTradable,
  resourceToGold,
  type TradeResourceKey,
} from "./trade";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingEffects,
  type BuildingKey,
} from "./buildings";
import {
  encounterDefinitions,
  findEncounterDefinition,
  type EncounterDefinition,
} from "./encounters";
import { ExpNumber } from "./expNumber";
import {
  findResearchDefinition,
  researchesClosingUnit,
  researchesUnlockingUnit,
} from "./research";
import {
  emptyStatistics,
  tickMilliseconds,
  type Statistics,
} from "./statistics";
import {
  findUnitDefinition,
  isBuyableUnit,
  maximumArmor,
  parseUnitStatTarget,
  unitDefinitions,
  unitMatchesStatTarget,
  type UnitDefinition,
  type UnitStatKey,
  type UnitStats,
} from "./units";
import { upgradeDefinitions } from "./upgrades";
import { WorkerProduction } from "./workerProduction";

/** One cost entry rewritten by the §13.1 per-unit reduction order. */
type CostParameters = {
  cost: BuildingCost;
  unitBase: ExpNumber;
  unitFactor: ExpNumber;
  reductions: CostReductions;
};

type BuildingCostOverrides = Partial<Record<BuildingKey, BuildingCost[]>>;

/** Units have no capacity limit (§13.3), so the MAX probe stops here. */
const maximumUnitPurchase = 1_000_000;

/**
 * Global research pricing: the first tech costs 100 science and every later
 * purchase costs ×10 the previous one, whichever tech is bought. The JSON
 * costs on ResearchDefinition are not charged.
 */
const researchFirstCost = ExpNumber.fromNumber(1_000);
const researchCostGrowth = ExpNumber.fromNumber(10);

/**
 * Identity-keyed recompute caches. Every state array is replaced immutably and
 * never mutated, so array identity is a free "did anything change" test: a tick
 * that changes nothing reuses the cached values, and the one call after a real
 * change (a build, purchase, victory or earn) rebuilds once. This keeps tick
 * cost independent of building count and earned-achievement count.
 */
const earnedAchievementSets = new WeakMap<readonly string[], Set<string>>();

/** Cached activeBonuses(), keyed on the identity tuple of the four source lists
 * (upgrades, encounters, achievements, research, ages). */
type ActiveBonusList = [sourceId: string, bonus: Bonus][];
const activeBonusCaches = new WeakMap<
  readonly string[],
  WeakMap<
    readonly string[],
    WeakMap<
      readonly string[],
      WeakMap<readonly string[], WeakMap<readonly string[], ActiveBonusList>>
    >
  >
>();

/**
 * The largest N for which `canAffordCount(N)` holds, given per-unit costs that
 * never decrease. A doubling probe finds a tight upper bound and a binary search
 * finishes, so the whole thing is O(log N) evaluations of an O(1) cost check —
 * shared by buildings and units so both keep buy-N and buy-MAX on one evaluator.
 */
const maxAffordableCount = (
  canAffordCount: (count: number) => boolean,
  upperBound: number,
): number => {
  if (!canAffordCount(1)) return 0;
  let probe = 1;
  while (probe < upperBound && canAffordCount(probe * 2)) {
    probe *= 2;
  }
  if (probe >= upperBound && canAffordCount(upperBound)) return upperBound;

  let low = probe;
  let high = Math.min(probe * 2, upperBound);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (canAffordCount(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

const capacityKey = (buildingKey: BuildingKey): CapacityResourceKey =>
  `${buildingKey}Capacity` as CapacityResourceKey;

/**
 * Factor-source label for a manual click. It is the click power stat's id, so the
 * Gamepedia factor list links the row to the stat page (§13.2 decision 2).
 */
const clickPowerStatSource =
  derivedAttributeDefinitions.find(({ key }) => key === "clickPower")?.key ??
  "manual click";

/**
 * Per-derived-attribute computations (§13.2): stats are never stored, so each one
 * states how its value and its bonus-free base are read. New computed attributes
 * arrive by extending this record — no per-content branching elsewhere.
 */
const derivedAttributeComputations: Record<
  string,
  {
    value: (state: CivilizationState) => ExpNumber;
    base: (state: CivilizationState) => ExpNumber;
  }
> = {
  clickPower: {
    value: (state) => state.computeClickPower(),
    base: () => ExpNumber.ONE,
  },
  autoClickRate: {
    value: (state) => ExpNumber.fromNumber(state.autoClicksPerSecond),
    base: (state) => ExpNumber.fromNumber(state.autoClicksPerSecond),
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
const compoundStatValue = (
  state: CivilizationState,
  key: string,
): ExpNumber => {
  const factors = state.getDerivedAttributeFactors(key);
  if (!factors) return ExpNumber.ONE;
  const flat = factors.additional.reduce(
    (total, [, value]) => total.add(value),
    factors.base,
  );
  const multiplier = factors.multiplicative.reduce(
    (total, [, value]) => total.mul(value),
    ExpNumber.ONE,
  );
  return flat.mul(multiplier);
};

for (const key of [
  "buildingCostMultiplier",
  "wastedResources",
  "tradeProductionMultiplier",
]) {
  derivedAttributeComputations[key] = {
    value:
      key === "wastedResources"
        ? (state) => state.statistics.wastedResources
        : key === "tradeProductionMultiplier"
          ? (state) => calculateTradeMultiplier(state.resources.trade)
          : (state) => compoundStatValue(state, key),
    base: () => ExpNumber.ONE,
  };
}

/** Applies a tick rate to a resource amount, clamped so it never goes negative. */
const applyRate = (amount: ExpNumber, rate: ExpNumber): ExpNumber => {
  const next = amount.add(rate);
  return next.sign < 0 ? ExpNumber.ZERO : next;
};

export class CivilizationState {
  readonly resources: ResourceAmounts;
  readonly workers: WorkerAssignments;
  readonly builtBuildings: Partial<Record<BuildingKey, number>>;
  readonly resourceFactors: ResourceFactorMap;
  readonly buildingCostOverrides: BuildingCostOverrides;
  readonly autoClicksPerSecond: number;
  readonly boughtUpgrades: readonly string[];
  readonly defeatedEncounters: readonly string[];
  readonly enteredAges: readonly string[];
  readonly earnedAchievements: readonly string[];
  readonly boughtResearch: readonly string[];
  readonly statistics: Statistics;
  /** Units owned per unit id. Casualties never touch this (armies are restored). */
  readonly unitCounts: Record<string, ExpNumber>;
  /** Dev-tools production multiplier (×N on every producer rate, shown as a factor). */
  readonly devProductionMultiplier: ExpNumber;
  /** Dev-tools free flags: skip affordability + cost deduction, keep capacity gates. */
  readonly freeBuildings: boolean;
  readonly freeUnits: boolean;
  readonly freeUpgrades: boolean;

  constructor(
    resources: ResourceAmounts = emptyResourceAmounts(),
    workers: WorkerAssignments = emptyWorkerAssignments(),
    builtBuildings: Partial<Record<BuildingKey, number>> = { "town-hall": 1 },
    resourceFactors: ResourceFactorMap = emptyResourceFactors(),
    buildingCostOverrides: BuildingCostOverrides = {},
    autoClicksPerSecond = 0,
    boughtUpgrades: readonly string[] = [],
    defeatedEncounters: readonly string[] = [],
    enteredAges: readonly string[] = [],
    earnedAchievements: readonly string[] = [],
    statistics: Statistics = emptyStatistics(),
    unitCounts: Record<string, ExpNumber> = {},
    devProductionMultiplier: ExpNumber = ExpNumber.ONE,
    freeBuildings = false,
    freeUnits = false,
    freeUpgrades = false,
    boughtResearch: readonly string[] = [],
  ) {
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
    this.boughtResearch = boughtResearch;
    this.statistics = statistics;
    this.unitCounts = unitCounts;
    this.devProductionMultiplier = devProductionMultiplier;
    this.freeBuildings = freeBuildings;
    this.freeUnits = freeUnits;
    this.freeUpgrades = freeUpgrades;

    // Set population based on people buildings (derived from buildings, not stored)
    this.resources.population = ExpNumber.fromNumber(
      this.buildingCount("people"),
    );

    // Fresh states start with their default town hall's capacity grants.
    if (this.buildingCount("town-hall") > 0) {
      for (const effect of buildingDefinitions.find(
        ({ key }) => key === "town-hall",
      )?.effects.capacityProvided ?? []) {
        const targetKey = capacityKey(effect.building);
        if (this.resources[targetKey].isZero) {
          this.resources[targetKey] = effect.perBuilding.mul(
            ExpNumber.fromNumber(this.buildingCount("town-hall")),
          );
        }
      }
    }
  }

  get population(): ExpNumber {
    return this.resources.population;
  }

  get maximumPopulation(): ExpNumber {
    return this.resources.peopleCapacity;
  }

  get housingCapacity(): ExpNumber {
    return this.resources.peopleCapacity;
  }

  get assignedWorkers(): number {
    return Object.values(this.workers).reduce(
      (total, count) => total + Math.round(count.toNumber()),
      0,
    );
  }

  get availableWorkers(): number {
    return Math.max(
      0,
      Math.floor(this.population.toNumber()) - this.assignedWorkers,
    );
  }

  getWorkerProduction(resourceKey: ProductionResourceKey): WorkerProduction {
    const definition = productionDefinitions.find(
      ({ key }) => key === resourceKey,
    );
    return new WorkerProduction(
      resourceKey,
      definition?.label ?? resourceKey,
      this.workers[resourceKey],
      definition?.productionPerWorker ?? 1,
      resourceKey === ("population" as ProductionResourceKey)
        ? 0
        : this.autoClicksPerSecond,
      1,
    );
  }

  gather(resourceKey: ResourceKey): CivilizationState {
    if (!(resourceKey in this.resources) || !(resourceKey in this.workers))
      return this;
    const amount = this.computeClickGain(resourceKey);
    return this.withStatistics({
      ...this.statistics,
      productionClicks: this.statistics.productionClicks.add(ExpNumber.ONE),
    }).withResources({
      ...this.resources,
      [resourceKey]: this.resources[resourceKey].add(amount),
    });
  }

  /**
   * Counts one click anywhere in the UI shell. Production clicks are counted by
   * `gather()` instead, so the UI marks its gather buttons to be skipped.
   */
  recordUiClick(): CivilizationState {
    return this.withStatistics({
      ...this.statistics,
      uiClicks: this.statistics.uiClicks.add(ExpNumber.ONE),
    });
  }

  assignWorker(
    resourceKey: ProductionResourceKey,
    count: number = 1,
  ): CivilizationState {
    if (!(resourceKey in this.workers) || this.availableWorkers <= 0)
      return this;
    const actualCount = Math.min(Math.floor(count), this.availableWorkers);
    if (actualCount <= 0) return this;
    return this.withWorkers({
      ...this.workers,
      [resourceKey]: this.workers[resourceKey].add(
        ExpNumber.fromNumber(actualCount),
      ),
    });
  }

  unassignWorker(
    resourceKey: ProductionResourceKey,
    count: number = 1,
  ): CivilizationState {
    if (
      !(resourceKey in this.workers) ||
      this.workers[resourceKey].lte(ExpNumber.ZERO)
    )
      return this;
    const actualCount = Math.min(
      Math.floor(count),
      Math.round(this.workers[resourceKey].toNumber()),
    );
    if (actualCount <= 0) return this;
    return this.withWorkers({
      ...this.workers,
      [resourceKey]: this.workers[resourceKey].sub(
        ExpNumber.fromNumber(actualCount),
      ),
    });
  }

  /**
   * Assign all idle workers (or up to `count` when given).
   * Food workers are maintained at roughly 10 times each other resource,
   * starting with food, while equalizing the other resources among themselves.
   */
  autoAssignWorkers(count = Infinity): CivilizationState {
    const others = (
      Object.keys(this.workers) as ProductionResourceKey[]
    ).filter((key) => key !== "food");
    let workers = { ...this.workers };
    let available = this.availableWorkers; // already an integer (Math.max(0, Math.floor(...)))
    let remaining = Math.floor(count === Infinity ? available : count);

    while (available > 0 && remaining > 0) {
      if (others.length === 0) {
        workers.food = workers.food.add(ExpNumber.ONE);
        available -= 1;
        remaining -= 1;
        continue;
      }

      // Find the other resource with the minimum workers to keep others equalized
      let targetOther = others[0];
      let minOtherCount = Math.round(workers[targetOther].toNumber());
      for (const key of others) {
        const cnt = Math.round(workers[key].toNumber());
        if (cnt < minOtherCount) {
          minOtherCount = cnt;
          targetOther = key;
        }
      }

      // Maintain food at ~10× each other resource
      if (Math.round(workers.food.toNumber()) < 10 * (minOtherCount + 1)) {
        workers.food = workers.food.add(ExpNumber.ONE);
      } else {
        workers[targetOther] = workers[targetOther].add(ExpNumber.ONE);
      }

      available -= 1;
      remaining -= 1;
    }

    return this.availableWorkers === available
      ? this
      : this.withWorkers(workers);
  }

  /** Buy every building that is currently affordable and under its cap, one pass in definition order. */
  autoBuyBuildings(): CivilizationState {
    return buildingDefinitions.reduce<CivilizationState>((state, building) => {
      const next = state.build(
        building.key,
        state.getMaxAffordableBuildings(building.key),
      );
      return next === state ? state : next;
    }, this);
  }

  isUpgradeUnlocked(upgradeId: string): boolean {
    const upgrade = upgradeDefinitions.find(({ key }) => key === upgradeId);
    if (!upgrade) return false;
    return (
      upgrade.unlock.source === "building-count" &&
      this.buildingCount(upgrade.unlock.building) >= upgrade.unlock.threshold
    );
  }

  isUpgradeBought(upgradeId: string): boolean {
    return this.boughtUpgrades.includes(upgradeId);
  }

  getUpgradeCost(upgradeId: string): BuildingCost[] {
    return upgradeDefinitions.find(({ key }) => key === upgradeId)?.costs ?? [];
  }

  hasResourcesForUpgrade(upgradeId: string): boolean {
    return this.getUpgradeCost(upgradeId).every(({ resource, base }) =>
      this.resources[resource].gte(base),
    );
  }

  getUpgradeFailureReason(upgradeId: string): "locked" | "resources" | null {
    const upgrade = upgradeDefinitions.find(({ key }) => key === upgradeId);
    if (
      !upgrade ||
      this.isUpgradeBought(upgradeId) ||
      !this.isUpgradeUnlocked(upgradeId)
    )
      return "locked";
    if (!this.freeUpgrades && !this.hasResourcesForUpgrade(upgradeId))
      return "resources";
    return null;
  }

  /** Returns ids of every upgrade that is unlocked and currently affordable, in definition order. */
  getAffordableUpgrades(): string[] {
    return upgradeDefinitions
      .filter(({ key }) => this.getUpgradeFailureReason(key) === null)
      .map(({ key }) => key);
  }

  /**
   * Buys a one-shot upgrade: pays its costs and records its id. Bonuses are never
   * accumulated into state — factors and capacities derive them from this list.
   */
  buyUpgrade(upgradeId: string): CivilizationState {
    if (this.getUpgradeFailureReason(upgradeId) !== null) return this;
    const upgrade = upgradeDefinitions.find(({ key }) => key === upgradeId);
    if (!upgrade) return this;
    const resources = { ...this.resources };
    if (!this.freeUpgrades) {
      for (const { resource, base } of upgrade.costs) {
        resources[resource] = resources[resource].sub(base);
      }
    }
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      [...this.boughtUpgrades, upgradeId],
    );
  }

  /** The tech's age is entered and all prerequisites are bought. */
  isResearchUnlocked(researchId: string): boolean {
    const research = findResearchDefinition(researchId);
    if (!research) return false;
    if (
      research.age !== 0 &&
      !this.enteredAges.includes(`age-${research.age}`)
    ) {
      return false;
    }
    return research.prerequisites.every((prereq) =>
      this.boughtResearch.includes(prereq),
    );
  }

  isResearchBought(researchId: string): boolean {
    return this.boughtResearch.includes(researchId);
  }

  /**
   * The cost of the next research purchase, global across the whole tree: the
   * first tech costs 1K science and every later purchase costs ×10 the
   * previous one, whichever tech is bought.
   */
  getResearchNextCost(): BuildingCost[] {
    return [
      {
        resource: "science",
        base: researchFirstCost.mul(
          researchCostGrowth.pow(this.boughtResearch.length),
        ),
        factor: 1,
      },
    ];
  }

  hasResourcesForResearch(): boolean {
    return this.getResearchNextCost().every(({ resource, base }) =>
      this.resources[resource].gte(base),
    );
  }

  getResearchFailureReason(researchId: string): "locked" | "resources" | null {
    if (!this.isResearchUnlocked(researchId)) return "locked";
    if (!this.hasResourcesForResearch()) return "resources";
    return null;
  }

  canBuyResearch(researchId: string): boolean {
    return this.getResearchFailureReason(researchId) === null;
  }

  buyResearch(researchId: string): CivilizationState {
    if (this.boughtResearch.includes(researchId)) return this;
    if (!this.canBuyResearch(researchId)) return this;
    const research = findResearchDefinition(researchId);
    const resources = { ...this.resources };
    for (const { resource, base } of this.getResearchNextCost()) {
      resources[resource] = resources[resource].sub(base);
    }
    // Apply the tech's unit conversions: every `ratio` owned units of `from`
    // become one unit of `to`; the remainder stays on the (now closed) line.
    let unitCounts = this.unitCounts;
    for (const { from, to, ratio } of research?.conversions ?? []) {
      const owned = unitCounts[from] ?? ExpNumber.ZERO;
      const converted = owned.div(ExpNumber.fromNumber(ratio)).floor();
      if (converted.lte(ExpNumber.ZERO)) continue;
      if (unitCounts === this.unitCounts) unitCounts = { ...this.unitCounts };
      unitCounts[from] = owned.sub(converted.mul(ExpNumber.fromNumber(ratio)));
      unitCounts[to] = (unitCounts[to] ?? ExpNumber.ZERO).add(converted);
    }
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      [...this.boughtResearch, researchId],
    );
  }

  tick(): CivilizationState {
    const resources = { ...this.resources };
    for (const resourceKey of producerResourceKeys) {
      resources[resourceKey] = applyRate(
        resources[resourceKey],
        this.computeResourceRate(resourceKey),
      );
    }
    // One tick is one second of play time for both the lifetime counter and the
    // current run (a future prestige resets `runTimeMs` only).
    const activeStreakMs = this.statistics.activeStreakMs + tickMilliseconds;
    const statistics: Statistics = {
      ...this.statistics,
      playTimeMs: this.statistics.playTimeMs + tickMilliseconds,
      runTimeMs: this.statistics.runTimeMs + tickMilliseconds,
      onlineTimeMs: this.statistics.onlineTimeMs + tickMilliseconds,
      activeStreakMs,
      longestActiveMs: Math.max(
        this.statistics.longestActiveMs,
        activeStreakMs,
      ),
    };
    // Achievements are evaluated after the tick's changes so the check always runs
    // after a domain event has landed (roadmap Milestone 6). Age-reach times are
    // recorded first, so a record reflects the tick the threshold was met.
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      statistics,
    )
      .recordReachedAges()
      .checkAchievements();
  }

  /**
   * Per-second rate of every producer resource as one record. This is the input
   * the save system multiplies by the elapsed seconds to size offline gains.
   */
  getProductionRates(): Partial<Record<ResourceKey, ExpNumber>> {
    const rates: Partial<Record<ResourceKey, ExpNumber>> = {};
    for (const resourceKey of producerResourceKeys) {
      rates[resourceKey] = this.computeResourceRate(resourceKey);
    }
    return rates;
  }

  /** Offline efficiency after achievement bonuses, as a fraction of live gain. */
  getOfflineEfficiency(): number {
    let efficiency = ExpNumber.fromNumber(0.25);
    for (const [, bonus] of this.activeBonuses()) {
      if (bonus.destination !== "offlineEfficiency") continue;
      if (bonus.type === "attributeFlat")
        efficiency = efficiency.add(bonus.value);
      if (bonus.type === "attributeMultiplier")
        efficiency = efficiency.mul(bonus.value);
    }
    return Math.max(0, efficiency.toNumber());
  }

  /**
   * Credit offline production (roadmap Milestone 3). The amounts are already
   * scaled by the offline efficiency factor and capped by the save system, so
   * this is only the addition — and no play time is recorded, because the player
   * was not playing. Returns `this` when there is nothing to credit.
   */
  applyOfflineGain(gains: Record<string, ExpNumber>): CivilizationState {
    const resources = { ...this.resources };
    let changed = false;
    for (const [key, amount] of Object.entries(gains)) {
      if (!(key in resources)) continue;
      if (!amount || !amount.isFinite || amount.sign <= 0) continue;
      resources[key as ResourceKey] = resources[key as ResourceKey].add(amount);
      changed = true;
    }
    if (!changed) return this;
    return this.withState(
      resources,
      this.buildingCostOverrides,
    ).checkAchievements();
  }

  /** Record one imported/offline gap without advancing active play time. */
  recordOfflineTime(elapsedMs: number): CivilizationState {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return this;
    const statistics: Statistics = {
      ...this.statistics,
      offlineTimeMs: this.statistics.offlineTimeMs + elapsedMs,
      longestOfflineMs: Math.max(this.statistics.longestOfflineMs, elapsedMs),
      activeStreakMs: 0,
    };
    return this.withStatistics(statistics);
  }

  getFactors(resourceKey: ResourceKey): ResourceFactors {
    const factors = this.resourceFactors[resourceKey];
    // Production resources include worker-assignable resources (food, wood, stone, gold)
    // and building-generated resources (military, science, metalwork, trade)
    const isProductionKey = resourceKey in this.workers;
    const resourceLabels: Record<string, string> = {
      military: "Military",
      science: "Science",
      metalwork: "Metalwork",
      trade: "Trade",
    };
    const workerProduction = isProductionKey
      ? this.getWorkerProduction(resourceKey as ProductionResourceKey)
      : new WorkerProduction(
          resourceKey as ProductionResourceKey,
          resourceLabels[resourceKey] || resourceKey,
        );
    const buildingFactors: ResourceFactors = {
      additional: [],
      multiplicative: [],
      drain: [],
    };

    for (const building of buildingDefinitions) {
      const count = this.buildingCount(building.key);
      if (count === 0) continue;
      const effects = this.getBuildingEffects(building.key, count);
      for (const resourceMultiplier of effects.resourceMultiplier ?? []) {
        if (resourceMultiplier.resource === resourceKey) {
          buildingFactors.multiplicative.push([
            building.key,
            resourceMultiplier.factor,
          ]);
        }
      }
      for (const resourceDrain of effects.resourceDrain ?? []) {
        if (resourceDrain.resource === resourceKey) {
          buildingFactors.drain.push([building.key, resourceDrain.amount]);
        }
      }
      for (const resourceProduction of effects.resourceProduction ?? []) {
        if (resourceProduction.resource === resourceKey) {
          buildingFactors.additional.push([
            building.key,
            resourceProduction.amount,
          ]);
        }
      }
    }

    // Attribute bonuses from every source (upgrades, encounters, achievements)
    // land in the existing factor path (§13.6); drains from bonuses stay
    // unimplemented until data needs them.
    const bonusFactors: ResourceFactors = {
      additional: [],
      multiplicative: [],
      drain: [],
    };
    for (const [sourceId, bonus] of this.activeBonuses()) {
      const targetsResource = String(bonus.destination) === resourceKey;
      const targetsAllProduction =
        bonus.destination === "all-production" && isProductionKey;
      if (!targetsResource && !targetsAllProduction) continue;
      if (bonus.type === "attributeMultiplier") {
        bonusFactors.multiplicative.push([sourceId, bonus.value]);
      } else if (bonus.type === "attributeFlat") {
        bonusFactors.additional.push([sourceId, bonus.value]);
      }
    }

    const workerAdditional: ResourceFactor[] = [
      [workerProduction, workerProduction.workerProduction],
    ];
    if (workerProduction.autoClickProduction.gt(ExpNumber.ZERO)) {
      workerAdditional.push([
        "dev auto clicker",
        workerProduction.autoClickProduction,
      ] as ResourceFactor);
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

  getProductionFactors(resourceKey: ResourceKey): ResourceFactors {
    const base = this.getFactors(resourceKey);
    const multiplicative = [...base.multiplicative];

    // Add dev production multiplier
    if (!this.devProductionMultiplier.eq(ExpNumber.ONE)) {
      multiplicative.push([
        "dev production multiplier",
        this.devProductionMultiplier,
      ] as ResourceFactor);
    }

    // Add trade production multiplier for production resources
    const isProductionKey = resourceKey in this.workers;
    if (isProductionKey && this.resources.trade.gt(ExpNumber.ZERO)) {
      const tradeMultiplier = calculateTradeMultiplier(this.resources.trade);
      if (!tradeMultiplier.eq(ExpNumber.ONE)) {
        multiplicative.push([
          "trade production multiplier",
          tradeMultiplier,
        ] as ResourceFactor);
      }
    }

    return {
      ...base,
      multiplicative,
    };
  }

  computeResourceRate(resourceKey: ResourceKey): ExpNumber {
    return computeResourceRate(this.getProductionFactors(resourceKey));
  }

  computeClickGain(resourceKey: ResourceKey): ExpNumber {
    if (!(resourceKey in this.workers)) return ExpNumber.ZERO;
    const factors = this.getProductionFactors(resourceKey);
    const definition = productionDefinitions.find(
      ({ key }) => key === resourceKey,
    );
    // The global click power stat scales every manual click (§13.2 decision 2);
    // the resource's own `productionPerWorker` stays resource data.
    const clickPower = this.computeClickPower().mul(
      ExpNumber.fromNumber(definition?.productionPerWorker ?? 1),
    );
    return computeResourceRate({
      additional: [[clickPowerStatSource, clickPower]],
      multiplicative: factors.multiplicative,
      drain: [],
    });
  }

  /**
   * The global click power stat: base 1 plus every `clickPower` bonus in force.
   * Flats sum, multipliers compound — the attribute-bonus rule of §13.1, reused.
   */
  computeClickPower(): ExpNumber {
    let flat = ExpNumber.ONE;
    let multiplier = ExpNumber.ONE;
    for (const [, bonus] of this.activeBonuses()) {
      if (!this.isClickPowerDestination(String(bonus.destination))) continue;
      if (bonus.type === "attributeFlat") flat = flat.add(bonus.value);
      else if (bonus.type === "attributeMultiplier")
        multiplier = multiplier.mul(bonus.value);
    }
    return flat.mul(multiplier);
  }

  /**
   * The current value of an attribute: computed for derived stats, stored amount or
   * capacity base otherwise (§13.2).
   */
  getAttributeValue(key: string): ExpNumber {
    const attribute = findAttributeDefinition(key);
    if (!attribute) return ExpNumber.ZERO;
    if (attribute.family !== "derived") {
      return this.resources[key as ResourceKey] ?? ExpNumber.ZERO;
    }
    return derivedAttributeComputations[key]?.value(this) ?? ExpNumber.ZERO;
  }

  /**
   * The composition of a derived attribute (stat): its bonus-free base plus every
   * active flat/multiplier bonus targeting it, paired with their source ids so the
   * Gamepedia stat page can render linked factor rows (§13.2).
   */
  getDerivedAttributeFactors(key: string): DerivedAttributeFactors | undefined {
    const attribute = findAttributeDefinition(key);
    const computation = derivedAttributeComputations[key];
    if (attribute?.family !== "derived" || !computation) return undefined;
    const factors: DerivedAttributeFactors = {
      base: computation.base(this),
      additional: [],
      multiplicative: [],
    };
    for (const [sourceId, bonus] of this.activeBonuses()) {
      if (String(bonus.destination) !== key) continue;
      if (bonus.type === "attributeFlat") {
        factors.additional.push([sourceId, bonus.value]);
      } else if (bonus.type === "attributeMultiplier") {
        factors.multiplicative.push([sourceId, bonus.value]);
      }
    }
    return factors;
  }

  /** True when `destination` names the global click power attribute. */
  private isClickPowerDestination(destination: string): boolean {
    return destination === clickPowerStatSource;
  }

  setAutoClicksPerSecond(autoClicksPerSecond: number): CivilizationState {
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      Math.max(0, autoClicksPerSecond),
    );
  }

  getBuildingMax(buildingKey: string): ExpNumber {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return ExpNumber.ZERO;
    const capacity = capacityKey(building.key);
    // Effective capacity: the stored base amount plus capacity provided by other buildings,
    // then multiplied by every capacity multiplier in force (§13.7 decision 3).
    let max = this.resources[capacity];

    // Apply capacity multipliers
    for (const [, bonus] of this.activeBonuses()) {
      if (
        bonus.type === "attributeMultiplier" &&
        bonus.destination === capacity
      ) {
        max = max.mul(bonus.value);
      }
    }
    return max;
  }

  /** Shared production/stat recap; the base remains distinct from bonus additions. */
  getModifierSummary(key: string) {
    const derived = this.getDerivedAttributeFactors(key);
    const factors = derived
      ? {
          additional: derived.additional,
          multiplicative: derived.multiplicative,
          drain: [],
        }
      : this.getProductionFactors(key as ResourceKey);
    const totals = summarizeResourceFactors(factors);
    const base = derived?.base ?? ExpNumber.ZERO;
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
  getBuildingEffects(buildingKey: BuildingKey, count = 1): BuildingEffects {
    const effects = buildingDefinitions.find(
      ({ key }) => key === buildingKey,
    )?.effects;
    if (!effects) return {};
    const quantity = ExpNumber.fromNumber(count);
    return {
      resourceMultiplier:
        effects.resourceMultiplier?.map((effect) => ({
          ...effect,
          factor: effect.factor.pow(quantity),
        })) ?? undefined,
      resourceProduction:
        effects.resourceProduction?.map((effect) => ({
          ...effect,
          amount: effect.amount.mul(quantity),
        })) ?? undefined,
      resourceDrain:
        effects.resourceDrain?.map((effect) => ({
          ...effect,
          amount: effect.amount.mul(quantity),
        })) ?? undefined,
      capacityProvided:
        effects.capacityProvided?.map((effect) => ({
          ...effect,
          perBuilding: effect.perBuilding.mul(quantity),
        })) ?? undefined,
    };
  }

  /** Cost-reduction bonuses targeting one buyable, folded the §13.1 way. */
  private costReductionsFor(buyableId: string) {
    const sources = this.activeBonuses().filter(
      ([, bonus]) =>
        (bonus.destination === buyableId ||
          bonus.destination === "all-buildings") &&
        bonus.type.startsWith("costReduction"),
    );
    return {
      sources,
      reductions: collectCostReductions(sources.map(([, bonus]) => bonus)),
    };
  }

  getBuildingCostModifiers(buildingKey: string) {
    const { sources, reductions } = this.costReductionsFor(buildingKey);
    const globalMultiplier = ExpNumber.max(
      ExpNumber.ZERO,
      this.getAttributeValue("buildingCostMultiplier"),
    );
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
  getUnitCostModifiers(unitId: string) {
    return this.costReductionsFor(unitId);
  }

  /** Per-unit pipeline inputs, shared by buildings, units and their previews. */
  private costParameters(
    costs: BuildingCost[],
    reductions: CostReductions,
  ): CostParameters[] {
    return costs.map((cost) => ({
      cost,
      unitBase: ExpNumber.max(ExpNumber.ZERO, cost.base.mul(reductions.base)),
      unitFactor: ExpNumber.max(
        ExpNumber.fromNumber(1.01),
        ExpNumber.fromNumber(1.01).add(
          ExpNumber.fromNumber(cost.factor)
            .sub(ExpNumber.fromNumber(1.01))
            .mul(reductions.factor),
        ),
      ),
      reductions,
    }));
  }

  getBuildingCostParameters(buildingKey: string): CostParameters[] {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return [];
    const costs = this.buildingCostOverrides[building.key] ?? building.costs;
    const { reductions } = this.getBuildingCostModifiers(buildingKey);
    return this.costParameters(costs, reductions);
  }

  getUnitCostParameters(unitId: string): CostParameters[] {
    const unit = findUnitDefinition(unitId);
    if (!unit) return [];
    const { reductions } = this.getUnitCostModifiers(unitId);
    return this.costParameters(unit.costs, reductions);
  }

  getBuildingCost(
    buildingKey: string,
    buildingsAlreadyBuilt: number,
    count: number = 1,
  ): BuildingCost[] {
    return this.costSeries(
      this.getBuildingCostParameters(buildingKey),
      ExpNumber.fromNumber(buildingsAlreadyBuilt),
      count,
    );
  }

  /** Cost of the next `count` units, growing with the number already owned. */
  getUnitCost(unitId: string, count: number = 1): BuildingCost[] {
    return this.costSeries(
      this.getUnitCostParameters(unitId),
      this.getUnitCount(unitId),
      count,
    );
  }

  /**
   * Cost of `count` units from scratch (owned = 0), for the battle simulator's
   * "raise the army" totals. Public so dev-only UI can reuse the series
   * evaluator instead of re-implementing the cost pipeline.
   */
  costSeriesFrom(
    parameters: readonly CostParameters[],
    count: number,
  ): BuildingCost[] {
    return this.costSeries(parameters, ExpNumber.ZERO, count);
  }

  /**
   * Simulates a battle for arbitrary stacks (dev-only simulator): the player
   * side is the candidate composition, the enemy side its boosted stacks. The
   * seed folds in the battle id like the campaign path, so results replay.
   */
  simulateWithStacks(
    battleId: string,
    player: readonly ArmyStack[],
    enemy: readonly ArmyStack[],
  ): BattleSimulation {
    return simulateBattle(player, enemy, {
      seed: battleSeed(player, enemy, battleId),
    });
  }

  /** Owned count of one unit (units have no capacity ceiling, §13.3). */
  getUnitCount(unitId: string): ExpNumber {
    return this.unitCounts[unitId] ?? ExpNumber.ZERO;
  }

  /**
   * Every unit-stat bonus aimed at one unit, split per stat into summed flats
   * and compounded multipliers — the §13.1 stacking rule applied to units.
   */
  private collectUnitStatFactors(
    unit: UnitDefinition,
    sources: readonly (readonly [sourceId: string, bonus: Bonus])[],
  ): Record<UnitStatKey, { flat: ExpNumber; multiplier: ExpNumber }> {
    const factors: Record<
      UnitStatKey,
      { flat: ExpNumber; multiplier: ExpNumber }
    > = {
      hp: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      attack: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      armor: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      range: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      speed: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      accuracy: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
    };
    for (const [, bonus] of sources) {
      if (
        bonus.type !== "attributeFlat" &&
        bonus.type !== "attributeMultiplier"
      )
        continue;
      const target = parseUnitStatTarget(bonus.destination);
      if (!target || !unitMatchesStatTarget(unit, target)) continue;
      const bucket = factors[target.stat];
      if (bonus.type === "attributeFlat")
        bucket.flat = bucket.flat.add(bonus.value);
      else bucket.multiplier = bucket.multiplier.mul(bonus.value);
    }
    return factors;
  }

  /** Base stats, then summed flats, then compounded multipliers — per stat. */
  private unitStatsFromFactors(
    unit: UnitDefinition,
    factors: Record<UnitStatKey, { flat: ExpNumber; multiplier: ExpNumber }>,
  ): UnitStats {
    const grown = (stat: UnitStatKey): ExpNumber => {
      const base =
        stat === "hp" || stat === "attack"
          ? unit.stats[stat]
          : ExpNumber.fromNumber(unit.stats[stat]);
      return ExpNumber.max(
        ExpNumber.ZERO,
        base.add(factors[stat].flat).mul(factors[stat].multiplier),
      );
    };
    const scalar = (stat: UnitStatKey, upper: number): number =>
      Math.min(upper, Math.max(0, grown(stat).toNumber()));
    return {
      hp: grown("hp"),
      attack: grown("attack"),
      armor: scalar("armor", maximumArmor),
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
  private costSeries(
    parameters: readonly CostParameters[],
    buildingsAlreadyBuilt: ExpNumber,
    count: number,
  ): BuildingCost[] {
    return parameters.map(({ cost, unitBase, unitFactor, reductions }) => {
      // Per-unit pipeline: base → factor → percent → flat, clamped at zero.
      const firstGross = unitBase
        .mul(unitFactor.pow(buildingsAlreadyBuilt))
        .mul(reductions.percent);

      // Leading units whose gross cost the flat reduction absorbs entirely. The
      // gross grows by unitFactor per unit, so the prefix is short for any sane
      // data; a zero first gross clamps everything.
      let clamped = 0;
      if (reductions.flat.gt(ExpNumber.ZERO)) {
        if (firstGross.lte(ExpNumber.ZERO)) {
          clamped = count;
        } else if (firstGross.lte(reductions.flat)) {
          if (unitFactor.gt(ExpNumber.ONE)) {
            let gross = firstGross;
            while (clamped < count && gross.lte(reductions.flat)) {
              clamped += 1;
              gross = gross.mul(unitFactor);
            }
          } else {
            clamped = count;
          }
        }
      }

      const remaining = count - clamped;
      let total: ExpNumber;
      if (remaining <= 0) {
        total = ExpNumber.ZERO;
      } else {
        // Geometric series: sum_{i=0}^{remaining-1} gross_(clamped+i), minus the
        // flat reduction for every unclamped unit. For large counts the precise
        // per-item ceil barely matters vs the formula, so we round up at the end.
        const seriesFirst = firstGross.mul(unitFactor.pow(clamped));
        const grossSum = unitFactor.gt(ExpNumber.ONE)
          ? seriesFirst
              .mul(unitFactor.pow(remaining).sub(ExpNumber.ONE))
              .div(unitFactor.sub(ExpNumber.ONE))
          : seriesFirst.mul(ExpNumber.fromNumber(remaining));
        total = ExpNumber.max(
          ExpNumber.ZERO,
          grossSum.sub(reductions.flat.mul(ExpNumber.fromNumber(remaining))),
        );
      }
      return { ...cost, base: total.ceil() };
    });
  }

  formatBuildingCost(
    buildingKey: string,
    buildingsAlreadyBuilt: number,
    count: number = 1,
    format: (amount: ExpNumber) => string = String,
  ): string {
    return this.getBuildingCost(buildingKey, buildingsAlreadyBuilt, count)
      .map(({ resource, base }) => `${format(base)} ${resource}`)
      .join(" + ");
  }

  getMaxAffordableBuildings(buildingKey: string): number {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return 0;

    const capacityLimit = this.getBuildingMax(building.key).toNumber();
    const currentCount = this.buildingCount(building.key);
    let maxPossible =
      capacityLimit > 0 ? Math.max(0, capacityLimit - currentCount) : Infinity;

    if (buildingKey === "people") {
      maxPossible = Math.min(
        maxPossible,
        Math.max(
          0,
          this.maximumPopulation.toNumber() - this.population.toNumber(),
        ),
      );
    }

    // Dev-tools free mode: capacity still gates, but every in-capacity count is
    // affordable — the next cost stays displayed while the purchase skips payment.
    const canAffordCount = (n: number): boolean =>
      this.freeBuildings ||
      this.getBuildingCost(building.key, currentCount, n).every(
        ({ resource, base }) => this.resources[resource].gte(base),
      );

    // Upper bound: capacity-limited. Enhancer tiers push capacity to 1e9 by the
    // endgame, so allow the full range; the doubling probe stays O(log N).
    const upperBound = Math.min(
      maxPossible === Infinity ? 1_000_000_000 : maxPossible,
      1_000_000_000,
    );

    if (!canAffordCount(1)) return 0;

    // Doubling probe to find a tight upper bound (O(log N) calls, each O(1))
    let probe = 1;
    while (probe < upperBound && canAffordCount(probe * 2)) {
      probe *= 2;
    }
    if (probe >= upperBound && canAffordCount(upperBound)) return upperBound;

    // Binary search in [probe, probe*2] for the exact max
    let lo = probe;
    let hi = Math.min(probe * 2, upperBound);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (canAffordCount(mid)) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  upgradeBuildingLimit(
    buildingKey: BuildingKey,
    additionalSlots: number,
  ): CivilizationState {
    const capacity = capacityKey(buildingKey);
    const resources = {
      ...this.resources,
      // Raises the stored base, never the multiplied effective capacity —
      // otherwise bought capacity multipliers would compound twice.
      [capacity]: this.resources[capacity].add(
        ExpNumber.fromNumber(additionalSlots),
      ),
    };
    return this.withState(resources, this.buildingCostOverrides);
  }

  upgradeBuildingCosts(
    buildingKey: BuildingKey,
    costs: BuildingCost[],
  ): CivilizationState {
    return this.withState(this.resources, {
      ...this.buildingCostOverrides,
      [buildingKey]: costs,
    });
  }

  addFactor(
    resourceKey: ResourceKey,
    factorType: keyof ResourceFactors,
    factor: ResourceFactor,
  ): CivilizationState {
    const factors = this.resourceFactors[resourceKey];
    return this.withResourceFactors({
      ...this.resourceFactors,
      [resourceKey]: {
        ...factors,
        [factorType]: [...factors[factorType], factor],
      },
    });
  }

  getBuildingCount(buildingKey: string): number {
    return this.buildingCount(buildingKey);
  }

  isBuildingAtCapacity(buildingKey: string): boolean {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return false;
    const count = this.buildingCount(building.key);
    if (count >= this.getBuildingMax(building.key).toNumber()) return true;
    if (buildingKey === "people" && this.population.gte(this.maximumPopulation))
      return true;
    return false;
  }

  hasResourcesForBuilding(buildingKey: string, count: number = 1): boolean {
    if (this.freeBuildings) return true;
    const currentCount = this.buildingCount(buildingKey);
    return this.getBuildingCost(buildingKey, currentCount, count).every(
      ({ resource, base }) => this.resources[resource].gte(base),
    );
  }

  isBuildingAvailable(buildingKey: string): boolean {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !building.available) return false;
    const { unlock } = building;
    if (!unlock) return true;
    switch (unlock.source) {
      case "building-count":
        return this.buildingCount(unlock.building) >= unlock.threshold;
      case "battle":
        return this.defeatedEncounters.includes(unlock.encounterId);
      case "age":
        return this.isAgeUnlocked(unlock.ageId);
      default:
        return false;
    }
  }

  getBuildFailureReason(
    buildingKey: string,
    count: number = 1,
  ): "locked" | "capacity" | "resources" | null {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !this.isBuildingAvailable(building.key)) return "locked";

    const currentCount = this.buildingCount(building.key);
    if (currentCount + count > this.getBuildingMax(building.key).toNumber())
      return "capacity";
    if (
      buildingKey === "people" &&
      this.population.toNumber() + count > this.maximumPopulation.toNumber()
    )
      return "capacity";

    if (!this.hasResourcesForBuilding(building.key, count)) return "resources";

    return null;
  }

  build(buildingKey: string, count: number = 1): CivilizationState {
    if (count <= 0) return this;
    if (!this.canBuild(buildingKey, count)) return this;
    const builtCount = this.buildingCount(buildingKey);
    const cost = this.freeBuildings
      ? []
      : this.getBuildingCost(buildingKey, builtCount, count);

    const resources = { ...this.resources };
    for (const { resource, base } of cost) {
      resources[resource] = resources[resource].sub(base);
    }

    if (buildingKey === "people") {
      resources.population = resources.population.add(
        ExpNumber.fromNumber(count),
      );
    }
    for (const effect of buildingDefinitions.find(
      ({ key }) => key === buildingKey,
    )?.effects.capacityProvided ?? []) {
      const targetKey = capacityKey(effect.building);
      resources[targetKey] = resources[targetKey].add(
        effect.perBuilding.mul(ExpNumber.fromNumber(count)),
      );
    }

    const newBuildings = { ...this.builtBuildings };
    newBuildings[buildingKey as BuildingKey] =
      (newBuildings[buildingKey as BuildingKey] ?? 0) + count;

    return this.withState(
      resources,
      this.buildingCostOverrides,
      newBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      {
        ...this.statistics,
        // Cumulative: a building count never falls, so these are lifetime totals.
        buildingsBuilt: this.statistics.buildingsBuilt.add(
          ExpNumber.fromNumber(count),
        ),
        buildingsBuiltByKey: {
          ...this.statistics.buildingsBuiltByKey,
          [buildingKey]: (
            this.statistics.buildingsBuiltByKey[buildingKey] ?? ExpNumber.ZERO
          ).add(ExpNumber.fromNumber(count)),
        },
      },
    );
  }

  canBuild(buildingKey: string, count: number = 1): boolean {
    if (this.isBuildingAtCapacity(buildingKey)) return false;
    if (!this.hasResourcesForBuilding(buildingKey, count)) return false;
    return true;
  }

  private buildingCount(buildingKey: string): number {
    return this.builtBuildings[buildingKey as BuildingKey] ?? 0;
  }

  /** Bonuses from bought upgrades, paired with the upgrade id as the factor source. */
  private boughtUpgradeBonuses(): [upgradeId: string, bonus: Bonus][] {
    return this.boughtUpgrades.flatMap((upgradeId) =>
      (
        upgradeDefinitions.find(({ key }) => key === upgradeId)?.bonuses ?? []
      ).map((bonus) => [upgradeId, bonus] as [upgradeId: string, bonus: Bonus]),
    );
  }

  /** Bonuses from defeated encounters, paired with the encounter id as the source. */
  private defeatedEncounterBonuses(): [encounterId: string, bonus: Bonus][] {
    return this.defeatedEncounters.flatMap((encounterId) =>
      (
        encounterDefinitions.find(({ key }) => key === encounterId)?.bonuses ??
        []
      ).map(
        (bonus) => [encounterId, bonus] as [encounterId: string, bonus: Bonus],
      ),
    );
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
  private earnedAchievementBonuses(): [achievementId: string, bonus: Bonus][] {
    const results: [achievementId: string, bonus: Bonus][] = [];
    for (const achievementId of this.earnedAchievements) {
      if (chainFamilyForId(achievementId)) continue;
      const definition = findAchievementDefinition(achievementId);
      for (const bonus of definition?.bonuses ?? []) {
        results.push([achievementId, bonus]);
      }
    }
    for (const chain of openEndedHoarderChains) {
      const prefix = `${chain.family}-e`;
      let total = ExpNumber.ZERO;
      let earned = false;
      for (const achievementId of this.earnedAchievements) {
        if (!achievementId.startsWith(prefix)) continue;
        earned = true;
        for (const bonus of findAchievementDefinition(achievementId)?.bonuses ??
          []) {
          if (
            bonus.type === "attributeFlat" &&
            bonus.destination === chain.resource
          ) {
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
   * Cached on the identity of the four source id lists: rebuilt once per real
   * change, reused by every query in between (see the module cache note). Age bonuses
   * are derived from `enteredAges` (permanent entries) the same way research/encounters
   * derive from their bought/defeated lists.
   */
  private activeBonuses(): [sourceId: string, bonus: Bonus][] {
    let byUpgrades = activeBonusCaches.get(this.boughtUpgrades);
    if (!byUpgrades) {
      byUpgrades = new WeakMap<
        readonly string[],
        WeakMap<
          readonly string[],
          WeakMap<
            readonly string[],
            WeakMap<readonly string[], ActiveBonusList>
          >
        >
      >();
      activeBonusCaches.set(this.boughtUpgrades, byUpgrades);
    }
    let byEncounters = byUpgrades.get(this.defeatedEncounters);
    if (!byEncounters) {
      byEncounters = new WeakMap<
        readonly string[],
        WeakMap<readonly string[], WeakMap<readonly string[], ActiveBonusList>>
      >();
      byUpgrades.set(this.defeatedEncounters, byEncounters);
    }
    let byAchievements = byEncounters.get(this.earnedAchievements);
    if (!byAchievements) {
      byAchievements = new WeakMap<
        readonly string[],
        WeakMap<readonly string[], ActiveBonusList>
      >();
      byEncounters.set(this.earnedAchievements, byAchievements);
    }
    let byResearch = byAchievements.get(this.boughtResearch);
    if (!byResearch) {
      byResearch = new WeakMap<readonly string[], ActiveBonusList>();
      byAchievements.set(this.boughtResearch, byResearch);
    }
    const cached = byResearch.get(this.enteredAges);
    if (cached) return cached;
    const computed: [sourceId: string, bonus: Bonus][] = [
      ...this.boughtUpgradeBonuses(),
      ...this.defeatedEncounterBonuses(),
      ...this.earnedAchievementBonuses(),
      ...this.boughtResearchBonuses(),
      ...this.enteredAgeBonuses(),
    ];
    byResearch.set(this.enteredAges, computed);
    return computed;
  }

  /**
   * Bonuses from bought researches, paired with the research id as the source.
   * Derived from the bought id list, never stored as applied values (§13.4).
   */
  private boughtResearchBonuses(): [researchId: string, bonus: Bonus][] {
    const results: [researchId: string, bonus: Bonus][] = [];
    for (const researchId of this.boughtResearch) {
      const definition = findResearchDefinition(researchId);
      for (const bonus of definition?.bonuses ?? []) {
        results.push([researchId, bonus]);
      }
    }
    return results;
  }

  /**
   * Apply a batch of attribute bonuses (flat/multiplier/drain) to the resource factor
   * model, threading the accumulator through addFactor() calls. Used by enterAge() so age
   * bonuses flow into getFactors()/getBuildingMax() via activeBonuses() without aliasing
   * `this` (which the lint config forbids).
   */
  private applyAttributeBonuses(
    bonuses: readonly Bonus[],
    sourceId: string,
    state: CivilizationState,
  ): CivilizationState {
    let acc = state;
    for (const bonus of bonuses) {
      const factorType =
        bonus.type === "attributeFlat"
          ? "additional"
          : bonus.type === "attributeMultiplier"
            ? "multiplicative"
            : "drain";
      acc = acc.addFactor(
        bonus.destination as Parameters<typeof acc.addFactor>[0],
        factorType,
        [sourceId, bonus.value],
      );
    }
    return acc;
  }

  /**
   * Bonuses from entered ages, paired with the age id as the source.
   * Derived from the entered id list, never stored as applied values (§13.4).
   * Ages are permanent entries, so these persist for the life of the state.
   */
  private enteredAgeBonuses(): [ageId: string, bonus: Bonus][] {
    const results: [ageId: string, bonus: Bonus][] = [];
    for (const ageId of this.enteredAges) {
      const age = findAgeDefinition(ageId);
      for (const bonus of age?.bonuses ?? []) {
        results.push([ageId, bonus]);
      }
    }
    return results;
  }

  defeatEncounter(encounterId: string): CivilizationState {
    if (this.defeatedEncounters.includes(encounterId)) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      [...this.defeatedEncounters, encounterId],
      this.enteredAges,
      this.earnedAchievements,
      {
        ...this.statistics,
        fastestBattleMs: this.recordFastest(
          this.statistics.fastestBattleMs,
          encounterId,
        ),
      },
    );
  }

  isAchievementEarned(achievementId: string): boolean {
    return this.earnedAchievementSet().has(achievementId);
  }

  /** O(1) membership via a Set cached on the earned id list's identity. */
  private earnedAchievementSet(): Set<string> {
    let set = earnedAchievementSets.get(this.earnedAchievements);
    if (!set) {
      set = new Set(this.earnedAchievements);
      earnedAchievementSets.set(this.earnedAchievements, set);
    }
    return set;
  }

  /** Can the player buy this unit: base-available, unlocked by a won battle or
   *  a bought research — minus lines a bought research has closed. */
  isUnitAvailable(unitId: string): boolean {
    const unit = findUnitDefinition(unitId);
    if (!unit || !isBuyableUnit(unit)) return false;
    if (
      researchesClosingUnit(unitId).some((research) =>
        this.boughtResearch.includes(research.key),
      )
    ) {
      return false;
    }
    if (unit.available) return true;
    if (
      researchesUnlockingUnit(unitId).some((research) =>
        this.boughtResearch.includes(research.key),
      )
    ) {
      return true;
    }
    return false;
  }

  /** The Army tab's buyable roster: current + previous age, unlocked only. */
  getRosterUnits(): UnitDefinition[] {
    const currentAge = this.getCurrentAge();
    if (!currentAge) return [];
    const currentAgeIndex = ageDefinitions.findIndex(
      (a) => a.key === currentAge.key,
    );
    return unitDefinitions.filter(
      (unit) =>
        isBuyableUnit(unit) &&
        this.isUnitAvailable(unit.key) &&
        unit.age >= currentAgeIndex - 1 &&
        unit.age <= currentAgeIndex,
    );
  }

  hasResourcesForUnit(unitId: string, count: number = 1): boolean {
    if (this.freeUnits) return true;
    return this.getUnitCost(unitId, count).every(({ resource, base }) =>
      this.resources[resource].gte(base),
    );
  }

  getUnitFailureReason(
    unitId: string,
    count: number = 1,
  ): "locked" | "resources" | null {
    if (!this.isUnitAvailable(unitId)) return "locked";
    if (!this.hasResourcesForUnit(unitId, count)) return "resources";
    return null;
  }

  canBuyUnit(unitId: string, count: number = 1): boolean {
    return this.getUnitFailureReason(unitId, count) === null;
  }

  /** Buy-MAX for units (no capacity cap): the shared O(log n) probe. */
  getMaxAffordableUnits(unitId: string): number {
    if (!this.isUnitAvailable(unitId)) return 0;
    return maxAffordableCount(
      (n) => this.hasResourcesForUnit(unitId, n),
      maximumUnitPurchase,
    );
  }

  buyUnit(unitId: string, count: number = 1): CivilizationState {
    if (count <= 0 || !this.canBuyUnit(unitId, count)) return this;
    const cost = this.freeUnits ? [] : this.getUnitCost(unitId, count);
    const resources = { ...this.resources };
    for (const { resource, base } of cost) {
      resources[resource] = resources[resource].sub(base);
    }
    return this.withResources(resources).withUnitCount(
      unitId,
      this.getUnitCount(unitId).add(ExpNumber.fromNumber(count)),
    );
  }

  /** The player's army as battle stacks, with every bonus in force applied. */
  getArmyStacks(): ArmyStack[] {
    const stacks: ArmyStack[] = [];
    for (const unit of unitDefinitions) {
      const count = this.getUnitCount(unit.key);
      if (count.lte(ExpNumber.ZERO)) continue;
      const stats = this.getUnitStats(unit.key);
      if (stats) stacks.push({ unitId: unit.key, count, stats });
    }
    return stacks;
  }

  getArmyPower(): ExpNumber {
    return armyPower(this.getArmyStacks());
  }

  /** Effective stats of one unit, with every active bonus applied. */
  getUnitStats(unitId: string): UnitStats | undefined {
    const unit = findUnitDefinition(unitId);
    if (!unit) return undefined;
    return this.unitStatsFromFactors(
      unit,
      this.collectUnitStatFactors(unit, this.activeBonuses()),
    );
  }

  /** One enemy army, with the battle's "fake research" boosts applied. */
  getEnemyStacks(encounterId: string): ArmyStack[] {
    const encounter = findEncounterDefinition(encounterId);
    if (!encounter) return [];
    const boosts = encounter.enemyBoosts.map(
      (bonus) => [encounter.key, bonus] as const,
    );
    const stacks: ArmyStack[] = [];
    for (const { unitId, count } of encounter.enemyArmy) {
      const unit = findUnitDefinition(unitId);
      if (!unit) continue;
      const stats = this.unitStatsFromFactors(
        unit,
        this.collectUnitStatFactors(unit, boosts),
      );
      stacks.push({ unitId, count: ExpNumber.fromNumber(count), stats });
    }
    return stacks;
  }

  /** The next battle the campaign offers: the first not-yet-won encounter in the
   *  current age only. Battles outside the current age are never offered. */
  getNextBattle(): EncounterDefinition | undefined {
    const currentAge = this.getCurrentAge();
    if (!currentAge) return undefined;
    const currentAgeIndex = ageDefinitions.findIndex(
      (a) => a.key === currentAge.key,
    );
    return encounterDefinitions.find(
      (encounter) =>
        encounter.age === currentAgeIndex &&
        !this.defeatedEncounters.includes(encounter.key),
    );
  }

  /** Whether more battles exist but are locked behind entering the next age. */
  hasLockedBattles(): boolean {
    return encounterDefinitions.some(
      (encounter) =>
        !this.defeatedEncounters.includes(encounter.key) &&
        !this.isAgeUnlocked(`age-${encounter.age}`),
    );
  }

  /**
   * Runs the fight without touching any state, so the UI can play the round log
   * back one round per second before the result is applied. The seed folds in
   * the battle id, so the same armies fight the same battle every replay.
   */
  simulateEncounter(encounterId: string): BattleSimulation | undefined {
    const encounter = findEncounterDefinition(encounterId);
    if (!encounter) return undefined;
    // Battles outside the current age cannot be fought.
    const currentAge = this.getCurrentAge();
    if (!currentAge) return undefined;
    const currentAgeIndex = ageDefinitions.findIndex(
      (a) => a.key === currentAge.key,
    );
    if (encounter.age !== currentAgeIndex) return undefined;
    const player = this.getArmyStacks();
    const enemy = this.getEnemyStacks(encounterId);
    if (player.length === 0 || enemy.length === 0) return undefined;
    return simulateBattle(player, enemy, {
      seed: battleSeed(player, enemy, encounter.key),
    });
  }

  /**
   * Applies a finished battle: a player win records the victory (and its
   * unlocks); a loss or stalemate changes nothing. Casualties never persist —
   * `unitCounts` is untouched, so armies are restored after every battle.
   */
  resolveBattle(
    encounterId: string,
    simulation?: BattleSimulation,
  ): CivilizationState {
    if (this.defeatedEncounters.includes(encounterId)) return this;
    const encounter = findEncounterDefinition(encounterId);
    if (!encounter) return this;
    // Battles outside the current age cannot be fought.
    const currentAge = this.getCurrentAge();
    if (!currentAge) return this;
    const currentAgeIndex = ageDefinitions.findIndex(
      (a) => a.key === currentAge.key,
    );
    if (encounter.age !== currentAgeIndex) return this;
    const result = simulation ?? this.simulateEncounter(encounterId);
    if (!result || result.outcome !== "player") return this;
    return this.defeatEncounter(encounterId);
  }

  /**
   * The fastest run time at which `id` was reached, kept across runs: a record
   * already set is only replaced by a strictly faster one.
   */
  private recordFastest(
    times: Record<string, number>,
    id: string,
  ): Record<string, number> {
    const best = times[id];
    if (best !== undefined && best <= this.statistics.runTimeMs) return times;
    return { ...times, [id]: this.statistics.runTimeMs };
  }

  /**
   * Records the run time at which each age's population threshold was first met.
   * `getCurrentAge()` keys an age off population, so crossing the threshold is what
   * "arriving" at an age means — the fastest time is the first tick that sees it.
   * `enterAge()` records too (it is the later of the two events), and both go through
   * the min-keeping `recordFastest()` rule, so the earliest sighting always wins.
   */
  private recordReachedAges(): CivilizationState {
    let fastestAgeMs = this.statistics.fastestAgeMs;
    for (const age of ageDefinitions) {
      if (this.population.toNumber() < age.populationThreshold) continue;
      if (fastestAgeMs[age.key] !== undefined) continue;
      fastestAgeMs = { ...fastestAgeMs, [age.key]: this.statistics.runTimeMs };
    }
    if (fastestAgeMs === this.statistics.fastestAgeMs) return this;
    return this.withStatistics({ ...this.statistics, fastestAgeMs });
  }

  /** Play time (ms) of the fastest recorded run that won this encounter, if any. */
  getFastestBattleTime(encounterId: string): number | undefined {
    return this.statistics.fastestBattleMs[encounterId];
  }

  /** The live value a requirement is measured against (feeds the achievements tab). */
  getRequirementValue(requirement: AchievementRequirement): ExpNumber {
    switch (requirement.type) {
      case "resource":
        return this.resources[requirement.resource];
      case "population":
        return this.resources.population;
      case "clicks":
        return this.statistics.productionClicks;
      case "building-count":
        return ExpNumber.fromNumber(this.buildingCount(requirement.building));
      case "buildings-total":
        return this.statistics.buildingsBuilt;
      case "encounter":
        return this.defeatedEncounters.includes(requirement.encounterId)
          ? ExpNumber.ONE
          : ExpNumber.ZERO;
      case "upgrade-count":
        return ExpNumber.fromNumber(this.boughtUpgrades.length);
      case "offline-time":
        return ExpNumber.fromNumber(this.statistics.longestOfflineMs);
      case "active-time":
        return ExpNumber.fromNumber(this.statistics.longestActiveMs);
    }
  }

  private requirementThreshold(requirement: AchievementRequirement): ExpNumber {
    switch (requirement.type) {
      case "resource":
      case "population":
      case "clicks":
        return requirement.amount;
      case "building-count":
      case "buildings-total":
        return ExpNumber.fromNumber(requirement.count);
      case "encounter":
        return ExpNumber.ONE;
      case "upgrade-count":
        return ExpNumber.fromNumber(requirement.count);
      case "offline-time":
      case "active-time":
        return ExpNumber.fromNumber(requirement.amount);
    }
  }

  /**
   * The next milestone of an achievement family: its name, the threshold the
   * family is measured against, and the reward it will grant. Concrete tiers
   * come first; once they run out, an open-ended chain reports its next
   * exponent. `undefined` when the family has no tiers left.
   */
  getNextAchievementGoal(
    family: string,
  ): { name: string; threshold: ExpNumber; bonuses: Bonus[] } | undefined {
    const earned = this.earnedAchievementSet();
    const concrete = achievementDefinitions
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
    const chain = openEndedHoarderChains.find(
      ({ family: chainFamily }) => chainFamily === family,
    );
    if (!chain) return undefined;
    const exponent = nextHoarderExponent(chain, this.earnedAchievements);
    const tier = materializeOpenEndedTier(chain, exponent);
    return {
      name: tier.name,
      threshold: ExpNumber.fromLog10(exponent),
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
  private openEndedChainEarnings(): string[] {
    const newlyEarned: string[] = [];
    for (const chain of openEndedHoarderChains) {
      const held = this.resources[chain.resource];
      if (held.lte(ExpNumber.ZERO)) continue;
      const heldExponent = Math.floor(held.log10());
      let exponent = nextHoarderExponent(chain, this.earnedAchievements);
      const endExponent =
        chain.startExponent +
        Math.floor((heldExponent - chain.startExponent) / chain.exponentStep) *
          chain.exponentStep;
      if (!Number.isSafeInteger(endExponent) || exponent > endExponent)
        continue;
      const count = (endExponent - exponent) / chain.exponentStep + 1;
      if (count > 1000) {
        newlyEarned.push(
          `${chain.family}-e${exponent}-through-e${endExponent}`,
        );
        continue;
      }
      for (; exponent <= endExponent; exponent += chain.exponentStep) {
        newlyEarned.push(`${chain.family}-e${exponent}`);
      }
    }
    return newlyEarned;
  }

  private meetsRequirement(requirement: AchievementRequirement): boolean {
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
        return this.statistics.buildingsBuilt.gte(
          ExpNumber.fromNumber(requirement.count),
        );
      case "encounter":
        return this.defeatedEncounters.includes(requirement.encounterId);
      case "upgrade-count":
        return this.boughtUpgrades.length >= requirement.count;
      case "offline-time":
        return this.statistics.longestOfflineMs >= requirement.amount;
      case "active-time":
        return this.statistics.longestActiveMs >= requirement.amount;
      default:
        return false;
    }
  }

  /**
   * Records every achievement whose requirement is met, once. Earned ids are the
   * only achievement data in state – never applied bonuses – so migrations and
   * re-balancing stay safe (roadmap Milestone 6). Returns `this` when nothing is new.
   */
  checkAchievements(): CivilizationState {
    const earned = this.earnedAchievementSet();
    const newlyEarned = [
      ...achievementDefinitions
        .filter(
          ({ key, requirement }) =>
            !earned.has(key) && this.meetsRequirement(requirement),
        )
        .map(({ key }) => key),
      ...this.openEndedChainEarnings(),
    ];
    if (newlyEarned.length === 0) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      [...this.earnedAchievements, ...newlyEarned],
    );
  }

  private withResources(resources: ResourceAmounts): CivilizationState {
    return this.withState(resources, this.buildingCostOverrides);
  }

  private withWorkers(workers: WorkerAssignments): CivilizationState {
    return new CivilizationState(
      this.resources,
      workers,
      this.builtBuildings,
      this.resourceFactors,
      this.buildingCostOverrides,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
    );
  }

  private withResourceFactors(
    resourceFactors: ResourceFactorMap,
  ): CivilizationState {
    return new CivilizationState(
      this.resources,
      this.workers,
      this.builtBuildings,
      resourceFactors,
      this.buildingCostOverrides,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
    );
  }

  private withStatistics(statistics: Statistics): CivilizationState {
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      statistics,
    );
  }

  private withUnitCount(unitId: string, count: ExpNumber): CivilizationState {
    const unitCounts = { ...this.unitCounts };
    if (count.lte(ExpNumber.ZERO)) delete unitCounts[unitId];
    else unitCounts[unitId] = count;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      unitCounts,
    );
  }

  private withState(
    resources: ResourceAmounts,
    costOverrides: BuildingCostOverrides,
    builtBuildings = this.builtBuildings,
    autoClicksPerSecond = this.autoClicksPerSecond,
    boughtUpgrades = this.boughtUpgrades,
    defeatedEncounters = this.defeatedEncounters,
    enteredAges = this.enteredAges,
    earnedAchievements = this.earnedAchievements,
    statistics = this.statistics,
    unitCounts = this.unitCounts,
    devProductionMultiplier = this.devProductionMultiplier,
    freeBuildings = this.freeBuildings,
    freeUnits = this.freeUnits,
    freeUpgrades = this.freeUpgrades,
    boughtResearch = this.boughtResearch,
  ): CivilizationState {
    return new CivilizationState(
      resources,
      this.workers,
      builtBuildings,
      this.resourceFactors,
      costOverrides,
      autoClicksPerSecond,
      boughtUpgrades,
      defeatedEncounters,
      enteredAges,
      earnedAchievements,
      statistics,
      unitCounts,
      devProductionMultiplier,
      freeBuildings,
      freeUnits,
      freeUpgrades,
      boughtResearch,
    );
  }

  /** Dev-tools: global production multiplier (×N on every producer rate). */
  setDevProductionMultiplier(multiplier: ExpNumber): CivilizationState {
    const value =
      multiplier.isFinite && !multiplier.isNegative && !multiplier.isZero
        ? multiplier
        : ExpNumber.ONE;
    if (value.eq(this.devProductionMultiplier)) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      value,
    );
  }

  /** Dev-tools: free buildings (skip affordability + deduction, keep capacity). */
  setFreeBuildings(free: boolean): CivilizationState {
    if (free === this.freeBuildings) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      free,
    );
  }

  /** Dev-tools: free units (skip affordability + deduction, keep availability). */
  setFreeUnits(free: boolean): CivilizationState {
    if (free === this.freeUnits) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      free,
    );
  }

  /** Dev-tools: free upgrades (skip affordability + deduction, keep unlock gates). */
  setFreeUpgrades(free: boolean): CivilizationState {
    if (free === this.freeUpgrades) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      free,
    );
  }

  /**
   * Dev-tools: advance the simulation by whole seconds in one step. Every
   * production rate is constant across the window — nothing in the model feeds
   * resource amounts back into the rates — so the skip is one multiply per
   * producer resource instead of a per-second loop. Auto clicks are already
   * part of the rate; auto-buy and auto-assign stay with the live loop.
   */
  advanceTime(seconds: number): CivilizationState {
    const wholeSeconds = Math.floor(seconds);
    if (!Number.isFinite(wholeSeconds) || wholeSeconds <= 0) return this;
    const elapsed = Math.min(wholeSeconds, 86_400);
    const elapsedFactor = ExpNumber.fromNumber(elapsed);
    const resources = { ...this.resources };
    for (const resourceKey of producerResourceKeys) {
      resources[resourceKey] = applyRate(
        resources[resourceKey],
        this.computeResourceRate(resourceKey).mul(elapsedFactor),
      );
    }
    const activeStreakMs =
      this.statistics.activeStreakMs + elapsed * tickMilliseconds;
    const statistics: Statistics = {
      ...this.statistics,
      playTimeMs: this.statistics.playTimeMs + elapsed * tickMilliseconds,
      runTimeMs: this.statistics.runTimeMs + elapsed * tickMilliseconds,
      onlineTimeMs: this.statistics.onlineTimeMs + elapsed * tickMilliseconds,
      activeStreakMs,
      longestActiveMs: Math.max(
        this.statistics.longestActiveMs,
        activeStreakMs,
      ),
    };
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      statistics,
    )
      .recordReachedAges()
      .checkAchievements();
  }

  enterAge(ageId: string): CivilizationState {
    if (this.enteredAges.includes(ageId)) return this;
    const age = findAgeDefinition(ageId);
    if (!age) return this;

    // Retire units from N-2 age (units from two ages ago)
    const currentAgeIndex = ageDefinitions.findIndex((a) => a.key === ageId);
    const retireAgeIndex = currentAgeIndex - 2;
    let wasted = ExpNumber.ZERO;
    const newUnitCounts = { ...this.unitCounts };

    if (retireAgeIndex >= 0) {
      for (const [unitId, count] of Object.entries(this.unitCounts)) {
        const unitDef = findUnitDefinition(unitId);
        if (unitDef && unitDef.age === retireAgeIndex) {
          // Compute the cost of these units (what was "wasted")
          const unitCost = this.getUnitCost(unitId, 0);
          const totalCost = unitCost.reduce<ExpNumber>(
            (total, { base }) => total.add(base.mul(count)),
            ExpNumber.ZERO,
          );
          wasted = wasted.add(totalCost);
          delete newUnitCounts[unitId];
        }
      }
    }

    // Apply age bonuses (data-driven path: ages.json → AgeDefinition.bonuses → engine).
    // Attribute-targeted bonuses fold into the existing factor model via addFactor(); they
    // are then re-derived from enteredAges inside activeBonuses() so getBuildingMax() /
    // getFactors() / etc. pick them up. This replaces the old hardcoded "×10 town-hall
    // capacity" with a data-driven path.
    const afterBonuses = this.applyAttributeBonuses(age.bonuses, ageId, this);

    return afterBonuses.withState(
      afterBonuses.resources,
      afterBonuses.buildingCostOverrides,
      afterBonuses.builtBuildings,
      afterBonuses.autoClicksPerSecond,
      afterBonuses.boughtUpgrades,
      afterBonuses.defeatedEncounters,
      [...afterBonuses.enteredAges, ageId],
      afterBonuses.earnedAchievements,
      {
        ...afterBonuses.statistics,
        fastestAgeMs: afterBonuses.recordFastest(
          afterBonuses.statistics.fastestAgeMs,
          ageId,
        ),
        wastedResources: afterBonuses.statistics.wastedResources.add(wasted),
      },
      newUnitCounts,
    );
  }

  /** The current age, based on population thresholds (highest threshold ≤ population).
   *  Capped at the first unentered age so population can never skip an unfinished
   *  age: the current age only advances past an age once it has been entered. */
  getCurrentAge(): AgeDefinition | undefined {
    let popIndex = -1;
    const pop = this.population.toNumber();
    for (let i = 0; i < ageDefinitions.length; i++) {
      if (pop >= ageDefinitions[i].populationThreshold) popIndex = i;
    }
    // Below the first threshold the village is still in the first age.
    if (popIndex < 0) popIndex = 0;
    const firstUnentered = ageDefinitions.findIndex(
      (a) => !this.enteredAges.includes(a.key),
    );
    // Every age entered: the pop-based age is current.
    if (firstUnentered < 0) return ageDefinitions[popIndex];
    return ageDefinitions[Math.min(popIndex, firstUnentered)];
  }

  /** Battle progress in the current age: [wonCount, totalCount]. */
  getAgeBattleProgress(): [number, number] {
    const age = this.getCurrentAge();
    if (!age) return [0, 0];
    const ageIndex = parseInt(age.key.slice(-1), 10);
    const totalBattles = encounterDefinitions.filter(
      (e) => e.age === ageIndex,
    ).length;
    const wonBattles = encounterDefinitions.filter(
      (e) => e.age === ageIndex && this.defeatedEncounters.includes(e.key),
    ).length;
    return [wonBattles, totalBattles];
  }

  /** Building progress in the current age: [buildings, target].
   *  Target is 125% of the age's pop max (the next age's population threshold). */
  getAgeBuildingProgress(): [number, number] {
    const age = this.getCurrentAge();
    if (!age) return [0, 0];
    const buildings = Object.values(this.builtBuildings).reduce(
      (sum, count) => sum + count,
      0,
    );
    const target = this.getAgeBuildingTarget(age);
    return [buildings, target];
  }

  /** Building target for an age: 125% of the next age's threshold (this age's pop max). */
  private getAgeBuildingTarget(age: AgeDefinition): number {
    const ageIndex = ageDefinitions.findIndex((a) => a.key === age.key);
    const next = ageIndex >= 0 ? ageDefinitions[ageIndex + 1] : undefined;
    const base = next ? next.populationThreshold : age.populationThreshold;
    return Math.ceil(base * 1.25);
  }

  /** Whether the player can enter the given age (battles done + buildings ≥ 125% age pop max). */
  canEnterAge(ageId: string): boolean {
    const age = findAgeDefinition(ageId);
    if (!age) return false;
    if (this.enteredAges.includes(ageId)) return false;

    // Check battles: all battles in this age must be won
    const ageIndex = parseInt(age.key.slice(-1), 10);
    const ageBattles = encounterDefinitions.filter((e) => e.age === ageIndex);
    const allBattlesWon = ageBattles.every((b) =>
      this.defeatedEncounters.includes(b.key),
    );
    if (!allBattlesWon) return false;

    // Check buildings: total buildings ≥ 125% of the age's pop max
    const target = this.getAgeBuildingTarget(age);
    const totalBuildings = Object.values(this.builtBuildings).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (totalBuildings < target) return false;

    return true;
  }

  /** Whether the given age is currently "unlocked" (winnable) — all prior ages entered. */
  isAgeUnlocked(ageId: string): boolean {
    const ageIndex = parseInt(ageId.slice(-1), 10);
    // Age 0 is always unlocked
    if (ageIndex === 0) return true;
    // Check that the previous age has been entered
    const prevAgeId = `age-${ageIndex - 1}`;
    return this.enteredAges.includes(prevAgeId);
  }

  getFastestAgeTime(ageId: string): number | undefined {
    return this.statistics.fastestAgeMs[ageId];
  }

  /**
   * Trade operations: sell resource for gold, buy resource with gold
   * Trade power acts as a currency that can be converted to gold for trading
   */
  sellResource(
    resource: TradeResourceKey,
    amount: ExpNumber,
  ): CivilizationState {
    if (!isTradable(resource)) return this;
    if (this.resources[resource].lt(amount)) return this;

    const goldGained = resourceToGold(resource, amount);
    const resources = { ...this.resources };
    resources[resource] = resources[resource].sub(amount);
    resources.gold = resources.gold.add(goldGained);

    return this.withResources(resources);
  }

  buyResource(
    resource: TradeResourceKey,
    amount: ExpNumber,
    spread: number = DEFAULT_TRADE_SPREAD,
  ): CivilizationState {
    if (!isTradable(resource)) return this;

    const goldCost = goldToResource(resource, amount, spread);
    if (this.resources.gold.lt(goldCost)) return this;

    const resources = { ...this.resources };
    resources.gold = resources.gold.sub(goldCost);
    resources[resource] = resources[resource].add(amount);

    return this.withResources(resources);
  }

  /**
   * Convert trade power to gold for trading
   * Trade power can be used as currency, converting it to gold at 1:1 ratio
   */
  convertTradeToGold(amount: ExpNumber): CivilizationState {
    if (this.resources.trade.lt(amount)) return this;

    const resources = { ...this.resources };
    resources.trade = resources.trade.sub(amount);
    resources.gold = resources.gold.add(amount);

    return this.withResources(resources);
  }

  /**
   * Get the current trade production multiplier
   * Formula: 1 + log₁₀(trade + 1)
   */
  getTradeMultiplier(): ExpNumber {
    return calculateTradeMultiplier(this.resources.trade);
  }

  /**
   * Get the gold equivalent of wasted resources
   * Used for tracking total lost value over time
   */
  getWastedResourcesGoldEquivalent(): ExpNumber {
    let total = ExpNumber.ZERO;
    for (const [resource, amount] of Object.entries(this.resources)) {
      if (isTradable(resource as TradeResourceKey)) {
        total = total.add(resourceToGold(resource as TradeResourceKey, amount));
      }
    }
    return total;
  }
}
