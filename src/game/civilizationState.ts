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
type BuildingCapacities = Record<BuildingKey, number>;

const initialBuildingCapacities = (): BuildingCapacities => {
  const capacities = Object.fromEntries(
    buildingDefinitions.map((building) => [building.key, building.maxCount]),
  ) as BuildingCapacities;
  capacities.people = 0;
  return capacities;
};

export class CivilizationState {
  readonly resources: ResourceAmounts;
  readonly workers: WorkerAssignments;
  readonly builtBuildings: string[];
  readonly resourceFactors: ResourceFactorMap;
  readonly buildingLimitOverrides: BuildingLimitOverrides;
  readonly buildingCostOverrides: BuildingCostOverrides;
  readonly buildingCapacities: BuildingCapacities;

  constructor(
    resources: ResourceAmounts = emptyResourceAmounts(),
    workers: WorkerAssignments = emptyWorkerAssignments(),
    builtBuildings: string[] = [],
    resourceFactors: ResourceFactorMap = emptyResourceFactors(),
    buildingLimitOverrides: BuildingLimitOverrides = {},
    buildingCostOverrides: BuildingCostOverrides = {},
    buildingCapacities?: BuildingCapacities,
  ) {
    this.resources = resources;
    this.workers = workers;
    this.builtBuildings = builtBuildings;
    this.resourceFactors = resourceFactors;
    this.buildingLimitOverrides = buildingLimitOverrides;
    this.buildingCostOverrides = buildingCostOverrides;
    const capacities = buildingCapacities ?? initialBuildingCapacities();
    if (!buildingCapacities) {
      capacities.people +=
        builtBuildings.filter((key) => key === "house").length * 10;
      capacities.house +=
        builtBuildings.filter((key) => key === "town-hall").length * 10;
    }
    this.buildingCapacities = capacities;
  }

  get population(): number {
    return this.builtBuildings.filter((buildingKey) => buildingKey === "people")
      .length;
  }

  get maximumPopulation(): number {
    return this.buildingCapacities.people;
  }

  get housingCapacity(): number {
    return this.maximumPopulation;
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
    const amount = this.computeClickGain(resourceKey);
    return this.withResources({
      ...this.resources,
      [resourceKey]: this.resources[resourceKey] + amount,
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
      resources[definition.key] = Math.max(
        0,
        resources[definition.key] + this.computeResourceRate(definition.key),
      );
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

    const buildingFactors = buildingDefinitions.flatMap((building) => {
      const count = this.buildingCount(building.key);
      const factors: ResourceFactors = {
        additional: [],
        multiplicative: [],
        drain: [],
      };
      if (
        count > 0 &&
        building.effects.resourceMultiplier?.resource === resourceKey
      ) {
        factors.multiplicative.push([
          building.key,
          building.effects.resourceMultiplier.factor ** count,
        ]);
      }
      if (
        count > 0 &&
        building.effects.resourceDrain?.resource === resourceKey
      ) {
        factors.drain.push([
          building.key,
          building.effects.resourceDrain.amount * count,
        ]);
      }
      return factors;
    });

    return {
      ...factors,
      additional: [workerFactor, ...factors.additional],
      multiplicative: [
        ...factors.multiplicative,
        ...buildingFactors.flatMap(({ multiplicative }) => multiplicative),
      ],
      drain: [
        ...factors.drain,
        ...buildingFactors.flatMap(({ drain }) => drain),
      ],
    };
  }

  computeResourceRate(resourceKey: ResourceKey): number {
    return computeResourceRate(this.getFactors(resourceKey));
  }

  computeClickGain(resourceKey: ResourceKey): number {
    const factors = this.getFactors(resourceKey);
    return computeResourceRate({
      additional: [
        ["manual click", 1],
        ...factors.additional.filter(
          ([source]) => source !== baseResourceGenerator,
        ),
      ],
      multiplicative: factors.multiplicative,
      drain: [],
    });
  }

  private buildingCount(buildingKey: string): number {
    return this.builtBuildings.filter((key) => key === buildingKey).length;
  }

  getBuildingMax(buildingKey: string): number {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return 0;
    return this.buildingCapacities[building.key];
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
    const capacities = {
      ...this.buildingCapacities,
      [buildingKey]: this.getBuildingMax(buildingKey) + additionalSlots,
    };
    return this.withBuildingUpgrades(
      this.buildingLimitOverrides,
      this.buildingCostOverrides,
      capacities,
    );
  }

  upgradeBuildingCosts(
    buildingKey: BuildingKey,
    costs: BuildingCost[],
  ): CivilizationState {
    return this.withBuildingUpgrades(
      this.buildingLimitOverrides,
      {
        ...this.buildingCostOverrides,
        [buildingKey]: costs,
      },
      this.buildingCapacities,
    );
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
    if (buildingKey === "people" && this.population >= this.maximumPopulation) {
      return this;
    }
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
      this.capacitiesAfterBuilding(building.key),
    );
  }

  canBuild(buildingKey: string): boolean {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !building.available) return false;
    const builtCount = this.builtBuildings.filter(
      (key) => key === buildingKey,
    ).length;
    if (builtCount >= this.getBuildingMax(building.key)) return false;
    if (buildingKey === "people" && this.population >= this.maximumPopulation) {
      return false;
    }
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
      this.buildingCapacities,
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
      this.buildingCapacities,
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
      this.buildingCapacities,
    );
  }

  private withBuildingUpgrades(
    buildingLimitOverrides: BuildingLimitOverrides,
    buildingCostOverrides: BuildingCostOverrides,
    buildingCapacities: BuildingCapacities,
  ): CivilizationState {
    return new CivilizationState(
      this.resources,
      this.workers,
      this.builtBuildings,
      this.resourceFactors,
      buildingLimitOverrides,
      buildingCostOverrides,
      buildingCapacities,
    );
  }

  private capacitiesAfterBuilding(
    buildingKey: BuildingKey,
  ): BuildingCapacities {
    const capacities = { ...this.buildingCapacities };
    if (buildingKey === "house") capacities.people += 10;
    if (buildingKey === "town-hall") capacities.house += 10;
    return capacities;
  }
}
