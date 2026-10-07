import {
  producerResourceKeys,
  type ProductionResourceKey,
  type ResourceKey,
} from "../src/game/attributes.js";
import {
  buildingDefinitions,
  type BuildingKey,
} from "../src/game/buildings.js";
import { CivilizationState } from "../src/game/civilizationState.js";
import { ExpNumber } from "../src/game/expNumber.js";
import type { SimulationAction } from "./simulation.js";

export type FundingCost = {
  resource: ResourceKey;
  base: ExpNumber;
};

export type WorkerFocus = {
  assignments: Partial<Record<ProductionResourceKey, number>>;
  seconds: number;
};

export type FundingRoute = {
  building: BuildingKey | null;
  focus: WorkerFocus | null;
  costs: FundingCost[];
  seconds: number;
};

const copyState = (
  state: CivilizationState,
  resources = { ...state.resources },
  workers = { ...state.workers },
  buildings = { ...state.builtBuildings },
): CivilizationState =>
  new CivilizationState(
    resources,
    workers,
    buildings,
    state.resourceFactors,
    state.buildingCostOverrides,
    state.autoClicksPerSecond,
    state.boughtUpgrades,
    state.defeatedEncounters,
    state.enteredAges,
    state.earnedAchievements,
    state.statistics,
    state.unitCounts,
    state.devProductionMultiplier,
    state.freeBuildings,
    state.freeUnits,
    state.freeUpgrades,
    state.boughtResearch,
    state.unitOrders,
    state.unitFormations,
    state.tradeRoutes,
  );

const withAllWorkersOn = (
  state: CivilizationState,
  resource: ProductionResourceKey,
): CivilizationState => {
  const workers = { ...state.workers };
  const totalWorkers = state.assignedWorkers + state.availableWorkers;
  for (const key of producerResourceKeys as ProductionResourceKey[]) {
    workers[key] =
      key === resource ? ExpNumber.fromNumber(totalWorkers) : ExpNumber.ZERO;
  }
  return copyState(state, { ...state.resources }, workers);
};

const withWorkerAllocation = (
  state: CivilizationState,
  assignments: Partial<Record<ProductionResourceKey, number>>,
): CivilizationState => {
  const workers = { ...state.workers };
  for (const key of producerResourceKeys as ProductionResourceKey[]) {
    workers[key] = ExpNumber.fromNumber(assignments[key] ?? 0);
  }
  return copyState(state, { ...state.resources }, workers);
};

const missingGatherableCosts = (
  state: CivilizationState,
  costs: readonly FundingCost[],
): FundingCost[] =>
  costs
    .filter(({ resource, base }) => state.resources[resource].lt(base))
    .filter(({ resource }) => state.isResourceGatherable(resource));

export const missingCostSeconds = (
  state: CivilizationState,
  costs: readonly FundingCost[],
): number => {
  let seconds = 0;
  let reserveSeconds = Infinity;
  for (const { resource, base } of costs) {
    const current = state.resources[resource];
    const rate = state.computeResourceRate(resource);
    if (current.lt(base)) {
      if (rate.lte(ExpNumber.ZERO)) return Infinity;
      const time = base.sub(current).div(rate).toNumber();
      if (!Number.isFinite(time)) return Infinity;
      seconds = Math.max(seconds, time);
    } else if (rate.lt(ExpNumber.ZERO)) {
      const time = current.sub(base).div(rate.abs()).toNumber();
      if (!Number.isFinite(time)) return Infinity;
      reserveSeconds = Math.min(reserveSeconds, time);
    }
  }
  return seconds <= reserveSeconds ? seconds : Infinity;
};

export const getFastestWorkerAllocation = (
  state: CivilizationState,
  costs: readonly FundingCost[],
): WorkerFocus | null => {
  const missing = missingGatherableCosts(state, costs);
  if (missing.length === 0) return null;
  const totalWorkers = Math.floor(
    state.assignedWorkers + state.availableWorkers,
  );
  if (totalWorkers <= 0) return null;

  const unassigned = withWorkerAllocation(state, {});
  const rates = [...new Set(costs.map(({ resource }) => resource))].map(
    (resource) => {
      const baseRate = unassigned.computeResourceRate(resource).toNumber();
      const yieldPerWorker = state.isResourceGatherable(resource)
        ? withAllWorkersOn(state, resource as ProductionResourceKey)
            .computeResourceRate(resource)
            .sub(unassigned.computeResourceRate(resource))
            .div(ExpNumber.fromNumber(totalWorkers))
            .toNumber()
        : 0;
      return {
        resource,
        current: state.resources[resource].toNumber(),
        target: costs
          .filter((cost) => cost.resource === resource)
          .reduce((sum, cost) => sum.add(cost.base), ExpNumber.ZERO)
          .toNumber(),
        baseRate,
        yieldPerWorker,
      };
    },
  );

  const allocationAt = (
    seconds: number,
  ): Partial<Record<ProductionResourceKey, number>> | null => {
    const assignments: Partial<Record<ProductionResourceKey, number>> = {};
    let requiredWorkers = 0;
    for (const rate of rates) {
      const requiredRate = (rate.target - rate.current) / seconds;
      const extraRate = requiredRate - rate.baseRate;
      if (extraRate <= 0) continue;
      if (rate.yieldPerWorker <= 0) return null;
      const workers = extraRate / rate.yieldPerWorker;
      assignments[rate.resource as ProductionResourceKey] = workers;
      requiredWorkers += workers;
      if (requiredWorkers > totalWorkers) return null;
    }
    return assignments;
  };

  let high = 1;
  while (high < 1e15 && allocationAt(high) === null) high *= 2;
  if (allocationAt(high) === null) return null;
  let low = 0;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const middle = (low + high) / 2;
    if (allocationAt(middle) === null) low = middle;
    else high = middle;
  }

  const raw = allocationAt(high);
  if (!raw) return null;
  const assignments: Partial<Record<ProductionResourceKey, number>> = {};
  let assigned = 0;
  for (const [resource, workers] of Object.entries(raw)) {
    const count = Math.floor(workers ?? 0);
    assignments[resource as ProductionResourceKey] = count;
    assigned += count;
  }
  const leftover = totalWorkers - assigned;
  const priority = rates
    .filter(({ yieldPerWorker }) => yieldPerWorker > 0)
    .sort((left, right) => {
      const leftNeed = (left.target - left.current) / left.yieldPerWorker;
      const rightNeed = (right.target - right.current) / right.yieldPerWorker;
      return rightNeed - leftNeed;
    });
  for (let index = 0; index < leftover && priority.length > 0; index += 1) {
    const resource = priority[index % priority.length].resource;
    const key = resource as ProductionResourceKey;
    assignments[key] = (assignments[key] ?? 0) + 1;
  }
  const roundedState = withWorkerAllocation(state, assignments);
  const projectedSeconds = missingCostSeconds(roundedState, costs);
  if (!Number.isFinite(projectedSeconds)) return null;
  return { assignments, seconds: projectedSeconds };
};

export const projectFunding = (
  state: CivilizationState,
  focus: WorkerFocus | null,
  seconds: number,
  costs: readonly FundingCost[],
): CivilizationState => {
  const focused = focus
    ? withWorkerAllocation(state, focus.assignments)
    : state;
  const resources = { ...state.resources };
  for (const resource of producerResourceKeys) {
    const rate = focused.computeResourceRate(resource);
    resources[resource] = ExpNumber.max(
      ExpNumber.ZERO,
      resources[resource].add(rate.mul(ExpNumber.fromNumber(seconds))),
    );
  }
  for (const { resource, base } of costs) {
    resources[resource] = resources[resource].sub(base);
  }
  return copyState(state, resources, focused.workers);
};

const hasMeaningfulRouteImprovement = (
  baselineSeconds: number,
  candidateSeconds: number,
  minimumDelta = 0,
): boolean => {
  if (!Number.isFinite(candidateSeconds)) return false;
  if (!Number.isFinite(baselineSeconds)) return true;
  return candidateSeconds + minimumDelta < baselineSeconds;
};

export const getFastestFundingRoute = (
  state: CivilizationState,
  costs: readonly FundingCost[],
): FundingRoute => {
  const directFocus = getFastestWorkerAllocation(state, costs);
  const directTime = missingCostSeconds(
    directFocus ? withWorkerAllocation(state, directFocus.assignments) : state,
    costs,
  );
  let bestRoute: FundingRoute = {
    building: null,
    focus: directFocus,
    costs: [...costs],
    seconds: directTime,
  };
  const missingResources = new Set(
    costs
      .filter(({ resource, base }) => state.resources[resource].lt(base))
      .map(({ resource }) => resource),
  );

  for (const building of buildingDefinitions) {
    if (
      !state.isBuildingAvailable(building.key) ||
      state.isBuildingAtCapacity(building.key)
    ) {
      continue;
    }
    const helpsTarget = [
      ...(building.effects.resourceProduction ?? []),
      ...(building.effects.additiveMultiplier ?? []),
    ].some(({ resource }) => missingResources.has(resource));
    if (!helpsTarget) continue;

    const buildingCosts = state
      .getBuildingCost(building.key, state.getBuildingCount(building.key), 1)
      .map(({ resource, base }) => ({ resource, base }));
    const canBuildNow = state.canBuild(building.key);
    const buildFocus = canBuildNow
      ? null
      : getFastestWorkerAllocation(state, buildingCosts);
    if (!canBuildNow && !buildFocus) continue;

    const buildTime = buildFocus?.seconds ?? 0;
    const fundedState = projectFunding(
      state,
      buildFocus,
      buildTime,
      buildingCosts,
    );
    const afterBuild = fundedState.build(building.key, 1);
    if (
      afterBuild.getBuildingCount(building.key) !==
      state.getBuildingCount(building.key) + 1
    ) {
      continue;
    }

    const targetFocus = getFastestWorkerAllocation(afterBuild, costs);
    const targetTime =
      targetFocus?.seconds ?? missingCostSeconds(afterBuild, costs);
    const totalTime = buildTime + targetTime + 1;
    if (
      hasMeaningfulRouteImprovement(bestRoute.seconds, totalTime) ||
      (!Number.isFinite(bestRoute.seconds) && Number.isFinite(totalTime))
    ) {
      bestRoute = {
        building: building.key,
        focus: buildFocus,
        costs: buildingCosts,
        seconds: totalTime,
      };
    }
  }
  return bestRoute;
};

export const getWorkerAssignmentAction = (
  state: CivilizationState,
  focus: WorkerFocus,
  deadband = 3,
): SimulationAction | null => {
  for (const key of producerResourceKeys as ProductionResourceKey[]) {
    const current = Math.floor(state.workers[key].toNumber());
    const target = focus.assignments[key] ?? 0;
    if (current - target >= deadband) {
      return {
        type: "unassignWorker",
        resource: key,
        count: current - target,
      };
    }
  }
  for (const key of producerResourceKeys as ProductionResourceKey[]) {
    const current = Math.floor(state.workers[key].toNumber());
    const target = focus.assignments[key] ?? 0;
    if (target - current >= deadband) {
      return {
        type: "assignWorker",
        resource: key,
        count: target - current,
      };
    }
  }
  return null;
};
