import {
  computeResourceRate,
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  producerResourceKeys,
  resourceDefinitions,
  type CapacityResourceKey,
  type ProductionResourceKey,
  type ResourceAmounts,
  type ResourceFactor,
  type ResourceFactorMap,
  type ResourceFactors,
  type ResourceKey,
  type WorkerAssignments,
} from "./resources";
import { ExpNumber } from "./expNumber";
import { WorkerProduction } from "./workerProduction";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingKey,
} from "./buildings";
import { encounterDefinitions } from "./encounters";
import { upgradeDefinitions } from "./upgrades";
import { collectCostReductions, type Bonus } from "./bonus";

type BuildingCostOverrides = Partial<Record<BuildingKey, BuildingCost[]>>;

const capacityKey = (buildingKey: BuildingKey): CapacityResourceKey =>
  `${buildingKey}Capacity` as CapacityResourceKey;

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
    const definition = resourceDefinitions.find(
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
    return this.withResources({
      ...this.resources,
      [resourceKey]: this.resources[resourceKey].add(amount),
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
    return this.withResources(resources);
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
      const { resourceMultiplier, resourceDrain, resourceProduction } =
        building.effects;
      if (resourceMultiplier?.resource === resourceKey) {
        buildingFactors.multiplicative.push([
          building.key,
          resourceMultiplier.factor.pow(ExpNumber.fromNumber(count)),
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
          resourceProduction.amount.mul(ExpNumber.fromNumber(count)),
        ]);
      }
    }

    const upgradeFactors: ResourceFactors = {
      additional: [],
      multiplicative: [],
      drain: [],
    };
    for (const [upgradeId, bonus] of this.boughtUpgradeBonuses()) {
      if (
        bonus.type === "resourceMultiplier" &&
        bonus.destination === resourceKey
      ) {
        upgradeFactors.multiplicative.push([upgradeId, bonus.value]);
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
        ...upgradeFactors.additional,
      ],
      multiplicative: [
        ...factors.multiplicative,
        ...buildingFactors.multiplicative,
        ...upgradeFactors.multiplicative,
      ],
      drain: [
        ...factors.drain,
        ...buildingFactors.drain,
        ...upgradeFactors.drain,
      ],
    };
  }

  computeResourceRate(resourceKey: ResourceKey): ExpNumber {
    return computeResourceRate(this.getFactors(resourceKey));
  }

  computeClickGain(resourceKey: ResourceKey): ExpNumber {
    const factors = this.getFactors(resourceKey);
    const definition = resourceDefinitions.find(
      ({ key }) => key === resourceKey,
    );
    return computeResourceRate({
      additional: [
        [
          "manual click",
          ExpNumber.fromNumber(definition?.productionPerWorker ?? 1),
        ],
      ],
      multiplicative: factors.multiplicative,
      drain: [],
    });
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
    // Effective capacity: the stored base amount times every bought capacity
    // multiplier (§13.7 decision 3 — capacity keeps its own representation).
    let max = this.resources[capacity];
    for (const [, bonus] of this.boughtUpgradeBonuses()) {
      if (
        bonus.type === "resourceMultiplier" &&
        bonus.destination === capacity
      ) {
        max = max.mul(bonus.value);
      }
    }
    for (const [, bonus] of this.defeatedEncounterBonuses()) {
      if (
        bonus.type === "resourceMultiplier" &&
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
      this.boughtUpgradeBonuses()
        .filter(([, bonus]) => bonus.destination === building.key)
        .map(([, bonus]) => bonus),
    );
    return costs.map((cost) => {
      // Per-unit cost-reduction pipeline (§13.1): base → factor → percent → flat.
      // Costs clamp at 0; the growth factor clamps at 1 (below 1, later buildings
      // would cost less than earlier ones).
      const unitBase = ExpNumber.max(
        ExpNumber.ZERO,
        ExpNumber.from(cost.base).sub(reductions.base),
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

    return this.withState(resources, this.buildingCostOverrides, newBuildings);
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

  defeatEncounter(encounterId: string): CivilizationState {
    if (this.defeatedEncounters.includes(encounterId)) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      [...this.defeatedEncounters, encounterId],
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
    );
  }
}
