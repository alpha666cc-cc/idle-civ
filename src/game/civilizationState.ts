import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  baseResourceGenerator,
  computeResourceRate,
  resourceDefinitions,
  type ResourceAmounts,
  type ResourceFactor,
  type ResourceFactorMap,
  type ResourceFactors,
  type ResourceKey,
  type WorkerAssignments,
} from "./resources";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingKey,
} from "./buildings";

type BuildingLimitOverrides = Partial<Record<BuildingKey, number>>;
type BuildingCostOverrides = Partial<Record<BuildingKey, BuildingCost[]>>;

export class CivilizationState {
  readonly resources: ResourceAmounts;
  readonly workers: WorkerAssignments;
  readonly builtBuildings: string[];
  readonly resourceFactors: ResourceFactorMap;
  readonly buildingLimitOverrides: BuildingLimitOverrides;
  readonly buildingCostOverrides: BuildingCostOverrides;

  constructor(
    resources: ResourceAmounts = emptyResourceAmounts(),
    workers: WorkerAssignments = emptyWorkerAssignments(),
    builtBuildings: string[] = ["house", "farm"],
    resourceFactors: ResourceFactorMap = emptyResourceFactors(),
    buildingLimitOverrides: BuildingLimitOverrides = {},
    buildingCostOverrides: BuildingCostOverrides = {},
  ) {
    this.resources = resources;
    this.workers = workers;
    this.builtBuildings = builtBuildings;
    this.resourceFactors = resourceFactors;
    this.buildingLimitOverrides = buildingLimitOverrides;
    this.buildingCostOverrides = buildingCostOverrides;
  }

  get population(): number {
    return this.builtBuildings.filter((buildingKey) => buildingKey === "people")
      .length;
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

  gather(resourceKey: ResourceKey): CivilizationState {
    return this.withResources({
      ...this.resources,
      [resourceKey]: this.resources[resourceKey] + 1,
    });
  }

  assignWorker(resourceKey: ResourceKey): CivilizationState {
    if (this.availableWorkers <= 0) return this;
    return this.withWorkers({
      ...this.workers,
      [resourceKey]: this.workers[resourceKey] + 1,
    });
  }

  unassignWorker(resourceKey: ResourceKey): CivilizationState {
    if (this.workers[resourceKey] <= 0) return this;
    return this.withWorkers({
      ...this.workers,
      [resourceKey]: this.workers[resourceKey] - 1,
    });
  }

  tick(): CivilizationState {
    const resources = { ...this.resources };
    for (const definition of resourceDefinitions) {
      resources[definition.key] += this.computeResourceRate(definition.key);
    }
    return this.withResources(resources);
  }

  getFactors(resourceKey: ResourceKey): ResourceFactors {
    const factors = this.resourceFactors[resourceKey];
    const definition = resourceDefinitions.find(
      ({ key }) => key === resourceKey,
    );
    const workerFactor: ResourceFactor = [
      baseResourceGenerator,
      this.workers[resourceKey] * (definition?.productionPerWorker ?? 1),
    ];

    return {
      ...factors,
      additional: [workerFactor, ...factors.additional],
    };
  }

  computeResourceRate(resourceKey: ResourceKey): number {
    return computeResourceRate(this.getFactors(resourceKey));
  }

  getBuildingMax(buildingKey: string): number {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return 0;
    return this.buildingLimitOverrides[building.key] ?? building.maxCount;
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
    const nextLimit = this.getBuildingMax(buildingKey) + additionalSlots;
    return this.withBuildingUpgrades(
      {
        ...this.buildingLimitOverrides,
        [buildingKey]: nextLimit,
      },
      this.buildingCostOverrides,
    );
  }

  upgradeBuildingCosts(
    buildingKey: BuildingKey,
    costs: BuildingCost[],
  ): CivilizationState {
    return this.withBuildingUpgrades(this.buildingLimitOverrides, {
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
    const updatedFactors: ResourceFactorMap = {
      ...this.resourceFactors,
      [resourceKey]: {
        ...factors,
        [factorType]: [...factors[factorType], factor],
      },
    };
    return this.withResourceFactors(updatedFactors);
  }

  build(buildingKey: string): CivilizationState {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !building.available) {
      return this;
    }

    const builtCount = this.builtBuildings.filter(
      (key) => key === buildingKey,
    ).length;
    if (builtCount >= this.getBuildingMax(building.key)) return this;
    const cost = this.getBuildingCost(building.key, builtCount);
    if (cost.some(({ resource, base }) => this.resources[resource] < base)) {
      return this;
    }

    const resources = { ...this.resources };
    for (const { resource, base } of cost) {
      resources[resource] -= base;
    }
    return new CivilizationState(
      resources,
      this.workers,
      [...this.builtBuildings, buildingKey],
      this.resourceFactors,
      this.buildingLimitOverrides,
      this.buildingCostOverrides,
    );
  }

  canBuild(buildingKey: string): boolean {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !building.available) return false;
    const builtCount = this.builtBuildings.filter(
      (key) => key === buildingKey,
    ).length;
    if (builtCount >= this.getBuildingMax(building.key)) return false;
    return this.getBuildingCost(building.key, builtCount).every(
      ({ resource, base }) => this.resources[resource] >= base,
    );
  }

  private withResources(resources: ResourceAmounts): CivilizationState {
    return new CivilizationState(
      resources,
      this.workers,
      this.builtBuildings,
      this.resourceFactors,
      this.buildingLimitOverrides,
      this.buildingCostOverrides,
    );
  }

  private withWorkers(workers: WorkerAssignments): CivilizationState {
    return new CivilizationState(
      this.resources,
      workers,
      this.builtBuildings,
      this.resourceFactors,
      this.buildingLimitOverrides,
      this.buildingCostOverrides,
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
      this.buildingLimitOverrides,
      this.buildingCostOverrides,
    );
  }

  private withBuildingUpgrades(
    buildingLimitOverrides: BuildingLimitOverrides,
    buildingCostOverrides: BuildingCostOverrides,
  ): CivilizationState {
    return new CivilizationState(
      this.resources,
      this.workers,
      this.builtBuildings,
      this.resourceFactors,
      buildingLimitOverrides,
      buildingCostOverrides,
    );
  }
}
