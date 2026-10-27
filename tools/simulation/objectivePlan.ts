/**
 * The age-0 objective plan and the cost model that funds it.
 *
 * ## Why this exists
 *
 * Three separate places in `strategies.ts` already encode the age-0 chain by
 * hand: `ageZeroRouteTargets` (the population checkpoints),
 * `getRequiredBattlePreparationCosts` (the buildings a battle needs) and
 * `getSimulatorBattlePlan` (the army and research it needs). This module makes
 * the chain *the data* — one ordered list per age where each entry states when
 * it is done and what it still costs. `ObjectiveStrategy` in `strategies.ts`
 * funds whatever is first and unfinished.
 *
 * ## Costs include the helper buildings
 *
 * A cost vector that priced only its headline purchase would be wrong, and the
 * difference is the difference between reaching 200 citizens and stalling at
 * 110. A citizen needs a house (`peopleCapacity`), a house needs a town hall
 * (`houseCapacity`), and the town hall is where the stone and gold go.
 * `growthCosts()` sizes the whole remaining requirement from each building's
 * `capacityProvided`, so a capacity bonus moves the plan without this file
 * changing.
 *
 * That vector is what the worker split is solved from, and per
 * `docs/age1-optimization.md` §7 worker allocation is worth roughly 20x any
 * amount of purchase reordering — so the cost model, not the ordering, is the
 * part of this design that can move a number.
 *
 * ## The module cycle, deliberately
 *
 * `strategies.ts` imports this file to build the plan, and this file imports the
 * campaign helpers back out of it. That is safe only because **neither module
 * touches the other during evaluation**: everything below is a closure invoked
 * from a strategy decision, and `strategies.ts` reads `age0Objectives` from a
 * method body. Do not add a top-level call across that seam — it becomes a
 * temporal-dead-zone crash that shows up only in the entry order where this file
 * happens to load first.
 */
import { ExpNumber } from "../../src/game/expNumber.js";
import type { CivilizationState } from "../../src/game/civilizationState.js";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingKey,
} from "../../src/game/buildings.js";
import type { ResourceKey } from "../../src/game/attributes.js";
import type { FundingCost } from "./workerFunding.js";
import {
  createInitialState,
  GameSimulation,
  type SimulationAction,
} from "./simulation.js";
import {
  getRecommendedBattlePurchase,
  getSimulatorBattlePlan,
  getStrategy,
} from "./strategies.js";

/**
 * One step of an age's campaign.
 *
 * `done` must stay engine-exact: `population`, `defeatedEncounters`,
 * `getAgeBuildingProgress` and `getCurrentAge` are the rules, and re-deriving a
 * stricter variant of any of them is how a strategy ends up unable to leave an
 * age the engine is happy to let it leave.
 */
export type Objective = {
  readonly id: string;
  readonly label: string;
  /** Engine-exact. This never re-implements a game rule. */
  done: (state: CivilizationState) => boolean;
  /** What is still missing, helper buildings included. Empty when nothing to fund. */
  costs: (state: CivilizationState) => FundingCost[];
  /** The purchase that advances it, when one is affordable right now. */
  purchase: (state: CivilizationState) => SimulationAction | null;
};

/** Whole number of people, the engine's derivation rather than a stored count. */
const populationOf = (state: CivilizationState): number =>
  state.population.floor().toNumber();

/** Current people capacity — the house cap the settlement is actually held to. */
const peopleCapacityOf = (state: CivilizationState): number =>
  state.resources.peopleCapacity.floor().toNumber();

/** `capacityProvided` by one building toward another, e.g. a house's people slots. */
const capacityPer = (source: BuildingKey, forBuilding: BuildingKey): number => {
  const entry = (
    buildingDefinitions.find(({ key }) => key === source)?.effects
      .capacityProvided ?? []
  ).find((provided) => provided.building === forBuilding);
  return entry ? entry.perBuilding.toNumber() : 0;
};

/**
 * The building to buy toward `target` citizens: a citizen while there is room,
 * otherwise the house — or the town hall — that makes room.
 *
 * Housing is checked ahead of the target because a settlement sitting at its cap
 * cannot build citizens at all, whatever the target says, and the house that
 * lifts the cap is exactly the purchase the route exists to make. That is the
 * trap `getAgeRouteGrowthAction` had to be fixed for, and a cost-driven plan
 * would otherwise walk straight back into it.
 */
const growthBuilding = (
  state: CivilizationState,
  target: number,
): BuildingKey | null => {
  const owned = populationOf(state);
  if (owned >= target) return null;
  if (state.maximumPopulation.floor().toNumber() - owned >= 1) return "people";
  if (
    state.isBuildingAvailable("house") &&
    !state.isBuildingAtCapacity("house")
  ) {
    return "house";
  }
  if (
    state.isBuildingAvailable("townHall") &&
    !state.isBuildingAtCapacity("townHall")
  ) {
    return "townHall";
  }
  return "house";
};

/**
 * The production buildings an objective's cost vector can be sped up with:
 * one per gatherable, matched through each definition's `additiveMultiplier`
 * target rather than a hardcoded resource name.
 */
const helperBuildings = [
  "farm",
  "lumberYard",
  "quarry",
  "goldMine",
] as const satisfies readonly BuildingKey[];

// const foodResearchKeys = new Set<string>([
//   "wheel_axle",
//   "agriculture",
//   "irrigation",
// ]);

/**
 * Buy a production building whose resource the current objective is short of.
 *
 * This is the "helper buildings" half of the cost model. It sits *below* the
 * worker split rather than inside it, and deliberately so: `getFastestFundingRoute`
 * answers "should I build a farm before saving for food?" by returning the
 * *farm's* cost vector as the thing to fund, and since a farm always shortens a
 * food deficit it picks one essentially always. Fed back as the worker target
 * that pins the whole settlement on food and wood, and stone and gold never get
 * a worker — which is how a settlement deadlocks at its housing cap with no way
 * to afford the town hall that lifts it. The split stays aimed at the
 * objective; this rung only ever spends surplus on capacity the objective needs
 * anyway, and is bounded by that building's own capacity.
 */
export const helperBuildingAction = (
  state: CivilizationState,
  costs: readonly FundingCost[],
): SimulationAction | null => {
  const short = new Set(
    costs
      .filter(({ resource, base }) => state.resources[resource].lt(base))
      .map(({ resource }) => resource),
  );
  if (short.size === 0) return null;

  for (const building of helperBuildings) {
    const target = buildingDefinitions.find(({ key }) => key === building)
      ?.effects.additiveMultiplier?.[0]?.resource;
    if (!target || !short.has(target)) continue;
    if (
      !state.isBuildingAvailable(building) ||
      state.isBuildingAtCapacity(building) ||
      !state.canBuild(building)
    ) {
      continue;
    }
    const count = state.getMaxAffordableBuildings(building);
    if (count > 0) return { type: "build", building, count };
  }
  return null;
};

/**
 * The whole remaining cost of reaching `target` citizens: the citizens
 * themselves, the houses that hold them, and the town halls that hold the
 * houses.
 *
 * The house and town-hall terms are what make this a funding target rather than
 * a shopping list. Priced on citizens alone the vector is food-only, every
 * worker goes to food, and wood/stone/gold never arrive — so the settlement
 * stops at the first capacity cap with thousands of surplus food and no way to
 * spend it.
 */
export const growthCosts = (
  state: CivilizationState,
  target: number,
  researchCosts: readonly FundingCost[] = [],
): FundingCost[] => {
  if (state.freeBuildings) return [];
  const missing = target - populationOf(state);
  if (missing <= 0) return [];

  const costs: FundingCost[] = [];
  const add = (list: readonly BuildingCost[]) => {
    for (const { resource, base } of list) costs.push({ resource, base });
  };

  // Citizens themselves: the thing we are trying to reach.
  add(
    state.getBuildingCost("people", state.getBuildingCount("people"), missing),
  );

  const peoplePerHouse = capacityPer("house", "people");
  if (peoplePerHouse <= 0) return costs;

  const houses = state.getBuildingCount("house");
  // Bonus-aware capacities, not the stored base: a battle victory or enhancer
  // multiplies a capacity resource, and `getBuildingMax()` is where the engine
  // applies that. Reading `resources.*Capacity` here misses First Fire's
  // `townHallCapacity ×2`, so the plan prices zero town halls, funds food only,
  // and the settlement freezes at its cap waiting for a hall it was never told
  // to save for. `getBuildingMax()` is the same authority `canBuild()` uses.
  const houseRoom = Math.max(
    0,
    state.getBuildingMax("house").floor().toNumber() - houses,
  );
  const hallsPer = capacityPer("townHall", "house");
  if (hallsPer <= 0) return costs;

  const townHallCapacity = state.getBuildingMax("townHall").floor().toNumber();
  const townHalls = state.getBuildingCount("townHall");
  const activeGap = Math.max(
    0,
    target - state.maximumPopulation.floor().toNumber(),
  );
  const housesToReachCap = Math.ceil(activeGap / peoplePerHouse);
  // The town hall is what lifts the *house* cap. A hall adds `hallsPer` house
  // slots, so halls lift the house ceiling in `hallsPer`-house rungs. Price the
  // halls the target's houses actually need beyond the house slots the
  // settlement can already reach (`houseRoom`), capped at the halls the engine
  // will let us buy (`townHallCapacity`), and raised to at least one whenever a
  // hall is needed at all: with zero halls in the vector the worker split never
  // funds the stone/gold that lifts the cap, so the settlement walks to
  // `peopleCapacity` and freezes there forever waiting for a hall that was never
  // priced. Pricing the hall before the houses it unlocks keeps the vector
  // honest — the next rung is always a hall first, then the houses it opens.
  const houseRoomInHouses = Math.floor(houseRoom / hallsPer);
  const housesBeyondHalls = Math.max(0, housesToReachCap - houseRoomInHouses);
  const hallsNeeded = Math.ceil(housesBeyondHalls / hallsPer);
  const hallsPriced = Math.min(
    Math.max(1, hallsNeeded),
    Math.max(0, townHallCapacity - townHalls),
  );
  if (hallsPriced > 0) {
    add(state.getBuildingCost("townHall", townHalls, hallsPriced));
  }

  // Houses come after the halls they depend on. Only the houses that fit inside
  // the hall-boosted house ceiling are priced, so the vector never carries a
  // wood bill the engine would refuse — that would mislead the worker split.
  const houseCeiling = houseRoom + hallsPriced * hallsPer;
  const housesPriced = Math.min(housesToReachCap, houseCeiling);
  if (housesPriced > 0) {
    add(state.getBuildingCost("house", houses, housesPriced));
  }

  // Research costs ride along in the same vector, so the worker solver can fund\
  // food-multipliers (like irrigation ×100 food) in parallel with buildings

  // instead of rejecting them as a separate priority that the current split

  // cannot reach.
  for (const researchCost of researchCosts) {
    const spend = state.resources[researchCost.resource].gt(researchCost.base)
      ? researchCost.base
      : state.resources[researchCost.resource];
    if (spend.gt(ExpNumber.ZERO)) {
      costs.push({ ...researchCost, base: spend });
    }
  }

  return costs;
};

/** How many citizens it would take to close the age's remaining building shortfall. */
const citizenTargetForBuildings = (state: CivilizationState): number => {
  const [have, needed] = state.getAgeBuildingProgress();
  return populationOf(state) + Math.max(0, needed - have);
};

/** The progression building the current battle is still waiting on. */
const requiredPreparationBuilding = (
  state: CivilizationState,
): BuildingKey | null => {
  for (const building of ["barracks", "university", "smithy"] as const) {
    if (
      state.getBuildingCount(building) === 0 &&
      state.isBuildingAvailable(building)
    ) {
      return building;
    }
  }
  return null;
};

const buyIfAffordable = (
  state: CivilizationState,
  building: BuildingKey | null,
): SimulationAction | null => {
  if (!building || !state.canBuild(building)) return null;
  const count = state.getMaxAffordableBuildings(building);
  return count > 0 ? { type: "build", building, count } : null;
};

const populationObjective = (
  id: string,
  label: string,
  target: number,
): Objective => ({
  id,
  label,
  done: (state) => state.population.gte(ExpNumber.fromNumber(target)),
  // Price only the *next* citizen plus the housing it needs, then re-solve after
  // each purchase. The whole-90 vector asks the worker solver to reach a food
  // rate near ~380/s from a rate that is negative while citizens outpace the
  // farms; that split is infeasible, `focus` comes back null, no worker is ever
  // assigned, and the settlement freezes at the first cap. A one-citizen step is
  // always reachable, so the split fires immediately and the walk parallelises
  // food against housing instead of serially saving food first.
  costs: (state) => {
    const owned = populationOf(state);
    const capacity = peopleCapacityOf(state);
    // Fund only the next citizen plus the housing that makes room for it, then
    // re-solve after each purchase. The whole-90 vector asks the worker solver
    // to reach a food rate near ~380/s from a rate that is *negative* while
    // citizens outpace the farms; that split is infeasible, `focus` comes back
    // null, no worker is ever assigned, and the settlement starves at the first
    // cap. A one-rung step is always reachable, so the split fires at once and
    // the walk parallelises food against housing instead of serially saving
    // food first. Pricing to the *current* capacity alone is not enough — at the
    // cap that vector is food-only and the wood for the next house never
    // arrives — so reach at least one housing rung (`peoplePerHouse`) past it.
    const peoplePerHouse = capacityPer("house", "people");
    const nextRung =
      peoplePerHouse > 0 ? capacity + peoplePerHouse : capacity + 1;
    const stepTarget = Math.min(target, Math.max(nextRung, owned + 1));
    return growthCosts(state, stepTarget);
  },
  purchase: (state) => buyIfAffordable(state, growthBuilding(state, target)),
});

/**
 * A battle's funding target: the progression building while it is missing, then
 * the army the simulator says wins it plus the research that unlocks that army.
 * The research rides along through the plan's `research.costs`, so an army that
 * needs slingers funds agriculture -> pottery -> sling_throwing instead of
 * stalling on a unit the engine will not sell yet.
 */
const battleObjective = (
  id: string,
  label: string,
  encounterId: string,
): Objective => ({
  id,
  label,
  done: (state) => state.defeatedEncounters.includes(encounterId),
  costs: (state) => {
    const preparation = requiredPreparationBuilding(state);
    if (preparation) {
      return state
        .getBuildingCost(preparation, state.getBuildingCount(preparation), 1)
        .map(({ resource, base }) => ({ resource, base }));
    }
    const plan = getSimulatorBattlePlan(state);
    if (!plan) return [];
    const totals = new Map<ResourceKey, ExpNumber>();
    for (const { resource, base } of [
      ...plan.totalCost,
      ...plan.research.costs,
    ]) {
      totals.set(resource, (totals.get(resource) ?? ExpNumber.ZERO).add(base));
    }
    return [...totals].map(([resource, base]) => ({ resource, base }));
  },
  purchase: (state) =>
    buyIfAffordable(state, requiredPreparationBuilding(state)) ??
    getRecommendedBattlePurchase(state, getSimulatorBattlePlan(state)),
});

/** Leaving the age: `canEnterAge` is the whole rule, so there is nothing to fund. */
const enterAgeObjective: Objective = {
  id: "enter-age0",
  label: "Enter the Iron Age",
  done: (state) => state.getCurrentAge()?.key !== "age0",
  costs: () => [],
  purchase: () => null,
};

/**
 * The age's completion building count.
 *
 * A citizen is both a population and the cheapest building in the game (10 food
 * at factor 2.5), so the shortfall prices as more citizens plus the housing they
 * need — which is what makes this objective nearly free once the population
 * ramp has already run to 1000.
 */
const buildingsObjective: Objective = {
  id: "buildings",
  label: "Complete the age's building target",
  done: (state) => {
    const [have, needed] = state.getAgeBuildingProgress();
    return have >= needed;
  },
  costs: (state) => growthCosts(state, citizenTargetForBuildings(state)),
  purchase: (state) =>
    buyIfAffordable(
      state,
      growthBuilding(state, citizenTargetForBuildings(state)),
    ),
};

/**
 * The age-0 production bootstrap: the first farm and lumber yard.
 *
 * Without these the settlement has no passive income, so once citizens outpace
 * the (zero) farms every gatherable rate goes net-negative, `yieldPerWorker`
 * is zero, and the worker solver returns `null` — every worker stays idle and
 * the whole economy is the single manual gather. Worse, the walk deadlocks: a
 * farm costs food *and* wood, but a food-bleeding settlement only ever gathers
 * food (food is the only deficit it ever sees), so the wood the farm needs
 * never arrives and the farm never gets built. This objective funds the pair up
 * front — before the population walk adds drains it cannot yet feed — so wood
 * enters the short set, passive income engages, and the solver wakes up.
 *
 * It is done once each production pair has at least one member; growth past
 * that is the helper-building rung's job, bounded by each building's capacity.
 */
const productionBootstrapObjective: Objective = {
  id: "bootstrap-production",
  label: "Raise a farm and a lumber yard",
  done: (state) =>
    helperBuildings
      .slice(0, 2)
      .every(
        (building) =>
          state.getBuildingCount(building) > 0 ||
          !state.isBuildingAvailable(building),
      ),
  costs: (state) => {
    const costs: FundingCost[] = [];
    for (const building of helperBuildings.slice(0, 2)) {
      if (
        state.getBuildingCount(building) > 0 ||
        !state.isBuildingAvailable(building) ||
        state.isBuildingAtCapacity(building)
      ) {
        continue;
      }
      for (const { resource, base } of state.getBuildingCost(
        building,
        state.getBuildingCount(building),
        1,
      )) {
        costs.push({ resource, base });
      }
    }
    return costs;
  },
  purchase: (state) => {
    for (const building of helperBuildings.slice(0, 2)) {
      if (state.getBuildingCount(building) > 0) continue;
      const action = buyIfAffordable(state, building);
      if (action) return action;
    }
    return null;
  },
};

/**
 * The age-0 campaign, in the order the engine actually offers it.
 *
 * The population checkpoints mirror `ageZeroRouteTargets`, which the benchmark
 * suite locks: 90 to unlock the barracks, 200 after the first victory, then
 * 1000 — so the 1000 gate sits before the Bronze Raid rather than just before
 * Troy. Moving it is a one-row edit here, and worth benchmarking if it is tried.
 */
export const age0Objectives: readonly Objective[] = [
  productionBootstrapObjective,
  populationObjective("pop90", "Grow to 90 citizens", 90),
  battleObjective("first-fire", "Win First Fire", "age0_1_first_fire"),
  populationObjective("pop200", "Grow to 200 citizens", 200),
  battleObjective("wolf-pack", "Drive off the Wolf Pack", "age0_2_wolf_pack"),
  populationObjective("pop1000", "Grow to 1000 citizens", 1000),
  battleObjective("bronze-raid", "Break the Bronze Raid", "age0_3_bronze_raid"),
  battleObjective("troy", "Take Troy", "age0_boss_troy"),
  buildingsObjective,
  enterAgeObjective,
];

/** The first objective the settlement has not finished yet. */
export const currentObjective = (
  state: CivilizationState,
): Objective | undefined =>
  age0Objectives.find((objective) => !objective.done(state));

/**
 * The default ceiling for `advanceToward`, in simulated seconds. Generous on
 * purpose: a stalled rung returns `reached: false` with its final state rather
 * than hanging, but this is a safety net, not a pacing gate — the caller decides
 * what "too slow" means (balance is still moving, so no hard budget here).
 */
const DEFAULT_OBJECTIVE_BUDGET_SECONDS = 20_000;

export interface AdvanceTowardOptions {
  /** Where to start. Omit to begin a fresh civilization (runs the prologue). */
  from?: CivilizationState;
  /** Run the from-scratch bootstrap prologue. Defaults to `from === undefined`. */
  fromScratch?: boolean;
  /** Safety ceiling in simulated seconds (default 20_000). */
  maxGameTime?: number;
  gatherClicksPerAction?: number;
  actionsPerSecond?: number;
}

export interface AdvanceTowardResult {
  state: CivilizationState;
  gameTime: number;
  /** Whether the named objective's own `done()` holds on the final state. */
  reached: boolean;
}

/**
 * Play the objective plan up to *and including* a named rung, driven relative to
 * whatever state you hand it, and stop the instant that rung's `done()` flips.
 *
 * This is the per-objective driver: each rung of `age0Objectives` becomes a real,
 * individually-callable function without freezing the engine beneath it. It never
 * re-derives a rule — it runs `ObjectiveStrategy`, which asks the engine for every
 * number at call time (`getBuildingMax`, `canEnterAge`, costs, …). So improving
 * the engine flows straight through; only the policy constants already living in
 * `age0Objectives` (`target: 90`, `encounterId`, the order) are pinned, and those
 * are explicit one-row data, not engine rules.
 *
 * Drive the chain live by feeding one rung's output into the next:
 * `advanceToward("wolf-pack", { from: advanceToward("pop200").state })`. No
 * fixtures, no snapshots — always the current engine.
 *
 * @throws if `objectiveId` is not a rung of the age-0 plan.
 */
export const advanceToward = (
  objectiveId: string,
  options: AdvanceTowardOptions = {},
): AdvanceTowardResult => {
  const objective = age0Objectives.find((entry) => entry.id === objectiveId);
  if (!objective) {
    throw new Error(`unknown objective: ${objectiveId}`);
  }

  const { from, fromScratch = from === undefined } = options;
  const result = new GameSimulation(
    from ?? createInitialState(),
    getStrategy("objective")!,
    {
      // The configured objective is only the safety ceiling; `stopWhen` is the real
      // stop, and it reads the rung's engine-exact `done()` — so the halt condition
      // can never drift from the rule the engine actually enforces.
      objective: {
        type: "timeLimit",
        seconds: options.maxGameTime ?? DEFAULT_OBJECTIVE_BUDGET_SECONDS,
      },
      stopWhen: (state) => objective.done(state),
      gatherClicksPerAction: options.gatherClicksPerAction ?? 10,
      actionsPerSecond: options.actionsPerSecond ?? 5,
      maxGameTime: options.maxGameTime ?? DEFAULT_OBJECTIVE_BUDGET_SECONDS,
      fromScratch,
      recordSnapshots: false,
    },
  ).run();

  return {
    state: result.finalState,
    gameTime: result.gameTime,
    reached: objective.done(result.finalState),
  };
};
