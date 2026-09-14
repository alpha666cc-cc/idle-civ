import {
  computeResourceRate,
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
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

  constructor(
    resources: ResourceAmounts = emptyResourceAmounts(),
    workers: WorkerAssignments = emptyWorkerAssignments(),
    builtBuildings: string[] = [],
    resourceFactors: ResourceFactorMap = emptyResourceFactors(),
    buildingCostOverrides: BuildingCostOverrides = {},
    autoClicksPerSecond = 0,
  ) {
    this.resources = resources;
    this.workers = workers;
    this.builtBuildings = builtBuildings;
    this.resourceFactors = resourceFactors;
    this.buildingCostOverrides = buildingCostOverrides;
    this.autoClicksPerSecond = autoClicksPerSecond;

    const houses = this.buildingCount("house");
    const townHalls = this.buildingCount("town-hall");
    const peopleFloor = ExpNumber.fromNumber(houses * 10);
    this.resources.peopleCapacity = this.resources.peopleCapacity.gte(
      peopleFloor,
    )
      ? this.resources.peopleCapacity
      : peopleFloor;
    const houseFloor = ExpNumber.fromNumber(10 + townHalls * 10);
    this.resources.houseCapacity = this.resources.houseCapacity.gte(houseFloor)
      ? this.resources.houseCapacity
      : houseFloor;
    this.resources.population = ExpNumber.fromNumber(
      builtBuildings.filter((key) => key === "people").length,
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

  tick(): CivilizationState {
    const resources = { ...this.resources };
    for (const definition of resourceDefinitions) {
      resources[definition.key] = applyRate(
        resources[definition.key],
        this.computeResourceRate(definition.key),
      );
    }
    return this.withResources(resources);
  }

  getFactors(resourceKey: ResourceKey): ResourceFactors {
    const factors = this.resourceFactors[resourceKey];
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
      if (building.effects.resourceMultiplier?.resource === resourceKey) {
        buildingFactors.multiplicative.push([
          building.key,
          building.effects.resourceMultiplier.factor.pow(
            ExpNumber.fromNumber(count),
          ),
        ]);
      }
      if (building.effects.resourceDrain?.resource === resourceKey) {
        buildingFactors.drain.push([
          building.key,
          building.effects.resourceDrain.amount.mul(
            ExpNumber.fromNumber(count),
          ),
        ]);
      }
    }

    return {
      additional: [
        [workerProduction, workerProduction.workerProduction],
        ...(workerProduction.autoClickProduction.gt(ExpNumber.ZERO)
          ? [
              [
                "dev auto clicker",
                workerProduction.autoClickProduction,
              ] as ResourceFactor,
            ]
          : []),
        ...factors.additional,
        ...buildingFactors.additional,
      ],
      multiplicative: [
        ...factors.multiplicative,
        ...buildingFactors.multiplicative,
      ],
      drain: [...factors.drain, ...buildingFactors.drain],
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
    return this.resources[capacityKey(building.key)];
  }

  getBuildingCost(
    buildingKey: string,
    buildingsAlreadyBuilt: number,
    count: number = 1,
  ): BuildingCost[] {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return [];
    const costs = this.buildingCostOverrides[building.key] ?? building.costs;
    return costs.map((cost) => {
      let total: ExpNumber;
      if (cost.factor === 1) {
        // Linear case: each building costs exactly cost.base
        total = ExpNumber.from(cost.base)
          .ceil()
          .mul(ExpNumber.fromNumber(count));
      } else {
        // Geometric series: sum_{i=0}^{count-1} ceil(base * factor^(built+i))
        // For large counts the precise per-item ceil barely matters vs the formula
        // so we use the closed-form geometric sum for speed, then round up.
        const factor = ExpNumber.fromNumber(cost.factor);
        const firstTerm = ExpNumber.from(cost.base).mul(
          factor.pow(buildingsAlreadyBuilt),
        );
        // sum = firstTerm * (factor^count - 1) / (factor - 1)
        const geometricSum = firstTerm
          .mul(factor.pow(count).sub(ExpNumber.ONE))
          .div(ExpNumber.fromNumber(cost.factor - 1));
        total = geometricSum.ceil();
      }
      return { ...cost, base: total };
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

    // Upper bound: capacity-limited. Costs are exponential so realistically
    // nobody can afford millions; cap the search space.
    const upperBound = Math.min(
      maxPossible === Infinity ? 1_000_000 : maxPossible,
      1_000_000,
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
    const resources = {
      ...this.resources,
      [capacityKey(buildingKey)]: this.getBuildingMax(buildingKey).add(
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

  getBuildFailureReason(
    buildingKey: string,
    count: number = 1,
  ): "locked" | "capacity" | "resources" | null {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !building.available) return "locked";

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
    );
  }

  private withState(
    resources: ResourceAmounts,
    costOverrides: BuildingCostOverrides,
    builtBuildings = this.builtBuildings,
    autoClicksPerSecond = this.autoClicksPerSecond,
  ): CivilizationState {
    return new CivilizationState(
      resources,
      this.workers,
      builtBuildings,
      this.resourceFactors,
      costOverrides,
      autoClicksPerSecond,
    );
  }
}
