/**
 * Simulation-only return-on-investment evaluation for buyable content.
 *
 * The live game does not need a strategy opinion. This evaluator lives under
 * tools/ and applies each hypothetical purchase to a resource-rich immutable
 * probe, so the domain layer remains the source of truth for effects and costs.
 */
import { CivilizationState } from "../src/game/civilizationState.js";
import { ExpNumber } from "../src/game/expNumber.js";
import { ageDefinitions } from "../src/game/ages.js";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingKey,
} from "../src/game/buildings.js";
import { researchDefinitions } from "../src/game/research.js";
import { upgradeDefinitions } from "../src/game/upgrades.js";
import {
  producerResourceKeys,
  type ProductionResourceKey,
  type ResourceKey,
} from "../src/game/attributes.js";
import { isBuyableUnit, unitDefinitions } from "../src/game/units.js";
import { armyPower } from "../src/game/battle.js";
import { isResourceGatherable, type SimulationAction } from "./simulation.js";

export type RoiBuyableKind =
  | "age"
  | "building"
  | "research"
  | "upgrade"
  | "unit"
  | "battle";

export type RoiBuyable =
  | { kind: "age"; id: string }
  | { kind: "building"; id: BuildingKey }
  | { kind: "research"; id: string }
  | { kind: "upgrade"; id: string }
  | { kind: "unit"; id: string }
  | { kind: "battle"; id: string };

/**
 * What the battle simulator says a battle costs to win: the additional
 * recruits, their resource totals, and the research that unlocks them. Supplied
 * by the caller so this module never imports the simulator, which lives in
 * `tools/strategies.ts` and already depends on this file.
 */
export type BattleRoiPlan = {
  readonly composition: ReadonlyMap<string, number>;
  readonly costs: readonly { resource: ResourceKey; base: ExpNumber }[];
  readonly research: readonly string[];
};

/**
 * How a purchase's military value is measured.
 *
 * - `"logGain"` (default) — the historical metric: the change in `log10` of raw
 *   army power. Preserved exactly so existing callers are unaffected.
 * - `"threatClosure"` — the fraction of the shortfall to the pending enemy that
 *   a purchase closes, bounded to [0, 1].
 *
 * A logarithm is the wrong shape for a stockpile being filled toward a *fixed*
 * enemy: growing 3812 → 5000 is a 31% gain but only 0.12 of a decade, so every
 * incremental recruit scored ~0.1 and a speed-running strategy simply stopped
 * recruiting (measured as an army frozen at 46 warriors for 3000 seconds).
 * Closure asks the right question — "how much nearer the next fight is this" —
 * and is scale-free, so it holds across ages and rebalances.
 *
 * It is opt-in per call because changing it for every strategy at once re-ranked
 * all of them (see `docs/age1-optimization.md` §11).
 */
export type RoiMilitaryMetric = "logGain" | "threatClosure";

export type RoiOptions = {
  /** Clicks modeled by one gather action in the headless runner. */
  gatherClicksPerSecond?: number;
  /** Extra preference for the intentionally large enhancer effects. */
  upgradeMultiplier?: number;
  /** Population milestone currently targeted by campaign progression. */
  populationTarget?: number;
  /** Units are available to the evaluator, but speedrun leaves recruitment
   * to the battle simulator. */
  includeUnits?: boolean;
  /** Enables the battle candidate. Without it, battles are never evaluated. */
  planBattle?: (
    state: CivilizationState,
    battleId: string,
  ) => BattleRoiPlan | null;
  /**
   * Per-call valuation profile, overlaid on the shared defaults.
   *
   * The weights describe what "progress" means to the caller, and different
   * strategies genuinely disagree: a speed-running policy should pay more for
   * closing the next battle's shortfall, while an economy policy should not.
   * Because these numbers are shared, changing them in place silently re-ranks
   * every strategy (see `docs/age1-optimization.md` §11); overriding them here
   * keeps the dial opt-in. Only the keys supplied are changed.
   */
  metricWeights?: Partial<RoiMetricWeights>;
  /**
   * Per-call military metric, defaulting to the historical `logGain`.
   *
   * See `RoiMilitaryMetric`. Left unset, army value is measured exactly as it
   * always was; a caller opts in explicitly, because changing this for every
   * strategy at once re-ranks all of them.
   */
  militaryMetric?: RoiMilitaryMetric;
};

export type RoiMetrics = {
  production: number;
  capacity: number;
  population: number;
  military: number;
  unlocks: number;
  costSavings: number;
  researchTime: number;
  campaign: number;
  campaignTime: number;
};

export type RoiEvaluation = {
  readonly buyable: RoiBuyable;
  readonly action: SimulationAction;
  readonly costs: readonly BuildingCost[];
  readonly metrics: RoiMetrics;
  readonly benefit: number;
  readonly waitSeconds: number;
  readonly score: number;
  readonly affordable: boolean;
  readonly reachable: boolean;
  readonly gatherResource?: ProductionResourceKey;
  readonly order: number;
  /**
   * A battle's whole army cost. `costs` holds only the next recruit, because
   * that is what one action buys; this keeps the full investment visible.
   */
  readonly totalCost?: readonly BuildingCost[];
};

const defaultGatherClicksPerSecond = 10;
const defaultUpgradeMultiplier = 4;
const maxLog = 1_000_000;
const probeAmount = ExpNumber.fromLog10(1_000_000);
const epsilon = ExpNumber.ONE;

const logValue = (value: ExpNumber): number => {
  if (value.sign <= 0) return 0;
  const result = value.add(epsilon).log10();
  if (!Number.isFinite(result)) return maxLog;
  return Math.min(maxLog, result);
};

const logGain = (before: ExpNumber, after: ExpNumber): number => {
  const gain = logValue(after) - logValue(before);
  return Number.isFinite(gain) ? Math.max(0, gain) : 0;
};

/** Signed, scale-normalized change so a drain lowers ROI instead of being ignored. */
const relativeChange = (before: ExpNumber, after: ExpNumber): number => {
  const scale = ExpNumber.max(ExpNumber.ONE, before.abs(), after.abs());
  const change = after.sub(before).div(scale);
  const value = change.toNumber();
  if (Number.isFinite(value)) return value;
  if (change.sign > 0) return 1;
  if (change.sign < 0) return -1;
  return 0;
};

const isProductionResource = (
  resource: string,
): resource is ProductionResourceKey =>
  producerResourceKeys.includes(resource as ProductionResourceKey);

const effectiveIncome = (
  state: CivilizationState,
  resource: ResourceKey,
  gatherClicksPerSecond: number,
): ExpNumber => {
  if (!isProductionResource(resource)) return ExpNumber.ZERO;
  const passive = state.computeResourceRate(resource);
  const rate = passive.gt(ExpNumber.ZERO) ? passive : ExpNumber.ZERO;
  if (!isResourceGatherable(state, resource as ResourceKey)) return rate;
  return rate.add(
    state
      .computeClickGain(resource)
      .mul(ExpNumber.fromNumber(gatherClicksPerSecond)),
  );
};

const waitForCosts = (
  state: CivilizationState,
  costs: readonly BuildingCost[],
  gatherClicksPerSecond: number,
  stockState: CivilizationState = state,
  useCurrentStock = true,
): number => {
  let wait = 0;
  for (const { resource, base } of costs) {
    const available = useCurrentStock
      ? stockState.resources[resource]
      : ExpNumber.ZERO;
    const missing = base.sub(available);
    if (missing.lte(ExpNumber.ZERO)) continue;
    const income = effectiveIncome(state, resource, gatherClicksPerSecond);
    if (!income.gt(ExpNumber.ZERO)) return Number.POSITIVE_INFINITY;
    const seconds = missing.div(income).toNumber();
    if (!Number.isFinite(seconds)) return Number.POSITIVE_INFINITY;
    wait = Math.max(wait, seconds);
  }
  return wait;
};

const gatherResourceForCosts = (
  state: CivilizationState,
  costs: readonly BuildingCost[],
  gatherClicksPerSecond: number,
): ProductionResourceKey | undefined => {
  const timed = costs
    .filter(({ resource, base }) => state.resources[resource].lt(base))
    .map(({ resource, base }) => {
      const missing = base.sub(state.resources[resource]);
      const income = effectiveIncome(state, resource, gatherClicksPerSecond);
      return {
        resource,
        seconds: income.gt(ExpNumber.ZERO)
          ? missing.div(income).toNumber()
          : Number.POSITIVE_INFINITY,
      };
    })
    .filter(
      (entry): entry is { resource: ProductionResourceKey; seconds: number } =>
        isProductionResource(entry.resource) &&
        isResourceGatherable(state, entry.resource as ResourceKey) &&
        Number.isFinite(entry.seconds),
    );
  return timed.sort(
    (left, right) =>
      right.seconds - left.seconds ||
      left.resource.localeCompare(right.resource),
  )[0]?.resource;
};

const makeProbeState = (
  state: CivilizationState,
  costs: readonly BuildingCost[],
): CivilizationState => {
  const resources = { ...state.resources };
  for (const { resource } of costs) {
    if (!isProductionResource(resource)) continue;
    resources[resource] = ExpNumber.max(resources[resource], probeAmount);
  }
  return new CivilizationState(
    resources,
    state.workers,
    state.builtBuildings,
    state.resourceFactors,
    state.buildingCostOverrides,
    state.autoClicksPerSecond,
    state.boughtUpgrades,
    state.defeatedEncounters,
    state.enteredAges,
    state.earnedAchievements,
    state.statistics,
    { ...state.unitCounts },
    state.devProductionMultiplier,
    state.freeBuildings,
    state.freeUnits,
    state.freeUpgrades,
    state.boughtResearch,
  );
};

const applyBuyable = (
  state: CivilizationState,
  buyable: RoiBuyable,
): CivilizationState => {
  switch (buyable.kind) {
    case "building":
      return state.build(buyable.id, 1);
    case "research":
      return state.buyResearch(buyable.id);
    case "upgrade":
      return state.buyUpgrade(buyable.id);
    case "unit":
      return state.buyUnit(buyable.id, 1);
    case "age":
      return state.enterAge(buyable.id);
    // Battles are never applied directly: `evaluateBattle` arms a probe with the
    // plan's army first, which is the whole point of the evaluation.
    case "battle":
      return state;
  }
};

/** Research prerequisites, in an order that can actually be bought. */
const researchClosure = (
  researchIds: readonly string[],
  seen: Set<string> = new Set(),
): string[] => {
  const ordered: string[] = [];
  for (const researchId of researchIds) {
    if (seen.has(researchId)) continue;
    seen.add(researchId);
    const research = researchDefinitions.find(({ key }) => key === researchId);
    if (!research) continue;
    ordered.push(...researchClosure(research.prerequisites, seen), researchId);
  }
  return ordered;
};

/**
 * Arm a resource-rich probe with the plan's research and recruits, then resolve
 * the battle for real. Returns null when the plan cannot actually win it — the
 * gain is measured through the domain transition, never assumed, so an
 * optimistic simulator plan scores nothing.
 */
/**
 * Cache for the expensive half of a battle evaluation: arming the probe and
 * resolving the fight. The result depends only on the plan and the army, never
 * on current balances, so it is memoized on a signature of exactly those; the
 * wait and the action stay live and are recomputed every time. Without this the
 * ROI sweep would run a full battle simulation on every one of the runner's
 * five decisions per second.
 */
const battleEvaluationCache = new Map<
  string,
  { armed: CivilizationState; won: CivilizationState } | null
>();
const battleEvaluationLimit = 64;

const battleEvaluationKey = (
  state: CivilizationState,
  battleId: string,
  plan: BattleRoiPlan,
): string =>
  [
    battleId,
    [...plan.composition]
      .map(([unitId, count]) => `${unitId}x${count}`)
      .sort()
      .join(","),
    [...plan.research].sort().join(","),
    Object.keys(state.unitCounts)
      .sort()
      .map((unitId) => `${unitId}:${state.unitCounts[unitId].toString()}`)
      .join(","),
  ].join("|");

const uncachedEvaluateBattle = (
  state: CivilizationState,
  battleId: string,
  plan: BattleRoiPlan,
): { armed: CivilizationState; won: CivilizationState } | null => {
  // Science is added to the probe so the plan's research is buyable, but it is
  // deliberately kept out of the cost list the player actually pays.
  let armed = makeProbeState(state, [
    ...plan.costs.map((cost) => ({ ...cost, factor: 1 })),
    { resource: "science", base: ExpNumber.ZERO, factor: 1 },
  ]);
  for (const researchId of researchClosure(plan.research)) {
    if (armed.isResearchBought(researchId)) continue;
    armed = armed.buyResearch(researchId);
  }
  for (const [unitId, count] of plan.composition) {
    if (count > 0) armed = armed.buyUnit(unitId, count);
  }
  const won = armed.resolveBattle(battleId);
  return won.defeatedEncounters.includes(battleId) ? { armed, won } : null;
};

const evaluateBattle = (
  state: CivilizationState,
  battleId: string,
  plan: BattleRoiPlan,
): { armed: CivilizationState; won: CivilizationState } | null => {
  const key = battleEvaluationKey(state, battleId, plan);
  const cached = battleEvaluationCache.get(key);
  if (cached !== undefined) return cached;
  const resolved = uncachedEvaluateBattle(state, battleId, plan);
  if (battleEvaluationCache.size >= battleEvaluationLimit) {
    const oldest = battleEvaluationCache.keys().next().value;
    if (oldest !== undefined) battleEvaluationCache.delete(oldest);
  }
  battleEvaluationCache.set(key, resolved);
  return resolved;
};

/** The next concrete step toward a battle: fight it, or buy into its army. */
const battleAction = (
  state: CivilizationState,
  battleId: string,
  plan: BattleRoiPlan,
  gatherResource: ProductionResourceKey | undefined,
): SimulationAction => {
  if (state.simulateEncounter(battleId)?.outcome === "player") {
    return { type: "launchBattle", encounterId: battleId };
  }
  for (const [unitId, count] of plan.composition) {
    if (count > 0 && state.isUnitAvailable(unitId)) {
      const affordable = Math.min(count, state.getMaxAffordableUnits(unitId));
      if (affordable > 0) {
        return { type: "buyUnit", unitId, count: affordable };
      }
    }
  }
  return gatherResource
    ? { type: "gather", resource: gatherResource }
    : { type: "wait", seconds: 0 };
};

const costsFor = (
  state: CivilizationState,
  buyable: RoiBuyable,
): readonly BuildingCost[] => {
  switch (buyable.kind) {
    case "age":
      return [];
    case "building":
      return state.freeBuildings
        ? []
        : state.getBuildingCost(
            buyable.id,
            state.getBuildingCount(buyable.id),
            1,
          );
    case "research":
      return state.getResearchNextCost();
    case "upgrade":
      return state.freeUpgrades ? [] : state.getUpgradeCost(buyable.id);
    case "unit":
      return state.freeUnits ? [] : state.getUnitCost(buyable.id, 1);
    case "battle":
      return [];
  }
};

const isLegal = (state: CivilizationState, buyable: RoiBuyable): boolean => {
  switch (buyable.kind) {
    case "age":
      return (
        state.getCurrentAge()?.key === buyable.id &&
        state.canEnterAge(buyable.id)
      );
    case "building":
      return (
        state.isBuildingAvailable(buyable.id) &&
        !state.isBuildingAtCapacity(buyable.id)
      );
    case "research":
      return (
        state.isResearchUnlocked(buyable.id) &&
        !state.isResearchBought(buyable.id)
      );
    case "upgrade":
      return (
        state.isUpgradeUnlocked(buyable.id) &&
        !state.isUpgradeBought(buyable.id)
      );
    case "unit":
      return state.isUnitAvailable(buyable.id);
    // Only the battle the campaign is actually offering, and only once.
    case "battle":
      return (
        state.getNextBattle()?.key === buyable.id &&
        !state.defeatedEncounters.includes(buyable.id)
      );
  }
};

const availableBuyableUnitCount = (state: CivilizationState): number =>
  unitDefinitions.filter(
    (unit) => isBuyableUnit(unit) && state.isUnitAvailable(unit.key),
  ).length;

const compareMilitary = (
  before: CivilizationState,
  after: CivilizationState,
  mode: RoiMilitaryMetric,
): number => {
  const armyBefore = before.getArmyPower();
  const armyAfter = after.getArmyPower();
  if (mode === "threatClosure") {
    const beforePower = beforePowerOf(armyBefore);
    const afterPower = beforePowerOf(armyAfter);
    if (afterPower === null || beforePower === null) return 0;
    const gained = afterPower - beforePower;
    if (gained <= 0) return 0;
    const threat = pendingThreatPower(before);
    if (threat <= 0) {
      // No enemy pending: fall back to proportional growth so army keeps a
      // bounded value between campaigns.
      return Math.min(1, gained / Math.max(1, beforePower));
    }
    const gap = threat - beforePower;
    // Already able to answer the pending enemy: credit only the part of the gain
    // small relative to the enemy, so a modest buffer for the *next* encounter
    // is still worth something while mass over-building stops paying.
    return gap <= 0
      ? Math.min(1, gained / threat)
      : Math.min(1, gained / gap);
  }
  return logGain(armyBefore, armyAfter);
};

/** Finite JS reading of an `ExpNumber`, or null when it is not representable. */
const beforePowerOf = (value: ExpNumber): number | null => {
  const result = value.toNumber();
  return Number.isFinite(result) ? result : null;
};

/**
 * Army power of the enemy the campaign is currently offering, or 0 when no
 * battle is pending. Read through the engine so enemy research boosts apply and
 * no content ids are needed here.
 */
const pendingThreatPower = (state: CivilizationState): number => {
  const battle = state.getNextBattle();
  if (!battle) return 0;
  const stacks = state.getEnemyStacks(battle.key);
  if (stacks.length === 0) return 0;
  const power = armyPower(stacks).toNumber();
  return Number.isFinite(power) ? Math.max(0, power) : 0;
};

const compareProduction = (
  before: CivilizationState,
  after: CivilizationState,
): number =>
  producerResourceKeys.reduce(
    (total, resource) =>
      total +
      relativeChange(
        before.computeResourceRate(resource),
        after.computeResourceRate(resource),
      ),
    0,
  );

const compareCapacity = (
  before: CivilizationState,
  after: CivilizationState,
): number =>
  logGain(before.maximumPopulation, after.maximumPopulation) +
  buildingDefinitions.reduce(
    (total, building) =>
      total +
      logGain(
        before.getBuildingMax(building.key),
        after.getBuildingMax(building.key),
      ),
    0,
  );

const compareCosts = (
  before: CivilizationState,
  after: CivilizationState,
): number =>
  buildingDefinitions.reduce((total, building) => {
    const count = before.getBuildingCount(building.key);
    const beforeCost = before.getBuildingCost(building.key, count, 1);
    const afterCost = after.getBuildingCost(building.key, count, 1);
    return beforeCost.reduce(
      (sum, { base }, index) =>
        sum +
        Math.max(0, logValue(base) - logValue(afterCost[index]?.base ?? base)),
      total,
    );
  }, 0);

const relativeTimeSavings = (beforeWait: number, afterWait: number): number => {
  if (!Number.isFinite(beforeWait)) {
    return Number.isFinite(afterWait) ? 1 : 0;
  }
  if (!Number.isFinite(afterWait)) return 0;
  return Math.max(0, Math.min(1, (beforeWait - afterWait) / (1 + beforeWait)));
};

const futureResearchTimeSavings = (
  before: CivilizationState,
  after: CivilizationState,
  buyable: RoiBuyable,
): number => {
  if (buyable.kind !== "research") return 0;
  const age = before.getCurrentAge();
  if (!age) return 0;
  const ageIndex = ageDefinitions.findIndex(({ key }) => key === age.key);
  const remaining = researchDefinitions.filter(
    (research) =>
      research.age === ageIndex && !before.isResearchBought(research.key),
  ).length;
  const horizon = Math.min(5, Math.max(0, remaining - 1));
  if (horizon === 0) return 0;

  const beforeWait = waitForCosts(
    before,
    before.getResearchCostForCount(horizon),
    defaultGatherClicksPerSecond,
    before,
    false,
  );
  const afterWait = waitForCosts(
    after,
    after.getResearchCostForCount(horizon),
    defaultGatherClicksPerSecond,
    after,
    false,
  );
  return relativeTimeSavings(beforeWait, afterWait);
};

const buildMetrics = (
  before: CivilizationState,
  after: CivilizationState,
  buyable: RoiBuyable,
  populationTarget?: number,
  campaignTime = 0,
  militaryMetric: RoiMilitaryMetric = "logGain",
): RoiMetrics => {
  const capacity = compareCapacity(before, after);
  const ageIndex = ageDefinitions.findIndex(({ key }) => key === buyable.id);
  const ageResearchComplete =
    buyable.kind === "age" &&
    ageIndex >= 0 &&
    researchDefinitions
      .filter(({ age }) => age === ageIndex)
      .every(({ key }) => before.isResearchBought(key));
  const populationGoalPending =
    populationTarget !== undefined &&
    before.population.lt(ExpNumber.fromNumber(populationTarget));
  const contributesToPopulationGoal =
    buyable.kind === "building" &&
    (buyable.id === "people" ||
      ((buyable.id === "house" || buyable.id === "townHall") &&
        before.population.gte(before.maximumPopulation.floor())));
  return {
    production: compareProduction(before, after),
    capacity,
    population: logGain(before.population, after.population),
    military: compareMilitary(before, after, militaryMetric),
    unlocks:
      buyable.kind === "research"
        ? Math.max(
            0,
            availableBuyableUnitCount(after) -
              availableBuyableUnitCount(before),
          )
        : 0,
    costSavings: compareCosts(before, after),
    researchTime: futureResearchTimeSavings(before, after, buyable),
    campaignTime,
    campaign:
      buyable.kind === "battle"
        ? 1 + (capacity > 0 ? 100 : 0)
        : ageResearchComplete
          ? maxLog
          : populationGoalPending && contributesToPopulationGoal
            ? maxLog
            : 0,
  };
};

const actionFor = (buyable: RoiBuyable): SimulationAction => {
  switch (buyable.kind) {
    case "age":
      return { type: "enterAge", ageId: buyable.id };
    case "building":
      return { type: "build", building: buyable.id, count: 1 };
    case "research":
      return { type: "buyResearch", researchId: buyable.id };
    case "upgrade":
      return { type: "buyUpgrade", upgradeId: buyable.id };
    case "unit":
      return { type: "buyUnit", unitId: buyable.id, count: 1 };
    case "battle":
      // Replaced per-state by `battleAction`; this is only a safe fallback.
      return { type: "wait", seconds: 0 };
  }
};

const optionNumber = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;

/**
 * Metrics memo. Building the metrics means constructing a probe state and
 * applying a real transition, which is the expensive half of a scan — and a scan
 * runs on every one of the runner's five decisions per second.
 *
 * The metrics are deliberately *resource-independent*: production rates,
 * capacities, population, army power and unit availability all follow from what
 * is built and researched, not from current balances. So they are memoized on a
 * structural fingerprint of the state, and gathering or ticking (which changes
 * only balances) reuses them. The cheap part — the wait and whether the
 * purchase is affordable — is still recomputed every call, because balances are
 * exactly what it depends on.
 */
const metricsCache = new Map<string, RoiMetrics | null>();
const metricsCacheLimit = 512;

const structuralKey = (state: CivilizationState): string =>
  [
    Object.entries(state.builtBuildings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => `${key}:${count ?? 0}`)
      .join(","),
    state.boughtUpgrades.join(","),
    state.boughtResearch.join(","),
    state.enteredAges.join(","),
    state.defeatedEncounters.join(","),
    state.earnedAchievements.join(","),
    Object.keys(state.unitCounts)
      .sort()
      .map((unitId) => `${unitId}:${state.unitCounts[unitId].toString()}`)
      .join(","),
  ].join("|");

/** Memoized metrics for one candidate, or null when the buyable is a no-op. */
const cachedMetrics = (
  buyable: RoiBuyable,
  structureKey: string,
  contextKey: string,
  measure: () => RoiMetrics | null,
): RoiMetrics | null => {
  const key = `${structureKey}::${contextKey}:${buyable.kind}:${(buyable as { id: string }).id}`;
  const hit = metricsCache.get(key);
  if (hit !== undefined) return hit;
  const metrics = measure();
  if (metricsCache.size >= metricsCacheLimit) {
    const oldest = metricsCache.keys().next().value;
    if (oldest !== undefined) metricsCache.delete(oldest);
  }
  metricsCache.set(key, metrics);
  return metrics;
};

/**
 * The shared default weights. See `metricWeights` in `RoiOptions` for why this
 * is overridable per call rather than tuned in place.
 */
export type RoiMetricWeights = {
  production: number;
  capacity: number;
  population: number;
  military: number;
  unlocks: number;
  costSavings: number;
  researchTime: number;
  campaign: number;
  campaignTime: number;
};

/**
 * Metric weights. Capacity is weighted heavily on purpose: a battle that doubles
 * `townHallCapacity` or `barracksCapacity` unlocks more houses, more barracks
 * and therefore more population, which is worth far more than its log gain
 * alone suggests. Tuned by feel, so they live in one place.
 */
const defaultMetricWeights: RoiMetricWeights = {
  production: 1,
  capacity: 2.5,
  population: 0.7,
  military: 0.9,
  unlocks: 0.6,
  costSavings: 0.25,
  researchTime: 100,
  campaign: 20,
  campaignTime: 50,
};

/**
 * Resolve the weights for one evaluation, overlaying a caller's profile on the
 * shared default.
 *
 * This exists because the weights are a **shared objective function**, not a
 * global constant. Every strategy that calls `getBestRoiAction` ranks its
 * purchases with these same numbers, so moving one weight re-ranks all of them
 * at once — measured in `docs/age1-optimization.md` §11, where raising the
 * weight on `military` sped `speedrun` up by 27 minutes and cost six other
 * strategies 3 to 7 minutes each. A strategy that genuinely wants a different
 * valuation must therefore ask for one explicitly rather than editing the dial
 * out from under everyone else.
 */
const resolveMetricWeights = (
  override?: Partial<RoiMetricWeights>,
): RoiMetricWeights =>
  override ? { ...defaultMetricWeights, ...override } : defaultMetricWeights;

const weightedBenefit = (
  metrics: RoiMetrics,
  weights: RoiMetricWeights,
): number =>
  metrics.production * weights.production +
  metrics.capacity * weights.capacity +
  metrics.population * weights.population +
  metrics.military * weights.military +
  metrics.unlocks * weights.unlocks +
  metrics.costSavings * weights.costSavings +
  metrics.researchTime * weights.researchTime +
  metrics.campaign * weights.campaign +
  metrics.campaignTime * weights.campaignTime;

/**
 * The cost of one more recruit toward a plan: what a single buy action actually
 * has to afford. Pricing the battle by the *whole* army would divide its (large)
 * benefit by the time to save for the entire army, so it could never outrank an
 * instant purchase and the campaign would stall.
 */
const nextRecruitCost = (
  state: CivilizationState,
  plan: BattleRoiPlan,
): readonly BuildingCost[] | null => {
  for (const [unitId, count] of plan.composition) {
    if (count > 0 && state.isUnitAvailable(unitId)) {
      return state.freeUnits ? [] : state.getUnitCost(unitId, 1);
    }
  }
  return null;
};

const campaignTimeSavings = (
  state: CivilizationState,
  after: CivilizationState,
  options: RoiOptions,
  gatherClicksPerSecond: number,
): number => {
  let bestSavings = 0;
  const battle = state.getNextBattle();
  if (battle && options.planBattle) {
    const beforePlan = options.planBattle(state, battle.key);
    const afterPlan = options.planBattle(after, battle.key);
    if (beforePlan && afterPlan) {
      const beforeCosts = beforePlan.costs.map((cost) => ({
        ...cost,
        factor: 1,
      }));
      const afterCosts = afterPlan.costs.map((cost) => ({
        ...cost,
        factor: 1,
      }));
      const beforeWait = waitForCosts(
        state,
        beforeCosts,
        gatherClicksPerSecond,
        state,
        false,
      );
      const afterWait = waitForCosts(
        after,
        afterCosts,
        gatherClicksPerSecond,
        state,
        false,
      );
      bestSavings = relativeTimeSavings(beforeWait, afterWait);
    }
  }

  const target = options.populationTarget;
  if (
    target === undefined ||
    state.population.gte(ExpNumber.fromNumber(target))
  ) {
    return bestSavings;
  }
  const growthCosts = (
    candidate: CivilizationState,
  ): readonly BuildingCost[] => {
    if (candidate.population.gte(candidate.maximumPopulation.floor())) {
      const housing = candidate.isBuildingAtCapacity("house")
        ? "townHall"
        : "house";
      if (
        !candidate.isBuildingAvailable(housing) ||
        candidate.isBuildingAtCapacity(housing)
      ) {
        return [];
      }
      return candidate.getBuildingCost(
        housing,
        candidate.getBuildingCount(housing),
        1,
      );
    }
    return candidate.getBuildingCost(
      "people",
      candidate.getBuildingCount("people"),
      1,
    );
  };
  const beforeCosts = growthCosts(state);
  const afterCosts = growthCosts(after);
  if (beforeCosts.length > 0) {
    const beforeWait = waitForCosts(
      state,
      beforeCosts,
      gatherClicksPerSecond,
      state,
      false,
    );
    const afterWait = waitForCosts(
      after,
      afterCosts,
      gatherClicksPerSecond,
      state,
      false,
    );
    bestSavings = Math.max(
      bestSavings,
      relativeTimeSavings(beforeWait, afterWait),
    );
  }
  return bestSavings;
};

/** Evaluate one legal buyable against a resource-rich domain transition. */
export const getBuyableRoi = (
  state: CivilizationState,
  buyable: RoiBuyable,
  options: RoiOptions = {},
  order = 0,
  structureKey = structuralKey(state),
): RoiEvaluation | null => {
  if (!isLegal(state, buyable)) return null;
  const gatherClicksPerSecond = optionNumber(
    options.gatherClicksPerSecond,
    defaultGatherClicksPerSecond,
  );
  // Resolved once per candidate. It is deliberately *not* part of the metrics
  // cache key: `RoiMetrics` are raw, weight-independent readings, so callers
  // with different profiles still share one cache entry.
  const weights = resolveMetricWeights(options.metricWeights);
  const militaryMetric = options.militaryMetric ?? "logGain";

  // A battle is not a purchase: its cost is the army the simulator says it
  // takes, and its gain is whatever winning actually does to the state.
  if (buyable.kind === "battle") {
    const plan = options.planBattle?.(state, buyable.id) ?? null;
    if (!plan) return null;
    const totalCost: readonly BuildingCost[] = plan.costs.map((cost) => ({
      ...cost,
      factor: 1,
    }));
    const winnable = state.simulateEncounterOutcome(buyable.id) === "player";
    // A battle that can already be fought costs nothing to launch; otherwise the
    // price is the next single recruit, not the whole army.
    const costs = winnable ? [] : (nextRecruitCost(state, plan) ?? totalCost);
    const waitSeconds = waitForCosts(state, costs, gatherClicksPerSecond);
    const investmentWaitSeconds = waitForCosts(
      state,
      totalCost,
      gatherClicksPerSecond,
    );
    const metrics = cachedMetrics(
      buyable,
      structureKey,
      `${options.populationTarget ?? ""}:${militaryMetric}`,
      () => {
        const resolved = evaluateBattle(state, buyable.id, plan);
        return resolved
          ? buildMetrics(
              resolved.armed,
              resolved.won,
              buyable,
              options.populationTarget,
              0,
              militaryMetric,
            )
          : null;
      },
    );
    if (!metrics) return null;
    const gatherResource = gatherResourceForCosts(
      state,
      costs,
      gatherClicksPerSecond,
    );
    const benefit = weightedBenefit(metrics, weights);
    return {
      buyable,
      action: battleAction(state, buyable.id, plan, gatherResource),
      costs,
      totalCost,
      metrics,
      benefit,
      waitSeconds,
      score: Number.isFinite(investmentWaitSeconds)
        ? benefit / (1 + Math.max(0, investmentWaitSeconds))
        : 0,
      affordable: waitSeconds === 0,
      reachable: Number.isFinite(waitSeconds),
      gatherResource,
      order,
    };
  }

  const costs = costsFor(state, buyable);
  const waitSeconds = waitForCosts(state, costs, gatherClicksPerSecond);
  const metrics = cachedMetrics(
    buyable,
    structureKey,
    `${options.populationTarget ?? ""}:${militaryMetric}`,
    () => {
      const probe = makeProbeState(state, costs);
      const after = applyBuyable(probe, buyable);
      return after === probe
        ? null
        : buildMetrics(
            probe,
            after,
            buyable,
            options.populationTarget,
            campaignTimeSavings(state, after, options, gatherClicksPerSecond),
            militaryMetric,
          );
    },
  );
  if (!metrics) return null;
  const populationCampaignPurchase =
    metrics.campaign > 0 &&
    buyable.kind === "building" &&
    (buyable.id === "people" ||
      buyable.id === "house" ||
      buyable.id === "townHall");
  const campaignBenefit = populationCampaignPurchase
    ? metrics.campaign * weights.campaign
    : 0;
  const benefit =
    (weightedBenefit(metrics, weights) -
      (populationCampaignPurchase && waitSeconds !== 0 ? campaignBenefit : 0)) *
    (buyable.kind === "upgrade"
      ? optionNumber(options.upgradeMultiplier, defaultUpgradeMultiplier)
      : 1);
  const score = Number.isFinite(waitSeconds)
    ? benefit / (1 + Math.max(0, waitSeconds))
    : 0;
  return {
    buyable,
    action: actionFor(buyable),
    costs,
    metrics,
    benefit,
    waitSeconds,
    score,
    affordable: waitSeconds === 0,
    reachable: Number.isFinite(waitSeconds),
    gatherResource: gatherResourceForCosts(state, costs, gatherClicksPerSecond),
    order,
  };
};

const allBuyables = (
  state: CivilizationState,
  options: RoiOptions,
): RoiBuyable[] => {
  const includeUnits = options.includeUnits ?? true;
  const buildings: RoiBuyable[] = buildingDefinitions.map(({ key }) => ({
    kind: "building",
    id: key,
  }));
  const research: RoiBuyable[] = researchDefinitions.map(({ key }) => ({
    kind: "research",
    id: key,
  }));
  const upgrades: RoiBuyable[] = upgradeDefinitions.map(({ key }) => ({
    kind: "upgrade",
    id: key,
  }));
  const ages: RoiBuyable[] = ageDefinitions.map(({ key }) => ({
    kind: "age",
    id: key,
  }));
  const units: RoiBuyable[] = includeUnits
    ? unitDefinitions
        .filter((unit) => isBuyableUnit(unit))
        .map(({ key }) => ({ kind: "unit" as const, id: key }))
    : [];
  // The battle the campaign is offering, evaluated as cost-versus-gain. It is
  // only ever one candidate: the next unwon encounter in the current age.
  const nextBattle = state.getNextBattle();
  const battles: RoiBuyable[] =
    options.planBattle &&
    nextBattle &&
    !state.defeatedEncounters.includes(nextBattle.key)
      ? [{ kind: "battle", id: nextBattle.key }]
      : [];
  return [
    ...ages,
    ...buildings,
    ...research,
    ...upgrades,
    ...units,
    ...battles,
  ].filter((buyable) => isLegal(state, buyable));
};

/** All legal ROI candidates, sorted by time-adjusted score. */
export const getRoiCandidates = (
  state: CivilizationState,
  options: RoiOptions = {},
): RoiEvaluation[] => {
  // Hoisted: the structural fingerprint is built once per scan, not once per
  // candidate — rebuilding it per candidate cost about 3 ms a call.
  const key = structuralKey(state);
  const candidates = allBuyables(state, options)
    .map((buyable, order) => getBuyableRoi(state, buyable, options, order, key))
    .filter((candidate): candidate is RoiEvaluation => candidate !== null);
  return candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.benefit - left.benefit ||
      left.order - right.order,
  );
};

export const getBestRoiCandidate = (
  state: CivilizationState,
  options: RoiOptions = {},
): RoiEvaluation | null =>
  getRoiCandidates(state, options).find(
    (candidate) => candidate.reachable && candidate.benefit > 0,
  ) ?? null;

/** Best actionable ROI choice, or a gather action for its first missing cost. */
export const getBestRoiAction = (
  state: CivilizationState,
  options: RoiOptions = {},
): SimulationAction | null => {
  const candidates = getRoiCandidates(state, {
    ...options,
    includeUnits: options.includeUnits ?? false,
  });
  for (const candidate of candidates) {
    if (!candidate.reachable || candidate.benefit <= 0) continue;
    if (candidate.affordable) return candidate.action;
    if (candidate.gatherResource) {
      return { type: "gather", resource: candidate.gatherResource };
    }
  }
  return null;
};
