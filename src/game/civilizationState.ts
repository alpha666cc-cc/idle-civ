import {
  computeResourceRate,
  derivedAttributeDefinitions,
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  findAttributeDefinition,
  productionDefinitions,
  producerResourceKeys,
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
import { ExpNumber } from "./expNumber";
import { WorkerProduction } from "./workerProduction";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingKey,
} from "./buildings";
import {
  achievementDefinitions,
  findAchievementDefinition,
  materializeOpenEndedTier,
  nextHoarderExponent,
  openEndedHoarderChains,
  type AchievementRequirement,
} from "./achievements";
import { encounterDefinitions } from "./encounters";
import {
  emptyStatistics,
  tickMilliseconds,
  type Statistics,
} from "./statistics";
import { upgradeDefinitions } from "./upgrades";
import { collectCostReductions, type Bonus } from "./bonus";

type BuildingCostOverrides = Partial<Record<BuildingKey, BuildingCost[]>>;

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
  "buildingPower",
  ...buildingDefinitions.map(({ key }) => `${key}Power`),
]) {
  derivedAttributeComputations[key] = {
    value: (state) => compoundStatValue(state, key),
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
  readonly builtBuildings: string[];
  readonly resourceFactors: ResourceFactorMap;
  readonly buildingCostOverrides: BuildingCostOverrides;
  readonly autoClicksPerSecond: number;
  readonly boughtUpgrades: readonly string[];
  readonly defeatedEncounters: readonly string[];
  readonly enteredAges: readonly string[];
  readonly earnedAchievements: readonly string[];
  readonly statistics: Statistics;

  constructor(
    resources: ResourceAmounts = emptyResourceAmounts(),
    workers: WorkerAssignments = emptyWorkerAssignments(),
    builtBuildings: string[] = ["town-hall"],
    resourceFactors: ResourceFactorMap = emptyResourceFactors(),
    buildingCostOverrides: BuildingCostOverrides = {},
    autoClicksPerSecond = 0,
    boughtUpgrades: readonly string[] = [],
    defeatedEncounters: readonly string[] = [],
    enteredAges: readonly string[] = [],
    earnedAchievements: readonly string[] = [],
    statistics: Statistics = emptyStatistics(),
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
    this.statistics = statistics;

    const houses = this.buildingCount("house");
    const townHalls = this.buildingCount("town-hall");
    const peopleFloor = ExpNumber.fromNumber(houses * 10);
    this.resources.peopleCapacity = this.resources.peopleCapacity.gte(
      peopleFloor,
    )
      ? this.resources.peopleCapacity
      : peopleFloor;
    const houseFloor = ExpNumber.fromNumber(townHalls * 10);
    this.resources.houseCapacity = this.resources.houseCapacity.gte(houseFloor)
      ? this.resources.houseCapacity
      : houseFloor;
    this.resources.population = ExpNumber.fromNumber(
      this.buildingCount("people"),
    );
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
      (total, count) => total + count.toNumber(),
      0,
    );
  }

  get availableWorkers(): number {
    return Math.floor(this.population.toNumber()) - this.assignedWorkers;
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
    if (!(resourceKey in this.resources)) return this;
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
    const actualCount = Math.min(count, this.availableWorkers);
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
    const actualCount = Math.min(count, this.workers[resourceKey].toNumber());
    if (actualCount <= 0) return this;
    return this.withWorkers({
      ...this.workers,
      [resourceKey]: this.workers[resourceKey].sub(
        ExpNumber.fromNumber(actualCount),
      ),
    });
  }

  /**
   * Assign up to `count` idle workers.
   * Food workers are maintained at roughly 10 times each other resource,
   * starting with food, while equalizing the other resources among themselves.
   */
  autoAssignWorkers(count = 10): CivilizationState {
    const others = (
      Object.keys(this.workers) as ProductionResourceKey[]
    ).filter((key) => key !== "food");
    let workers = { ...this.workers };
    let available = this.availableWorkers;
    let remaining = count;

    while (available > 0 && remaining > 0) {
      if (others.length === 0) {
        workers.food = workers.food.add(ExpNumber.ONE);
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
    if (!this.hasResourcesForUpgrade(upgradeId)) return "resources";
    return null;
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
    for (const { resource, base } of upgrade.costs) {
      resources[resource] = resources[resource].sub(base);
    }
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      [...this.boughtUpgrades, upgradeId],
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
    const statistics: Statistics = {
      ...this.statistics,
      playTimeMs: this.statistics.playTimeMs + tickMilliseconds,
      runTimeMs: this.statistics.runTimeMs + tickMilliseconds,
    };
    // Achievements are evaluated after the tick's changes so the check always runs
    // after a domain event has landed (roadmap Milestone 6).
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
    ).checkAchievements();
  }

  getFactors(resourceKey: ResourceKey): ResourceFactors {
    const factors = this.resourceFactors[resourceKey];
    // `workers` only ever holds the four production keys, so membership is the
    // honest "is this a production resource?" test (AGENTS.md §9 guard).
    const isProductionKey = resourceKey in this.workers;
    const workerProduction = this.getWorkerProduction(
      resourceKey as ProductionResourceKey,
    );
    const buildingFactors: ResourceFactors = {
      additional: [],
      multiplicative: [],
      drain: [],
    };

    for (const building of buildingDefinitions) {
      const count = this.buildingCount(building.key);
      if (count === 0) continue;
      const power = this.buildingPower(building.key);
      const { resourceMultiplier, resourceDrain, resourceProduction } =
        building.effects;
      if (resourceMultiplier?.resource === resourceKey) {
        // Building power scales each effect's magnitude (§13.2): multiplier
        // effects scale their excess over 1 (×1.1 at power 2 → ×1.2), flats
        // scale in full. Drains and build-time capacity grants do not scale.
        const effectiveFactor = ExpNumber.ONE.add(
          resourceMultiplier.factor.sub(ExpNumber.ONE).mul(power),
        );
        buildingFactors.multiplicative.push([
          building.key,
          effectiveFactor.pow(ExpNumber.fromNumber(count)),
        ]);
      }
      if (resourceDrain?.resource === resourceKey) {
        buildingFactors.drain.push([
          building.key,
          resourceDrain.amount.mul(ExpNumber.fromNumber(count)),
        ]);
      }
      if (resourceProduction?.resource === resourceKey) {
        buildingFactors.additional.push([
          building.key,
          resourceProduction.amount
            .mul(power)
            .mul(ExpNumber.fromNumber(count)),
        ]);
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
      if (String(bonus.destination) !== resourceKey) continue;
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

  computeResourceRate(resourceKey: ResourceKey): ExpNumber {
    return computeResourceRate(this.getFactors(resourceKey));
  }

  computeClickGain(resourceKey: ResourceKey): ExpNumber {
    const factors = this.getFactors(resourceKey);
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
   * The effective power of one building: its own power attribute — which
   * already folds in the global building-power layer — defaulting to 1 for any
   * key without a power attribute.
   */
  private buildingPower(buildingKey: BuildingKey): ExpNumber {
    const value = this.getAttributeValue(`${buildingKey}Power`);
    return value.gt(ExpNumber.ZERO) ? value : ExpNumber.ONE;
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
    // Building powers fold in the global layer so the displayed value is the
    // effective one; the row links the global stat's Gamepedia page (§13.2).
    const isBuildingPower = buildingDefinitions.some(
      ({ key: buildingKey }) => `${buildingKey}Power` === key,
    );
    if (isBuildingPower) {
      factors.multiplicative.push([
        "buildingPower",
        this.getAttributeValue("buildingPower"),
      ]);
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
    // Effective capacity: the stored base amount times every capacity multiplier in
    // force, from any bonus source (§13.7 decision 3 — capacity keeps its own
    // representation).
    let max = this.resources[capacity];
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

  getBuildingCost(
    buildingKey: string,
    buildingsAlreadyBuilt: number,
    count: number = 1,
  ): BuildingCost[] {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return [];
    const costs = this.buildingCostOverrides[building.key] ?? building.costs;
    const reductions = collectCostReductions(
      this.activeBonuses()
        .filter(([, bonus]) => bonus.destination === building.key)
        .map(([, bonus]) => bonus),
    );
    return costs.map((cost) => {
      // Per-unit cost-reduction pipeline (§13.1): base → factor → percent → flat.
      // Costs clamp at 0; the growth factor clamps at 1 (below 1, later buildings
      // would cost less than earlier ones).
      const unitBase = ExpNumber.max(
        ExpNumber.ZERO,
        ExpNumber.from(cost.base).mul(reductions.base),
      );
      const unitFactor = ExpNumber.max(
        ExpNumber.ONE,
        ExpNumber.fromNumber(cost.factor).sub(reductions.factor),
      );
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

    // O(1) check: can we afford exactly n more buildings from currentCount onward?
    // Uses geometric series formula for the cumulative cost of n buildings.
    const canAffordCount = (n: number): boolean =>
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
        return this.enteredAges.includes(unlock.ageId);
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
    const cost = this.getBuildingCost(buildingKey, builtCount, count);

    const resources = { ...this.resources };
    for (const { resource, base } of cost) {
      resources[resource] = resources[resource].sub(base);
    }

    if (buildingKey === "people") {
      resources.population = resources.population.add(
        ExpNumber.fromNumber(count),
      );
    }
    if (buildingKey === "house") {
      resources.peopleCapacity = resources.peopleCapacity.add(
        ExpNumber.fromNumber(10 * count),
      );
    }
    if (buildingKey === "town-hall") {
      resources.houseCapacity = resources.houseCapacity.add(
        ExpNumber.fromNumber(10 * count),
      );
    }

    const newBuildings = [...this.builtBuildings];
    for (let i = 0; i < count; i++) {
      newBuildings.push(buildingKey);
    }

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
    return this.builtBuildings.filter((key) => key === buildingKey).length;
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
   */
  private earnedAchievementBonuses(): [achievementId: string, bonus: Bonus][] {
    return this.earnedAchievements.flatMap((achievementId) =>
      (findAchievementDefinition(achievementId)?.bonuses ?? []).map(
        (bonus) =>
          [achievementId, bonus] as [achievementId: string, bonus: Bonus],
      ),
    );
  }

  /**
   * Every bonus currently in force, paired with its source id. One seam for all
   * bonus sources keeps capacities, costs and stats on the same application path.
   */
  private activeBonuses(): [sourceId: string, bonus: Bonus][] {
    return [
      ...this.boughtUpgradeBonuses(),
      ...this.defeatedEncounterBonuses(),
      ...this.earnedAchievementBonuses(),
    ];
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
    return this.earnedAchievements.includes(achievementId);
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

  /** Play time (ms) of the fastest recorded run that entered this age, if any. */
  getFastestAgeTime(ageId: string): number | undefined {
    return this.statistics.fastestAgeMs[ageId];
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
    const concrete = achievementDefinitions
      .filter(({ family: achievementFamily }) => achievementFamily === family)
      .sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
    const nextTier = concrete.find(
      ({ key }) => !this.earnedAchievements.includes(key),
    );
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
      const endExponent = chain.startExponent + Math.floor(
        (heldExponent - chain.startExponent) / chain.exponentStep,
      ) * chain.exponentStep;
      if (!Number.isSafeInteger(endExponent) || exponent > endExponent) continue;
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
    const newlyEarned = [
      ...achievementDefinitions
        .filter(
          ({ key, requirement }) =>
            !this.earnedAchievements.includes(key) &&
            this.meetsRequirement(requirement),
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
    );
  }

  enterAge(ageId: string): CivilizationState {
    if (this.enteredAges.includes(ageId)) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      [...this.enteredAges, ageId],
      this.earnedAchievements,
      {
        ...this.statistics,
        fastestAgeMs: this.recordFastest(this.statistics.fastestAgeMs, ageId),
      },
    );
  }
}
