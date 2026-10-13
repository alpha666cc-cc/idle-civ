/**
 * A parameterized `SimulationStrategy` for the age-1 time-minimization search
 * that `tools/simulation/age1-optimize.ts` drives.
 *
 * ## Why this file exists
 *
 * The shipped strategies in `strategies.ts` are hand-authored policies: fixed
 * worker ratios, fixed population route targets, a fixed research advisor order
 * and a fixed purchase ladder. That is exactly what makes them useful as a
 * balance baseline â€” and exactly what stops them from being the search space
 * for "how fast *can* age 1 be reached?". This module re-expresses the same
 * ladder with every discretionary constant exposed as a number, so a
 * derivative-free optimizer can move them.
 *
 * `BaseStrategy` is not exported, so this is a standalone `SimulationStrategy`
 * rather than a subclass. It reuses the *exported* helpers from `strategies.ts`
 * wherever one exists (`getRequiredBattleAction`,
 * `getRequiredBattlePreparationAction`, `getSimulatorBattlePlan`,
 * `getBootstrapGatherResource`, â€¦) so the campaign rules â€” which battle comes
 * next, which building the battle chain needs, whether an army already wins â€”
 * stay the engine's decision rather than a second implementation of it. Only
 * the *policy* (which growth step, which research, which ratio) is local, and
 * that is precisely the part being searched.
 *
 * The one piece that had to be re-implemented rather than reused is the age
 * route (`getAgeRouteGrowthAction` in `strategies.ts`), because its population
 * targets are the constant this file exists to vary. The logic is otherwise the
 * same ladder step: housing first, then citizens, then a farm when food is the
 * binding constraint.
 */
import { ExpNumber } from "../../src/game/expNumber.js";
import {
  buildingDefinitions,
  type BuildingKey,
} from "../../src/game/buildings.js";
import { encounterDefinitions } from "../../src/game/encounters.js";
import { researchDefinitions } from "../../src/game/research.js";
import {
  producerResourceKeys,
  type ProductionResourceKey,
  type ResourceKey,
} from "../../src/game/attributes.js";
import { CivilizationState } from "../../src/game/civilizationState.js";
import {
  isResourceGatherable,
  type SimulationAction,
  type SimulationContext,
  type SimulationStrategy,
} from "./simulation.js";
import {
  getBootstrapGatherResource,
  getRequiredBattleAction,
  getRequiredBattlePreparationAction,
  getRequiredBattlePreparationCosts,
  getSimulatorBattlePlan,
} from "./strategies.js";
import type { SimulatorResult } from "../../src/game/battleSimulator.js";
import { type FundingCost, type WorkerFocus } from "./workerFunding.js";

/**
 * Buildings the policy is allowed to prioritize, in the order `buildOrder`
 * indexes them. `people`, `house` and `townHall` are absent on purpose: the age
 * route owns the population ramp, so letting the building priority list compete
 * for citizens is what produced the historic stall where a full settlement grew
 * its economy instead of its population.
 */
export const policyBuildings: readonly BuildingKey[] = [
  "farm",
  "lumberYard",
  "quarry",
  "goldMine",
  "barracks",
  "university",
  "smithy",
  "market",
];

/**
 * The search vector. Every field is a number (or a permutation of numbers) so
 * the optimizer can sample it without knowing what it means; `defaultPolicy`
 * supplies the baseline values.
 */
export type PolicyParams = {
  /** Worker shares across the four gatherable resources; normalized on use. */
  workerFood: number;
  workerWood: number;
  workerStone: number;
  workerGold: number;
  /** Population ramp targets: before battle 1, before battle 2, before age entry. */
  popTargetFirst: number;
  popTargetSecond: number;
  popTargetLate: number;
  /** Permutation of indices into {@link policyBuildings} (0 = highest priority). */
  buildOrder: readonly number[];
  /** Research preference weights, one per destination family. */
  weightFood: number;
  weightWood: number;
  weightStone: number;
  weightGold: number;
  weightScience: number;
  weightCostCut: number;
  weightUnitUnlock: number;
  /** Extra army over the winning recipe before launching (0 = launch when it wins). */
  armyOvershoot: number;
  /** Whether to buy enhancer upgrades while they are affordable. */
  buyUpgrades: boolean;
  /** Population above which a food-blocked citizen purchase buys a farm first. */
  farmThreshold: number;
  /** 0 = gather the lowest-rate resource, 1 = gather the largest deficit. */
  gatherMode: number;
};

/**
 * Baseline values. Worker shares and the food-first build order mirror the
 * shipped `fast-age` strategy, which is the strongest age-1 baseline measured
 * (4020s at this objective), so CEM starts from a competitive point rather than
 * from a strawman it would spend its whole budget climbing out of.
 */
export const defaultPolicy = (): PolicyParams => ({
  workerFood: 0.6,
  workerWood: 0.2,
  workerStone: 0.1,
  workerGold: 0.1,
  popTargetFirst: 90,
  popTargetSecond: 200,
  popTargetLate: 1000,
  buildOrder: policyBuildings.map((_, index) => index),
  weightFood: 1,
  weightWood: 1,
  weightStone: 1,
  weightGold: 1,
  weightScience: 1,
  weightCostCut: 1,
  weightUnitUnlock: 1,
  armyOvershoot: 0,
  buyUpgrades: true,
  farmThreshold: 1,
  gatherMode: 0,
});
/** Parameter names, in a stable order, so the optimizer can zip vectors. */
export const policyParameterNames: readonly (keyof PolicyParams)[] = [
  "workerFood",
  "workerWood",
  "workerStone",
  "workerGold",
  "popTargetFirst",
  "popTargetSecond",
  "popTargetLate",
  "weightFood",
  "weightWood",
  "weightStone",
  "weightGold",
  "weightScience",
  "weightCostCut",
  "weightUnitUnlock",
  "armyOvershoot",
  "farmThreshold",
  "gatherMode",
];

/** Every searchable numeric parameter, i.e. `PolicyParams` minus the categorical two. */
export type NumericPolicyParam = Exclude<
  keyof PolicyParams,
  "buildOrder" | "buyUpgrades"
>;

/**
 * Bounds for each numeric parameter. The optimizer clamps every sample into
 * these, which is what keeps a population from discovering that "population 0"
 * or "workers all on gold" are degenerate policies that trivially reach no
 * objective at all.
 */
export const policyParameterBounds: Readonly<
  Record<NumericPolicyParam, readonly [number, number]>
> = {
  workerFood: [0.1, 0.8],
  workerWood: [0.05, 0.6],
  workerStone: [0, 0.5],
  workerGold: [0, 0.4],
  popTargetFirst: [40, 260],
  popTargetSecond: [90, 600],
  popTargetLate: [300, 2200],
  weightFood: [0, 4],
  weightWood: [0, 4],
  weightStone: [0, 4],
  weightGold: [0, 4],
  weightScience: [0, 6],
  weightCostCut: [0, 4],
  weightUnitUnlock: [0, 6],
  armyOvershoot: [0, 3],
  farmThreshold: [0, 400],
  gatherMode: [0, 1],
};

/** The number of buildable keys a `buildOrder` must name. */
export const policyBuildOrderLength = policyBuildings.length;

/** Re-normalize the worker shares so they sum to 1 without changing their ratios. */
const normalizedWorkerShares = (
  params: PolicyParams,
): Record<"food" | "wood" | "stone" | "gold", number> => {
  const raw = {
    food: Math.max(0.0001, params.workerFood),
    wood: Math.max(0.0001, params.workerWood),
    stone: Math.max(0.0001, params.workerStone),
    gold: Math.max(0.0001, params.workerGold),
  };
  const total = raw.food + raw.wood + raw.stone + raw.gold;
  return {
    food: raw.food / total,
    wood: raw.wood / total,
    stone: raw.stone / total,
    gold: raw.gold / total,
  };
};

/** Cost entries the settlement is short of, restricted to gatherable resources. */
const missingGatherableCosts = (
  state: CivilizationState,
  costs: readonly PendingCost[],
): PendingCost[] =>
  costs
    .filter(({ resource, base }) => state.resources[resource].lt(base))
    .filter(({ resource }) =>
      isResourceGatherable(state, resource as ResourceKey),
    );

/** The gatherable resource with the largest absolute deficit, or null. */
const largestDeficitResource = (
  state: CivilizationState,
  costs: readonly PendingCost[],
): string | null => {
  const missing = missingGatherableCosts(state, costs);
  if (missing.length === 0) return null;
  return missing.sort((left, right) => {
    const leftDeficit = left.base.sub(state.resources[left.resource]);
    const rightDeficit = right.base.sub(state.resources[right.resource]);
    if (leftDeficit.gt(rightDeficit)) return -1;
    if (rightDeficit.gt(leftDeficit)) return 1;
    return left.resource.localeCompare(right.resource);
  })[0].resource;
};
/** One cost entry in the shape the gather helpers read. */
type PendingCost = FundingCost;

/**
 * A battle plan's cost totals in the `PendingCost` shape the gather helpers
 * expect. `SimulatorCostTotal` carries no growth `factor`, which the gather
 * path never reads — it only compares amounts against balances.
 */
export const getSimulatorPlanCosts = (plan: SimulatorResult): PendingCost[] => {
  const totals = new Map<ResourceKey, ExpNumber>();
  for (const { resource, base } of [
    ...plan.totalCost,
    ...plan.research.costs,
  ]) {
    totals.set(resource, (totals.get(resource) ?? ExpNumber.ZERO).add(base));
  }
  return [...totals].map(([resource, base]) => ({ resource, base }));
};

type FundingRoute = {
  signature: string;
  updatedAt: number;
  building: BuildingKey | null;
  focus: WorkerFocus | null;
  costs: PendingCost[];
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

const missingCostSeconds = (
  state: CivilizationState,
  costs: readonly PendingCost[],
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
  costs: readonly PendingCost[],
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
  return { assignments, seconds: high };
};

const projectFunding = (
  state: CivilizationState,
  focus: WorkerFocus | null,
  seconds: number,
  costs: readonly PendingCost[],
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

const lowestRateResource = (state: CivilizationState): string => {
  const available = (producerResourceKeys as ProductionResourceKey[]).filter(
    (key) => isResourceGatherable(state, key as ResourceKey),
  );
  if (available.length === 0) return "food";
  let lowest = available[0];
  let lowestRate = state.computeResourceRate(lowest);
  for (const key of available) {
    const rate = state.computeResourceRate(key);
    if (rate.lt(lowestRate)) {
      lowestRate = rate;
      lowest = key;
    }
  }
  return lowest;
};

export const ageZeroBattlesWon = (state: CivilizationState): number =>
  state.defeatedEncounters.filter((id) =>
    encounterDefinitions.some(
      (battle) => battle.key === id && battle.age === 0,
    ),
  ).length;

export class AgeOnePolicy implements SimulationStrategy {
  readonly name: string;
  readonly description: string;
  private readonly params: PolicyParams;
  private fundingRoute: FundingRoute | null = null;

  constructor(params: PolicyParams, name = "age1-policy") {
    this.params = params;
    this.name = name;
    this.description = `Parameterized age-1 push (food ${params.workerFood.toFixed(2)}, pop ${params.popTargetFirst}/${params.popTargetSecond}/${params.popTargetLate})`;
  }

  getPolicy(): PolicyParams {
    return this.params;
  }

  private routeTargetPopulation(state: CivilizationState): number {
    if (state.enteredAges.includes("age0")) {
      return state.population.gt(
        ExpNumber.fromNumber(this.params.popTargetLate),
      )
        ? 0
        : this.params.popTargetLate;
    }
    if (state.enteredAges.length > 0) return 0;
    const battlesWon = ageZeroBattlesWon(state);
    if (battlesWon <= 0) return this.params.popTargetFirst;
    if (battlesWon <= 1) return this.params.popTargetSecond;
    return this.params.popTargetLate;
  }

  private shouldLaunchBattle(state: CivilizationState): boolean {
    const target = this.routeTargetPopulation(state);
    return target <= 0 || state.population.gte(ExpNumber.fromNumber(target));
  }

  private routeGrowthAction(state: CivilizationState): SimulationAction | null {
    if (!state.isBuildingAvailable("people")) return null;
    const atHousingCeiling = state.population.gte(
      state.maximumPopulation.floor(),
    );
    if (atHousingCeiling) {
      for (const housing of ["house", "townHall"] as const) {
        if (state.isBuildingAvailable(housing) && state.canBuild(housing)) {
          const count = state.getMaxAffordableBuildings(housing);
          if (count > 0) return { type: "build", building: housing, count };
        }
      }
    }

    const target = this.routeTargetPopulation(state);
    if (target <= 0) return null;
    if (state.population.gte(ExpNumber.fromNumber(target))) return null;
    if (state.canBuild("people")) {
      const count = state.getMaxAffordableBuildings("people");
      return count > 0 ? { type: "build", building: "people", count } : null;
    }

    if (atHousingCeiling) {
      const nextHousing =
        state.canBuild("house") || !state.canBuild("townHall")
          ? "house"
          : "townHall";
      if (state.isBuildingAvailable(nextHousing)) {
        const resource = largestDeficitResource(
          state,
          state.getBuildingCost(
            nextHousing,
            state.getBuildingCount(nextHousing),
            1,
          ),
        );
        if (resource) return { type: "gather", resource };
      }
      return null;
    }

    const citizenCost = state
      .getBuildingCost("people", state.getBuildingCount("people"), 1)
      .find(({ resource }) => resource === "food");
    if (citizenCost && state.resources.food.lt(citizenCost.base)) {
      const foodBlocked = state.population.gte(
        ExpNumber.fromNumber(this.params.farmThreshold),
      );
      if (
        foodBlocked &&
        state.isBuildingAvailable("farm") &&
        !state.isBuildingAtCapacity("farm") &&
        state.canBuild("farm")
      ) {
        const count = state.getMaxAffordableBuildings("farm");
        if (count > 0) return { type: "build", building: "farm", count };
      }
      return { type: "gather", resource: "food" };
    }
    return null;
  }
  /**
   * Research score: how much a tech is worth to this run, as the searched
   * weights applied to the destination families its bonuses name. Deliberately
   * data-driven — it reads the same bonus list the engine applies, so a tech
   * carrying `food x10` scores on the food weight without the policy knowing
   * what domestication is.
   */
  private researchScore(researchId: string): number {
    const research = researchDefinitions.find(({ key }) => key === researchId);
    if (!research) return 0;
    let score = 1;
    for (const bonus of research.bonuses) {
      const destination = String(bonus.destination);
      const value = bonus.value.toNumber();
      switch (bonus.type) {
        case "attributeMultiplier":
        case "attributeFlat":
          if (destination === "food") score += this.params.weightFood * value;
          else if (destination === "wood")
            score += this.params.weightWood * value;
          else if (destination === "stone")
            score += this.params.weightStone * value;
          else if (destination === "gold")
            score += this.params.weightGold * value;
          else if (destination === "science")
            score += this.params.weightScience * value;
          break;
        case "costReductionPercent":
        case "costReductionFactor":
        case "costReductionBase":
        case "costReductionFlat":
          score += this.params.weightCostCut * value;
          break;
        default:
          break;
      }
    }
    // A unit unlock is worth its weight even with no resource bonus attached:
    // it is the only thing that can unblock the next battle's army.
    score += research.unlocks.length * this.params.weightUnitUnlock;
    return score;
  }

  /**
   * The highest-scoring research that is unlocked. Only *unlocked* techs are
   * considered — the engine's `canBuyResearch` owns affordability, and waiting
   * for science is a gather decision, not a purchase decision.
   */
  private preferredUnlockedResearch(state: CivilizationState): string | null {
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const research of researchDefinitions) {
      if (state.isResearchBought(research.key)) continue;
      if (!state.isResearchUnlocked(research.key)) continue;
      // Divide by (1 + age) so a shallow unlock is preferred over a deep one;
      // inside an age the score is a plain weighted ranking.
      const score = this.researchScore(research.key) / (1 + research.age);
      if (score > bestScore) {
        bestScore = score;
        best = research.key;
      }
    }
    return best;
  }

  /**
   * Buy the preferred research if affordable. Deliberately returns nothing when
   * it is *not* affordable: gathering for science is nearly worthless (one click
   * yields `clickPower x 0.1` science, against a university that produces ~1/s),
   * so a gather here would consume the entire second — a `gather` ends the
   * simulated second — and starve the economy and the population ramp that
   * actually finance the tech. Waiting for science is handled by the fallback
   * gather at the bottom of the ladder instead, once nothing else is legal.
   */
  private researchAction(
    state: CivilizationState,
    plan: SimulatorResult | null,
  ): SimulationAction | null {
    // The battle plan comes first, before any weighted preference. The advisor
    // in `strategies.ts` does the same, and for a good reason: research bought
    // out of order still advances the age-0 price curve (200 x 12^(sqrt(n)-1)),
    // so a tech that does not unblock the next army makes every tech after it
    // strictly more expensive. Only once the plan's techs are bought does the
    // weighted preference decide what to spend science on next.
    const planResearch = plan?.research.ids.find(
      (researchId) =>
        !state.isResearchBought(researchId) &&
        state.isResearchUnlocked(researchId),
    );
    const researchId = planResearch ?? this.preferredUnlockedResearch(state);
    if (!researchId) return null;
    if (state.canBuyResearch(researchId)) {
      return { type: "buyResearch", researchId };
    }
    return null;
  }
  /**
   * Army steps for the battle the simulator says is next. Research that unlocks
   * the plan's units comes first (a recruit the engine will not sell is not a
   * recruit), then the recruits themselves, one action per unit type.
   */
  private battlePreparationPurchases(
    state: CivilizationState,
    plan: SimulatorResult | null,
  ): SimulationAction | null {
    if (!plan) return null;
    for (const researchId of plan.research.ids) {
      if (
        !state.isResearchBought(researchId) &&
        state.isResearchUnlocked(researchId) &&
        state.canBuyResearch(researchId)
      ) {
        return { type: "buyResearch", researchId };
      }
    }
    for (const [unitId, count] of plan.composition) {
      if (count <= 0 || !state.isUnitAvailable(unitId)) continue;
      const affordable = Math.min(count, state.getMaxAffordableUnits(unitId));
      if (affordable > 0) return { type: "buyUnit", unitId, count: affordable };
    }
    return null;
  }

  /**
   * Gather toward the army step the battle plan needs. Pricing is per single
   * unit, not the whole batch: the next unit's cost keeps the sort honest,
   * while a whole-army deficit would let one resource crowd out the real
   * bottleneck.
   */
  private battlePreparationGather(
    state: CivilizationState,
    plan: SimulatorResult | null,
  ): SimulationAction | null {
    if (!plan) return null;
    for (const [unitId, count] of plan.composition) {
      if (count <= 0 || !state.isUnitAvailable(unitId)) continue;
      const resource = largestDeficitResource(
        state,
        state.getUnitCost(unitId, 1),
      );
      if (resource) return { type: "gather", resource };
      return { type: "buyUnit", unitId, count: Math.min(count, 100) };
    }
    return null;
  }

  /**
   * Whether the army should wait for `armyOvershoot` copies of the plan's units
   * before attacking. Zero attacks the moment the army already wins, which is
   * the shipped behaviour; anything above zero buys margin at some cost.
   */
  private hasArmyOvershoot(
    state: CivilizationState,
    plan: SimulatorResult | null,
  ): boolean {
    const overshoot = this.params.armyOvershoot;
    if (overshoot <= 0 || !plan) return true;
    for (const [unitId, count] of plan.composition) {
      if (count <= 0) continue;
      const owned = state.getUnitCount(unitId).toNumber();
      if (owned < count * (1 + overshoot)) return false;
    }
    return true;
  }

  /** Cheapest affordable unit the settlement may buy (army growth, no battle due). */
  private cheapestLegalUnit(state: CivilizationState): SimulationAction | null {
    let best: SimulationAction | null = null;
    let bestCost: ExpNumber | null = null;
    for (const unit of state.getRosterUnits()) {
      const count = state.getMaxAffordableUnits(unit.key);
      if (count <= 0) continue;
      const cost = state
        .getUnitCost(unit.key, 1)
        .reduce((total, { base }) => total.add(base), ExpNumber.ZERO);
      if (bestCost === null || cost.lt(bestCost)) {
        bestCost = cost;
        best = {
          type: "buyUnit",
          unitId: unit.key,
          count: Math.min(count, 100),
        };
      }
    }
    return best;
  }
  /** First affordable purchase the settlement may legally make, cheapest first. */
  private cheapestLegalAction(
    state: CivilizationState,
  ): SimulationAction | null {
    const candidates: { action: SimulationAction; cost: ExpNumber }[] = [];
    for (const building of buildingDefinitions) {
      if (
        !state.isBuildingAvailable(building.key) ||
        state.isBuildingAtCapacity(building.key) ||
        !state.canBuild(building.key)
      ) {
        continue;
      }
      const count = state.getMaxAffordableBuildings(building.key);
      if (count <= 0) continue;
      const total = state
        .getBuildingCost(
          building.key,
          state.getBuildingCount(building.key),
          count,
        )
        .reduce((sum, { base }) => sum.add(base), ExpNumber.ZERO);
      candidates.push({
        action: { type: "build", building: building.key, count },
        cost: total.div(ExpNumber.fromNumber(count)),
      });
    }
    for (const unit of state.getRosterUnits()) {
      const count = state.getMaxAffordableUnits(unit.key);
      if (count <= 0) continue;
      candidates.push({
        action: {
          type: "buyUnit",
          unitId: unit.key,
          count: Math.min(count, 100),
        },
        cost: state
          .getUnitCost(unit.key, 1)
          .reduce((sum, { base }) => sum.add(base), ExpNumber.ZERO),
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) =>
      left.cost.lt(right.cost) ? -1 : right.cost.lt(left.cost) ? 1 : 0,
    );
    return candidates[0].action;
  }

  /** Build order, de-duplicated and padded, so a partial permutation is safe. */
  private buildPriority(): BuildingKey[] {
    const order = this.params.buildOrder ?? [];
    const seen = new Set<number>();
    const ordered: BuildingKey[] = [];
    for (const index of order) {
      const key = policyBuildings[index];
      if (!key || seen.has(index)) continue;
      seen.add(index);
      ordered.push(key);
    }
    for (const [index, key] of policyBuildings.entries()) {
      if (!seen.has(index)) ordered.push(key);
    }
    return ordered;
  }

  /**
   * Return the first blocked action in the policy ladder as a full cost vector.
   */
  protected nextFundingCosts(
    state: CivilizationState,
    plan: SimulatorResult | null,
  ): PendingCost[] | null {
    const preparation = getRequiredBattlePreparationAction(state);
    if (preparation?.type === "build") return [];
    if (preparation?.type === "gather") {
      return getRequiredBattlePreparationCosts(state).map(
        ({ resource, base }) => ({ resource, base }),
      );
    }

    const planResearch = plan?.research.ids.find(
      (researchId) =>
        !state.isResearchBought(researchId) &&
        state.isResearchUnlocked(researchId),
    );
    if (planResearch) {
      return state.canBuyResearch(planResearch)
        ? []
        : state.getResearchNextCost().map(({ resource, base }) => ({
            resource,
            base,
          }));
    }

    const researchId = this.preferredUnlockedResearch(state);
    if (researchId) {
      return state.canBuyResearch(researchId)
        ? []
        : state.getResearchNextCost().map(({ resource, base }) => ({
            resource,
            base,
          }));
    }

    const growth = this.routeGrowthAction(state);
    if (growth?.type === "build") return [];
    if (growth?.type === "gather") {
      const atHousingCeiling = state.population.gte(
        state.maximumPopulation.floor(),
      );
      const building = atHousingCeiling
        ? "house"
        : growth.resource === "food"
          ? "people"
          : null;
      if (building) {
        return state
          .getBuildingCost(building, state.getBuildingCount(building), 1)
          .map(({ resource, base }) => ({ resource, base }));
      }
    }

    if (plan && plan.composition.size > 0) {
      const hasAffordableUnit = [...plan.composition].some(
        ([unitId, count]) =>
          count > 0 &&
          state.isUnitAvailable(unitId) &&
          state.getMaxAffordableUnits(unitId) > 0,
      );
      if (hasAffordableUnit) return [];
      const nextUnit = [...plan.composition].find(
        ([unitId, count]) => count > 0 && state.isUnitAvailable(unitId),
      );
      const costs = nextUnit
        ? state
            .getUnitCost(nextUnit[0], 1)
            .map(({ resource, base }) => ({ resource, base }))
        : [];
      return missingGatherableCosts(state, costs).length > 0 ? costs : [];
    }

    for (const key of this.buildPriority()) {
      if (!state.isBuildingAvailable(key) || state.isBuildingAtCapacity(key)) {
        continue;
      }
      if (state.canBuild(key)) return [];
      return state
        .getBuildingCost(key, state.getBuildingCount(key), 1)
        .map(({ resource, base }) => ({ resource, base }));
    }
    return null;
  }

  private workerAssignmentAction(
    state: CivilizationState,
    focus: WorkerFocus,
  ): SimulationAction | null {
    const rebalanceDeadband = 3;
    for (const key of producerResourceKeys as ProductionResourceKey[]) {
      const current = Math.floor(state.workers[key].toNumber());
      const target = focus.assignments[key] ?? 0;
      if (current - target >= rebalanceDeadband) {
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
      if (target - current >= rebalanceDeadband) {
        return {
          type: "assignWorker",
          resource: key,
          count: target - current,
        };
      }
    }
    return null;
  }

  protected fundingAction(
    state: CivilizationState,
    costs: readonly PendingCost[],
    gameTime: number,
    signature: string,
  ): SimulationAction | null {
    if (
      !this.fundingRoute ||
      this.fundingRoute.signature !== signature ||
      gameTime - this.fundingRoute.updatedAt >= 30
    ) {
      const directFocus = getFastestWorkerAllocation(state, costs);
      const directTime = missingCostSeconds(
        directFocus
          ? withWorkerAllocation(state, directFocus.assignments)
          : state,
        costs,
      );
      let selectedBuilding: BuildingKey | null = null;
      let selectedBuildFocus: WorkerFocus | null = null;
      let selectedBuildCosts: PendingCost[] = [];
      let selectedBuildTime = Infinity;
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
          .getBuildingCost(
            building.key,
            state.getBuildingCount(building.key),
            1,
          )
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
        if (totalTime < selectedBuildTime) {
          selectedBuilding = building.key;
          selectedBuildFocus = buildFocus;
          selectedBuildCosts = buildingCosts;
          selectedBuildTime = totalTime;
        }
      }

      const useBuildRoute =
        selectedBuilding !== null && selectedBuildTime < directTime;
      this.fundingRoute = {
        signature,
        updatedAt: gameTime,
        building: useBuildRoute ? selectedBuilding : null,
        focus: useBuildRoute ? selectedBuildFocus : directFocus,
        costs: useBuildRoute ? selectedBuildCosts : [...costs],
      };
    }

    const route = this.fundingRoute;
    if (route.building && state.canBuild(route.building)) {
      return { type: "build", building: route.building, count: 1 };
    }
    if (route.focus) {
      const reassignment = this.workerAssignmentAction(state, route.focus);
      if (reassignment) return reassignment;
    }
    const resource = largestDeficitResource(state, route.costs);
    return resource ? { type: "gather", resource } : null;
  }

  /** Put every worker on the projected fastest route to the current step. */
  private workerAction(
    state: CivilizationState,
    plan: SimulatorResult | null,
    gameTime: number,
  ): SimulationAction | null {
    const fundingCosts = this.nextFundingCosts(state, plan);
    if (fundingCosts?.length === 0) return null;
    if (fundingCosts) {
      const signature = JSON.stringify({
        costs: fundingCosts.map(({ resource, base }) => [
          resource,
          base.toString(),
        ]),
        buildings: state.builtBuildings,
        units: Object.fromEntries(
          Object.entries(state.unitCounts).map(([id, count]) => [
            id,
            count.toString(),
          ]),
        ),
        research: state.boughtResearch,
        battles: state.defeatedEncounters,
        enteredAges: state.enteredAges,
        workforce: state.assignedWorkers + state.availableWorkers,
      });
      const action = this.fundingAction(
        state,
        fundingCosts,
        gameTime,
        signature,
      );
      if (action) return action;
      return null;
    }

    const shares = normalizedWorkerShares(this.params);
    const total = state.assignedWorkers + state.availableWorkers;
    if (total <= 0) return null;

    const keys = ["food", "wood", "stone", "gold"] as const;
    const targets = keys.map((key) => Math.floor(shares[key] * total));
    targets[0] += total - targets.reduce((sum, value) => sum + value, 0);

    let best: SimulationAction | null = null;
    let bestGap = 3;
    keys.forEach((key, index) => {
      const gap = targets[index] - Math.round(state.workers[key].toNumber());
      if (Math.abs(gap) < bestGap) return;
      bestGap = Math.abs(gap);
      best =
        gap > 0
          ? { type: "assignWorker", resource: key, count: gap }
          : { type: "unassignWorker", resource: key, count: Math.abs(gap) };
    });
    return best;
  }

  /** Buy an affordable enhancer upgrade when the policy allows it. */
  private upgradeAction(state: CivilizationState): SimulationAction | null {
    if (!this.params.buyUpgrades) return null;
    const affordable = state.getAffordableUpgrades();
    if (affordable.length === 0) return null;
    return { type: "buyUpgrade", upgradeId: affordable[0] };
  }

  /** Last-resort gather: deficit-driven or lowest-rate, per the search knob. */
  private fallbackGather(
    state: CivilizationState,
    pendingCosts: readonly PendingCost[],
  ): SimulationAction | null {
    if (this.params.gatherMode >= 0.5 && pendingCosts.length > 0) {
      const resource = largestDeficitResource(state, pendingCosts);
      if (resource) return { type: "gather", resource };
    }
    const bootstrap = getBootstrapGatherResource(state);
    if (bootstrap) return { type: "gather", resource: bootstrap };
    return { type: "gather", resource: lowestRateResource(state) };
  }
  /**
   * The ladder. Same ordering the shipped base strategy uses — campaign gates
   * first (they are the only steps that are actually *required*), then research,
   * then growth, then the army, then the economy, then gathering — with every
   * discretionary choice inside it parameterized.
   */
  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    // Gate 1: entering the age is the objective itself.
    const currentAge = state.getCurrentAge();
    if (currentAge && state.canEnterAge(currentAge.key)) {
      return { type: "enterAge", ageId: currentAge.key };
    }

    // Gate 2: the campaign's next battle, once the route says we may and the
    // engine says we already win it.
    const battle = state.getNextBattle();
    const plan = getSimulatorBattlePlan(state);
    if (battle && this.shouldLaunchBattle(state)) {
      const ready = getRequiredBattleAction(state);
      if (ready && this.hasArmyOvershoot(state, plan)) return ready;
    }

    // Gate 3: workers. Population is the age-0 bottleneck — every gate below it
    // spends resources that workers produce — so the worker split is settled
    // before any purchase competes for the action slots. Reassigning is free
    // (one action slot, no resources), so doing it early costs nothing.
    const worker = this.workerAction(state, plan, context.gameTime);
    if (worker) return worker;

    // Gate 4: the building the battle chain needs (barracks / university /
    // smithy), building it or gathering for it.
    const infrastructure = getRequiredBattlePreparationAction(state);
    if (infrastructure) return infrastructure;

    // Gate 4: the army itself, plus the research that unlocks it. Purchases
    // only — the army's *gathering* belongs at the bottom of the ladder, for
    // the same reason as research: a gather consumes the whole second.
    const armyPurchase = this.battlePreparationPurchases(state, plan);
    if (armyPurchase) return armyPurchase;

    // Gate 5: research by weight — purchases only (see `researchAction`).
    const research = this.researchAction(state, plan);
    if (research) return research;

    // Gate 6: population ramp.
    const growth = this.routeGrowthAction(state);
    if (growth) return growth;

    // Gate 7: army growth when no battle is pending.
    if (!battle) {
      const unit = this.cheapestLegalUnit(state);
      if (unit) return unit;
    }

    // Gate 8: upgrades.
    const upgrade = this.upgradeAction(state);
    if (upgrade) return upgrade;

    // Gate 10: the economy, in the searched build order.
    for (const key of this.buildPriority()) {
      if (
        state.isBuildingAvailable(key) &&
        !state.isBuildingAtCapacity(key) &&
        state.canBuild(key)
      ) {
        const count = state.getMaxAffordableBuildings(key);
        if (count > 0) return { type: "build", building: key, count };
      }
    }

    // Gate 11: the cheapest legal purchase, so the ladder cannot stall on a
    // priority item while something affordable and useful goes unpurchased.
    const cheapest = this.cheapestLegalAction(state);
    if (cheapest) return cheapest;

    // Gate 12: food safety. A citizen eats 1 food/second and the next citizen
    // costs more than the first, so a one-citizen settlement can sit at a small
    // food balance it can never spend.
    const citizenCost = state
      .getBuildingCost("people", state.getBuildingCount("people"), 1)
      .find(({ resource }) => resource === "food");
    if (
      state.isBuildingAvailable("people") &&
      citizenCost &&
      state.resources.food.lt(citizenCost.base)
    ) {
      return { type: "gather", resource: "food" };
    }

    // Gate 13: gather toward the next army step, then the generic fallback.
    const armyGather = this.battlePreparationGather(state, plan);
    if (armyGather) return armyGather;
    void context;
    return this.fallbackGather(
      state,
      plan && plan.composition.size > 0 ? getSimulatorPlanCosts(plan) : [],
    );
  }
}

/** A printable form of a parameter vector, for the optimizer's report. */
export const describePolicy = (params: PolicyParams): string => {
  const lines = [`{ type: "age1-policy", params: {`];
  for (const key of policyParameterNames) {
    lines.push(`  ${key}: ${params[key]},`);
  }
  lines.push(
    `  buildOrder: [${params.buildOrder.join(", ")}],`,
    `  buyUpgrades: ${params.buyUpgrades},`,
    `} }`,
  );
  return lines.join("\n");
};
