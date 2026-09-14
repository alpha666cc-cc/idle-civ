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
import { WorkerProduction } from "./workerProduction";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingKey,
} from "./buildings";

type BuildingCostOverrides = Partial<Record<BuildingKey, BuildingCost[]>>;

const capacityKey = (buildingKey: BuildingKey): CapacityResourceKey =>
  `${buildingKey}Capacity` as CapacityResourceKey;

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
    this.resources.peopleCapacity = Math.max(
      this.resources.peopleCapacity,
      houses * 10,
    );
    this.resources.houseCapacity = Math.max(
      this.resources.houseCapacity,
      10 + townHalls * 10,
    );
    this.resources.population = builtBuildings.filter(
      (key) => key === "people",
    ).length;
  }

  get population(): number {
    return this.resources.population;
  }

  get maximumPopulation(): number {
    return this.resources.peopleCapacity;
  }

  get housingCapacity(): number {
    return this.resources.peopleCapacity;
  }

  get assignedWorkers(): number {
    return Object.values(this.workers).reduce(
      (total, count) => total + count,
      0,
    );
  }

  get availableWorkers(): number {
    return this.population - this.assignedWorkers;
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
      [resourceKey]: this.resources[resourceKey] + amount,
    });
  }

  assignWorker(resourceKey: ProductionResourceKey): CivilizationState {
    if (!(resourceKey in this.workers) || this.availableWorkers <= 0)
      return this;
    return this.withWorkers({
      ...this.workers,
      [resourceKey]: this.workers[resourceKey] + 1,
    });
  }

  unassignWorker(resourceKey: ProductionResourceKey): CivilizationState {
    if (!(resourceKey in this.workers) || this.workers[resourceKey] <= 0)
      return this;
    return this.withWorkers({
      ...this.workers,
      [resourceKey]: this.workers[resourceKey] - 1,
    });
  }

  /** Assign up to `count` idle workers to food first, then split the rest across the other production resources. */
  autoAssignWorkers(count = 10): CivilizationState {
    const others = (
      Object.keys(this.workers) as ProductionResourceKey[]
    ).filter((key) => key !== "food");
    let workers = this.workers;
    let available = this.availableWorkers;
    let remaining = count;
    while (available > 0 && remaining > 0) {
      workers = { ...workers, food: workers.food + 1 };
      available -= 1;
      remaining -= 1;
      for (const key of others) {
        if (available <= 0 || remaining <= 0) break;
        workers = { ...workers, [key]: workers[key] + 1 };
        available -= 1;
        remaining -= 1;
      }
    }
    return this.availableWorkers === available
      ? this
      : this.withWorkers(workers);
  }

  /** Buy every building that is currently affordable and under its cap, one pass in definition order. */
  autoBuyBuildings(): CivilizationState {
    return buildingDefinitions.reduce<CivilizationState>(
      (state, building) => {
        const next = state.build(building.key);
        return next === state ? state : next;
      },
      this,
    );
  }

  tick(): CivilizationState {
    const resources = { ...this.resources };
    for (const definition of resourceDefinitions) {
      resources[definition.key] = Math.max(
        0,
        resources[definition.key] + this.computeResourceRate(definition.key),
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
          building.effects.resourceMultiplier.factor ** count,
        ]);
      }
      if (building.effects.resourceDrain?.resource === resourceKey) {
        buildingFactors.drain.push([
          building.key,
          building.effects.resourceDrain.amount * count,
        ]);
      }
    }

    return {
      additional: [
        [workerProduction, workerProduction.workerProduction],
        ...(workerProduction.autoClickProduction > 0
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

  computeResourceRate(resourceKey: ResourceKey): number {
    return computeResourceRate(this.getFactors(resourceKey));
  }

  computeClickGain(resourceKey: ResourceKey): number {
    const factors = this.getFactors(resourceKey);
    const definition = resourceDefinitions.find(
      ({ key }) => key === resourceKey,
    );
    return computeResourceRate({
      additional: [["manual click", definition?.productionPerWorker ?? 1]],
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

  getBuildingMax(buildingKey: string): number {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return 0;
    return this.resources[capacityKey(building.key)];
  }

  getBuildingCost(
    buildingKey: string,
    buildingsAlreadyBuilt: number,
  ): BuildingCost[] {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return [];
    const costs = this.buildingCostOverrides[building.key] ?? building.costs;
    return costs.map((cost) => ({
      ...cost,
      base: Math.ceil(cost.base * cost.factor ** buildingsAlreadyBuilt),
    }));
  }

  formatBuildingCost(
    buildingKey: string,
    buildingsAlreadyBuilt: number,
  ): string {
    return this.getBuildingCost(buildingKey, buildingsAlreadyBuilt)
      .map(({ resource, base }) => `${base} ${resource}`)
      .join(" + ");
  }

  upgradeBuildingLimit(
    buildingKey: BuildingKey,
    additionalSlots: number,
  ): CivilizationState {
    const resources = {
      ...this.resources,
      [capacityKey(buildingKey)]:
        this.getBuildingMax(buildingKey) + additionalSlots,
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

  build(buildingKey: string): CivilizationState {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !building.available) return this;
    const builtCount = this.buildingCount(building.key);
    if (builtCount >= this.getBuildingMax(building.key)) return this;
    if (buildingKey === "people" && this.population >= this.maximumPopulation)
      return this;
    const cost = this.getBuildingCost(building.key, builtCount);
    if (cost.some(({ resource, base }) => this.resources[resource] < base))
      return this;

    const resources = { ...this.resources };
    for (const { resource, base } of cost) resources[resource] -= base;
    resources.population += buildingKey === "people" ? 1 : 0;
    if (buildingKey === "house") resources.peopleCapacity += 10;
    if (buildingKey === "town-hall") resources.houseCapacity += 10;
    return this.withState(resources, this.buildingCostOverrides, [
      ...this.builtBuildings,
      buildingKey,
    ]);
  }

  canBuild(buildingKey: string): boolean {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !building.available) return false;
    const count = this.buildingCount(building.key);
    if (count >= this.getBuildingMax(building.key)) return false;
    if (buildingKey === "people" && this.population >= this.maximumPopulation)
      return false;
    return this.getBuildingCost(building.key, count).every(
      ({ resource, base }) => this.resources[resource] >= base,
    );
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
