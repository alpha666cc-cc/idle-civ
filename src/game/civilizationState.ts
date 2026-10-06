import {
  achievementDefinitions,
  chainFamilyForId,
  findAchievementDefinition,
  materializeOpenEndedTier,
  nextHoarderExponent,
  openEndedHoarderChains,
  type AchievementRequirement,
  type BattleAchievementContext,
} from "./achievements";
import { ageDefinitions, findAgeDefinition, type AgeDefinition } from "./ages";
import {
  DEFAULT_FORMATION,
  formationsForAge,
  type FormationId,
} from "./formations";
import {
  buildingPowerAttributeDefinitions,
  computeResourceRate,
  derivedAttributeDefinitions,
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  findAttributeDefinition,
  producerResourceKeys,
  productionDefinitions,
  summarizeResourceFactors,
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
import {
  armyPower,
  ordersForAge,
  simulateBattle,
  simulateBattleOutcome,
  standardOrder,
  type ArmyStack,
  type BattleOrder,
  type BattleSimulation,
  type BattleOutcome,
} from "./battle";
import {
  collectCostReductions,
  type Bonus,
  type CostReductions,
} from "./bonus";
import {
  calculateTradeMultiplier,
  clampTradeIntensity,
  DEFAULT_TRADE_SPREAD,
  GOLD_PER_TRADE_POWER,
  defaultTradeRoute,
  getTradePrice,
  tradeRouteSource,
  tradeableResourceKeys,
  type TradePrice,
  type TradeResourceKey,
  type TradeRoute,
  type TradeRouteMap,
} from "./trade";
import {
  buildingDefinitions,
  type BuildingCost,
  type BuildingEffects,
  type BuildingKey,
} from "./buildings";
import {
  encounterDefinitions,
  findEncounterDefinition,
  type EncounterDefinition,
} from "./encounters";
import { ExpNumber } from "./expNumber";
import {
  findResearchDefinition,
  researchBonusesForIds,
  researchIdsForBattle,
  researchIdsForUnitUnlocks,
  researchesClosingUnit,
  researchesUnlockingUnit,
} from "./research";
import {
  emptyStatistics,
  tickMilliseconds,
  type Statistics,
} from "./statistics";
import {
  findUnitDefinition,
  isBuyableUnit,
  maximumArmor,
  parseUnitStatTarget,
  unitDefinitions,
  unitMatchesStatTarget,
  type UnitDefinition,
  type UnitStatKey,
  type UnitStats,
} from "./units";
import { upgradeDefinitions } from "./upgrades";
import { WorkerProduction } from "./workerProduction";

/**
 * One cost entry with its curve inputs rewritten by the §13.1 reduction
 * order: unitBase is the scale B, unitFactor the growth base F of the
 * square-root curve T(n) = B * (F^sqrt(n) - 1) described in §4.4.
 */
type CostParameters = {
  cost: BuildingCost;
  unitBase: ExpNumber;
  unitFactor: ExpNumber;
  reductions: CostReductions;
};

type BuildingCostOverrides = Partial<Record<BuildingKey, BuildingCost[]>>;

/** Units have no capacity limit (§13.3), so the MAX probe stops here. */
const maximumUnitPurchase = 1_000_000;

const capacitySlotCount = (capacity: ExpNumber): ExpNumber => {
  const numericCapacity = capacity.toNumber();
  if (Number.isFinite(numericCapacity)) {
    const nextSlot = Math.round(numericCapacity);
    if (nextSlot > numericCapacity && nextSlot - numericCapacity <= 1e-9) {
      return ExpNumber.fromNumber(nextSlot);
    }
  }
  return capacity.floor();
};

/**
 * A capacity as a whole number of slots, for the plain-number slot arithmetic
 * (`count` vs `capacity`) that gates building purchases.
 *
 * `capacitySlotCount()` already returns an integral ExpNumber, but reading one
 * back through `toNumber()` re-rounds the mantissa and can land a few ULP above
 * the integer (4.4e2 -> 440.00000000000006). Left alone, that residue becomes
 * the headroom against an equally-full count, so MAX answers "5.68e-14
 * markets" and the player sees a fraction of a building. Slots are discrete, so
 * the read floors. A non-finite capacity (unreachable stock) passes through so
 * "no limit" still means no limit.
 */
const wholeSlots = (capacity: ExpNumber): number => {
  const slots = capacity.toNumber();
  return Number.isFinite(slots) ? Math.max(0, Math.floor(slots)) : slots;
};

/**
 * A stored count snapped back onto the integer lattice.
 *
 * `ExpNumber.add` accumulates error by construction. Adding one recruit to 1219
 * is evaluated as `1.219 + 1/1000`, and in binary floating point that is
 * `1.2199999999999998`, not `1.22` — so recruiting one soldier at a time drifts
 * the stored count *downwards*, every single time. Measured on a real run: a
 * settlement that owned exactly 1219 slingers reported `1218.999999999962`, and
 * every other stack in the army was off by a similar few ULP (889 canoes read
 * `888.999999999987`).
 *
 * At that magnitude the error is invisible — it cannot move a displayed number
 * or meaningfully shift an army-power total — but a unit count is a whole number
 * by definition, and leaving it fractional makes `getUnitCount()` non-integral
 * for something that is never actually fractional. Any exact comparison against
 * a plan's composition (`owned === 4`) silently fails, and the residue persists
 * into a save.
 *
 * Snapping is safe here because nothing can legitimately store a fraction: every
 * write path already floors (`build`, `buyUnit`), so a non-integral value here is
 * *always* accumulated drift. The tolerance is relative so it keeps covering
 * large magnitudes, where a fixed absolute epsilon would be meaningless — at
 * 1e9 recruits an absolute 1e-9 is far below the noise floor.
 *
 * Note this is the opposite rule to `capacitySlotCount` above, and deliberately
 * so. A capacity rounds *up* on a residue because losing a slot from rounding is
 * player-visible; a count rounds to *nearest* because the value was integral and
 * drifted, and nearest is the value it was meant to hold.
 */
const snapToWholeCount = (count: ExpNumber): ExpNumber => {
  const value = count.toNumber();
  if (!Number.isFinite(value)) return count;
  const nearest = Math.round(value);
  const tolerance = Math.max(1e-9, Math.abs(value) * 1e-9);
  return Math.abs(value - nearest) <= tolerance
    ? ExpNumber.fromNumber(nearest)
    : count;
};

/** How many leading units the flat cost reduction may zero out directly. */
const flatClampWindow = 256;

/**
 * Slope of the linear early-game price floor, normalized so the standard
 * production factor (25) yields a slope of `unitBase` per unit: unit k costs
 * `unitBase x (1 + (k-1) x factor/25)`. Guarantees unit 1 = base (fixing the
 * old `base x (factor - 1)` first-unit inflation) and floors the factor<e dip
 * so a purchase never gets cheaper (§4.4).
 */
const linearSlope = (unitBase: ExpNumber, unitFactor: ExpNumber): ExpNumber =>
  unitBase.mul(unitFactor).div(ExpNumber.fromNumber(25));

/**
 * Corrected cumulative sqrt curve: T(n) = base x factor^(sqrt(n) - 1), so the
 * exponent carries the -1 (not the whole power). T(1) = base exactly.
 */
const sqrtCurve = (
  unitBase: ExpNumber,
  unitFactor: ExpNumber,
  n: number,
): ExpNumber => unitBase.mul(unitFactor.pow(Math.sqrt(n) - 1));

/**
 * Crossover unit K — the last unit where the linear floor is still >= the sqrt
 * curve's unit price. Units 1..K price on the linear floor; units past K follow
 * `sqrtCurve`. Unit 1 always sits on the floor (its sqrt price is
 * base x (1 - 1/factor) < base), so K >= 1. A bounded scan finds the first unit
 * where the sqrt price overtakes the rising linear floor.
 */
const crossoverToSqrt = (
  unitBase: ExpNumber,
  unitFactor: ExpNumber,
): number => {
  const slope = linearSlope(unitBase, unitFactor);
  const linear = (k: number): ExpNumber =>
    unitBase.add(slope.mul(ExpNumber.fromNumber(k - 1)));
  const sqrtPrice = (k: number): ExpNumber =>
    sqrtCurve(unitBase, unitFactor, k).sub(
      sqrtCurve(unitBase, unitFactor, k - 1),
    );
  let k = 1;
  while (k < maximumUnitPurchase && sqrtPrice(k).lte(linear(k))) k += 1;
  return k - 1;
};

/**
 * Identity-keyed recompute caches. Every state array is replaced immutably and
 * never mutated, so array identity is a free "did anything change" test: a tick
 * that changes nothing reuses the cached values, and the one call after a real
 * change (a build, purchase, victory or earn) rebuilds once. This keeps tick
 * cost independent of building count and earned-achievement count.
 */
const earnedAchievementSets = new WeakMap<readonly string[], Set<string>>();

/** Cached activeBonuses(), keyed on the identity tuple of the four source lists
 * (upgrades, encounters, achievements, research, ages). */
type ActiveBonusList = [sourceId: string, bonus: Bonus][];
const activeBonusCaches = new WeakMap<
  readonly string[],
  WeakMap<
    readonly string[],
    WeakMap<
      readonly string[],
      WeakMap<readonly string[], WeakMap<readonly string[], ActiveBonusList>>
    >
  >
>();

/**
 * The largest N for which `canAffordCount(N)` holds, given per-unit costs that
 * never decrease. A doubling probe finds a tight upper bound and a binary search
 * finishes, so the whole thing is O(log N) evaluations of an O(1) cost check —
 * shared by buildings and units so both keep buy-N and buy-MAX on one evaluator.
 */
const maxAffordableCount = (
  canAffordCount: (count: number) => boolean,
  upperBound: number,
): number => {
  if (!canAffordCount(1)) return 0;
  let probe = 1;
  while (probe < upperBound && canAffordCount(probe * 2)) {
    probe *= 2;
  }
  if (probe >= upperBound && canAffordCount(upperBound)) return upperBound;

  let low = probe;
  let high = Math.min(probe * 2, upperBound);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (canAffordCount(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

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
  armyPower: {
    // Like the auto-click rate, the base *is* the current reading: army power is
    // summed from unit stats, so no bonus targets this attribute directly.
    value: (state) => state.getArmyPower(),
    base: (state) => state.getArmyPower(),
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
  "buildingCostMultiplier",
  "wastedResources",
  "tradeProductionMultiplier",
  "tradeRoutes",
  "buildingPower",
  ...buildingPowerAttributeDefinitions.map(({ key }) => key),
]) {
  // A building's power base comes from its own definition (`power` in
  // buildings.json, defaulting to 1), so a building can start above or below 1;
  // every other derived stat here is based at 1.
  const building = buildingDefinitions.find((b) => `${b.key}Power` === key);
  derivedAttributeComputations[key] = {
    value:
      key === "wastedResources"
        ? (state) => state.statistics.wastedResources
        : key === "tradeProductionMultiplier"
          ? (state) => calculateTradeMultiplier(state.resources.trade)
          : (state) => compoundStatValue(state, key),
    base: () => building?.power ?? ExpNumber.ONE,
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
  readonly builtBuildings: Partial<Record<BuildingKey, number>>;
  readonly resourceFactors: ResourceFactorMap;
  readonly buildingCostOverrides: BuildingCostOverrides;
  readonly autoClicksPerSecond: number;
  readonly boughtUpgrades: readonly string[];
  readonly defeatedEncounters: readonly string[];
  readonly enteredAges: readonly string[];
  readonly earnedAchievements: readonly string[];
  readonly boughtResearch: readonly string[];
  readonly statistics: Statistics;
  /** Units owned per unit id. Casualties never touch this (armies are restored). */
  readonly unitCounts: Record<string, ExpNumber>;
  /**
   * The order each owned unit type fights under, keyed by unit id. Absent means
   * `standard`. Only orders the current age has discovered are stored, so a
   * save written later than the player's age cannot smuggle in a locked order.
   */
  readonly unitOrders: Partial<Record<string, BattleOrder>>;
  /**
   * The formation each owned unit type uses, keyed by unit id. Absent means
   * `standard`. Only formations the current age has discovered are stored.
   */
  readonly unitFormations: Partial<Record<string, FormationId>>;
  /**
   * Trade routes keyed by resource (Trade tab). Only enabled routes are kept;
   * how many may run at once is the `tradeRoutes` stat, so a later bonus opens
   * another route without the engine naming that content (§13.2).
   */
  readonly tradeRoutes: TradeRouteMap;
  /** Dev-tools production multiplier (×N on every producer rate, shown as a factor). */
  readonly devProductionMultiplier: ExpNumber;
  /** Dev-tools free flags: skip affordability + cost deduction, keep capacity gates. */
  readonly freeBuildings: boolean;
  readonly freeUnits: boolean;
  readonly freeUpgrades: boolean;

  constructor(
    resources: ResourceAmounts = emptyResourceAmounts(),
    workers: WorkerAssignments = emptyWorkerAssignments(),
    builtBuildings: Partial<Record<BuildingKey, number>> = { townHall: 1 },
    resourceFactors: ResourceFactorMap = emptyResourceFactors(),
    buildingCostOverrides: BuildingCostOverrides = {},
    autoClicksPerSecond = 0,
    boughtUpgrades: readonly string[] = [],
    defeatedEncounters: readonly string[] = [],
    enteredAges: readonly string[] = [],
    earnedAchievements: readonly string[] = [],
    statistics: Statistics = emptyStatistics(),
    unitCounts: Record<string, ExpNumber> = {},
    devProductionMultiplier: ExpNumber = ExpNumber.ONE,
    freeBuildings = false,
    freeUnits = false,
    freeUpgrades = false,
    boughtResearch: readonly string[] = [],
    unitOrders: Partial<Record<string, BattleOrder>> = {},
    unitFormations: Partial<Record<string, FormationId>> = {},
    tradeRoutes: TradeRouteMap = {},
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
    this.boughtResearch = boughtResearch;
    this.statistics = statistics;
    this.unitCounts = unitCounts;
    this.unitOrders = unitOrders;
    this.unitFormations = unitFormations;
    this.tradeRoutes = tradeRoutes;
    this.devProductionMultiplier = devProductionMultiplier;
    this.freeBuildings = freeBuildings;
    this.freeUnits = freeUnits;
    this.freeUpgrades = freeUpgrades;

    // Set population based on people buildings (derived from buildings, not stored).
    // `builtBuildings` holds plain numbers that `build()` already floors, so this is
    // normally integral; the snap keeps it that way for a save written before that
    // floor existed, and for anyone who later adds a fractional write path.
    this.resources.population = snapToWholeCount(
      ExpNumber.fromNumber(this.buildingCount("people")),
    );

    // Capacity grants are stored in the capacity resources. Establish the
    // base-plus-all-town-halls floor so the starting town hall is not skipped,
    // and so older saves that missed that first grant are repaired on load.
    const townHallCount = this.buildingCount("townHall");
    if (townHallCount > 0) {
      const defaults = emptyResourceAmounts();
      const count = ExpNumber.fromNumber(townHallCount);
      for (const effect of buildingDefinitions.find(
        ({ key }) => key === "townHall",
      )?.effects.capacityProvided ?? []) {
        const targetKey = capacityKey(effect.building);
        const required = defaults[targetKey].add(effect.perBuilding.mul(count));
        if (this.resources[targetKey].lt(required)) {
          this.resources[targetKey] = required;
        }
      }
    }
  }

  get population(): ExpNumber {
    return this.resources.population;
  }

  get maximumPopulation(): ExpNumber {
    return capacitySlotCount(this.resources.peopleCapacity);
  }

  get housingCapacity(): ExpNumber {
    return this.resources.peopleCapacity;
  }

  get assignedWorkers(): number {
    return Object.values(this.workers).reduce(
      (total, count) => total + Math.round(count.toNumber()),
      0,
    );
  }

  get availableWorkers(): number {
    return Math.max(
      0,
      Math.floor(this.population.toNumber()) - this.assignedWorkers,
    );
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

  /**
   * Returns whether a resource can be gathered/assigned workers to.
   * Building-generated resources require their source building to exist.
   */
  isResourceGatherable(resourceKey: ResourceKey): boolean {
    switch (resourceKey) {
      case "military":
        return this.buildingCount("barracks") > 0;
      case "science":
        return this.buildingCount("university") > 0;
      case "metalwork":
        return this.buildingCount("smithy") > 0;
      case "trade":
        return this.buildingCount("market") > 0;
      default:
        return true; // food, wood, stone, gold always available
    }
  }

  gather(resourceKey: ResourceKey): CivilizationState {
    if (!(resourceKey in this.resources) || !(resourceKey in this.workers))
      return this;
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
    if (!this.isResourceGatherable(resourceKey)) return this;
    const actualCount = Math.min(Math.floor(count), this.availableWorkers);
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
    const actualCount = Math.min(
      Math.floor(count),
      Math.round(this.workers[resourceKey].toNumber()),
    );
    if (actualCount <= 0) return this;
    return this.withWorkers({
      ...this.workers,
      [resourceKey]: this.workers[resourceKey].sub(
        ExpNumber.fromNumber(actualCount),
      ),
    });
  }

  /**
   * Assign all idle workers (or up to `count` when given).
   * Food workers are maintained at roughly 10 times each other resource,
   * starting with food, while equalizing the other resources among themselves.
   * Only assigns to gatherable resources (those with required buildings).
   */
  autoAssignWorkers(count = Infinity): CivilizationState {
    const others = (Object.keys(this.workers) as ProductionResourceKey[])
      .filter((key) => key !== "food")
      .filter((key) => this.isResourceGatherable(key));
    let workers = { ...this.workers };
    let available = this.availableWorkers; // already an integer (Math.max(0, Math.floor(...)))
    let remaining = Math.floor(count === Infinity ? available : count);

    while (available > 0 && remaining > 0) {
      if (others.length === 0 || !this.isResourceGatherable("food")) {
        workers.food = workers.food.add(ExpNumber.ONE);
        available -= 1;
        remaining -= 1;
        continue;
      }

      // Find the other resource with the minimum workers to keep others equalized
      let targetOther = others[0];
      let minOtherCount = Math.round(workers[targetOther].toNumber());
      for (const key of others) {
        const cnt = Math.round(workers[key].toNumber());
        if (cnt < minOtherCount) {
          minOtherCount = cnt;
          targetOther = key;
        }
      }

      // Maintain food at ~10× each other resource
      if (Math.round(workers.food.toNumber()) < 10 * (minOtherCount + 1)) {
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
      upgrade.unlock.source === "buildingCount" &&
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
    if (!this.freeUpgrades && !this.hasResourcesForUpgrade(upgradeId))
      return "resources";
    return null;
  }

  /** Returns ids of every upgrade that is unlocked and currently affordable, in definition order. */
  getAffordableUpgrades(): string[] {
    return upgradeDefinitions
      .filter(({ key }) => this.getUpgradeFailureReason(key) === null)
      .map(({ key }) => key);
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
    const cost = this.freeUpgrades ? [] : upgrade.costs;
    for (const { resource, base } of cost) {
      resources[resource] = resources[resource].sub(base);
    }
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      [...this.boughtUpgrades, upgradeId],
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.recordSpending(this.statistics, cost),
    );
  }

  /**
   * Whether the player has reached an age. The opening age is always reachable;
   * later ages count as reached once the player is playing in them, so an age's
   * own era unlocks its research immediately on entry.
   */
  private hasReachedAge(ageIndex: number): boolean {
    if (ageIndex === 0) return true;
    const currentAge = this.getCurrentAge();
    const currentAgeIndex = currentAge
      ? ageDefinitions.findIndex(({ key }) => key === currentAge.key)
      : -1;
    return (
      currentAgeIndex >= ageIndex || this.enteredAges.includes(`age${ageIndex}`)
    );
  }

  /** The tech's age is reached and all prerequisites are bought. */
  isResearchUnlocked(researchId: string): boolean {
    const research = findResearchDefinition(researchId);
    if (!research) return false;
    if (!this.hasReachedAge(research.age)) return false;
    return research.prerequisites.every((prereq) =>
      this.boughtResearch.includes(prereq),
    );
  }

  isResearchBought(researchId: string): boolean {
    return this.boughtResearch.includes(researchId);
  }

  /** Unbought research needed to unlock a set of new unit types, plus its cost. */
  getResearchForUnitTypes(unitIds: readonly string[]): {
    readonly ids: string[];
    readonly costs: BuildingCost[];
  } {
    const ids = researchIdsForUnitUnlocks(unitIds).filter(
      (researchId) => !this.boughtResearch.includes(researchId),
    );
    return {
      ids,
      costs: this.getResearchCostForCount(ids.length),
    };
  }

  /**
   * Research bought **in the current age** — the ordinal `n` the price curve is
   * evaluated at. It is derived rather than stored, which gives the reset for
   * free: entering a new age means nothing in that age has been bought yet, so
   * the counter reads 0. It also means a tech bought from an *earlier* age never
   * advances it.
   */
  getResearchCount(): number {
    const currentAge = this.getCurrentAge();
    if (!currentAge) return 0;
    const ageIndex = ageDefinitions.findIndex(
      ({ key }) => key === currentAge.key,
    );
    let count = 0;
    for (const id of this.boughtResearch) {
      if (findResearchDefinition(id)?.age === ageIndex) count += 1;
    }
    return count;
  }

  /**
   * The cost of `count` sequential research purchases after the current bought
   * count. Priced by the **current** age's schedule (`base × factor^(√n − 1)`),
   * so a tech bought from an earlier age costs this same price and simply does
   * not advance the curve. Cost-reduction bonuses still apply on top.
   */
  getResearchCostForCount(count: number): BuildingCost[] {
    const purchases = Number.isFinite(count)
      ? Math.max(0, Math.floor(count))
      : 0;
    if (purchases === 0) return [];

    const schedule =
      this.getCurrentAge()?.research ??
      ({ base: ExpNumber.fromNumber(100), factor: 10 } as const);
    const bought = this.getResearchCount();

    // Research is a buyable like buildings and units, so it takes the same four
    // cost reductions — but only ones naming "research" (it is not a building, so
    // `allBuildings` never reaches it). They fold per unit in the §13.1 order:
    // base → factor → percent → flat, clamped at zero.
    const { reductions } = this.getResearchCostModifiers();
    const unitBase = ExpNumber.max(
      ExpNumber.ZERO,
      schedule.base.mul(reductions.base),
    );
    const unitFactor = ExpNumber.max(
      ExpNumber.fromNumber(1.01),
      ExpNumber.fromNumber(schedule.factor).pow(reductions.factor),
    );

    // Unit n costs base × factor^(√n − 1), where n is the purchase ordinal
    // within this age — so the first tech of an age costs exactly its base.
    let total = ExpNumber.ZERO;
    for (let offset = 0; offset < purchases; offset += 1) {
      const purchaseNumber = bought + offset + 1;
      const unitPrice = unitBase
        .mul(unitFactor.pow(Math.sqrt(purchaseNumber) - 1))
        .mul(reductions.percent);
      total = total.add(
        ExpNumber.max(ExpNumber.ZERO, unitPrice.sub(reductions.flat)),
      );
    }

    return [{ resource: "science", base: total, factor: 1 }];
  }

  /**
   * The cost of the next research purchase, on the current age's schedule. The
   * purchase ordinal starts at 1 within the age, so the first tech of an age
   * costs exactly that age's base.
   */
  getResearchNextCost(): BuildingCost[] {
    return this.getResearchCostForCount(1);
  }

  hasResourcesForResearch(): boolean {
    return this.getResearchNextCost().every(({ resource, base }) =>
      this.resources[resource].gte(base),
    );
  }

  getResearchFailureReason(researchId: string): "locked" | "resources" | null {
    if (!this.isResearchUnlocked(researchId)) return "locked";
    if (!this.hasResourcesForResearch()) return "resources";
    return null;
  }

  canBuyResearch(researchId: string): boolean {
    return this.getResearchFailureReason(researchId) === null;
  }

  buyResearch(researchId: string): CivilizationState {
    if (this.boughtResearch.includes(researchId)) return this;
    if (!this.canBuyResearch(researchId)) return this;
    const research = findResearchDefinition(researchId);
    const resources = { ...this.resources };
    const researchCost = this.getResearchNextCost();
    for (const { resource, base } of researchCost) {
      resources[resource] = resources[resource].sub(base);
    }
    // Apply the tech's unit conversions: every `ratio` owned units of `from`
    // become one unit of `to`; the remainder stays on the (now closed) line.
    let unitCounts = this.unitCounts;
    for (const { from, to, ratio } of research?.conversions ?? []) {
      const owned = unitCounts[from] ?? ExpNumber.ZERO;
      const converted = owned.div(ExpNumber.fromNumber(ratio)).floor();
      if (converted.lte(ExpNumber.ZERO)) continue;
      if (unitCounts === this.unitCounts) unitCounts = { ...this.unitCounts };
      unitCounts[from] = owned.sub(converted.mul(ExpNumber.fromNumber(ratio)));
      unitCounts[to] = (unitCounts[to] ?? ExpNumber.ZERO).add(converted);
    }
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.recordSpending(this.statistics, researchCost),
      unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      [...this.boughtResearch, researchId],
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
    // Trade routes need no step of their own: their gold and goods legs ride the
    // production factors this loop already applied.
    // One tick is one second of play time for both the lifetime counter and the
    // current run (a future prestige resets `runTimeMs` only).
    const activeStreakMs = this.statistics.activeStreakMs + tickMilliseconds;
    const statistics: Statistics = {
      ...this.statistics,
      playTimeMs: this.statistics.playTimeMs + tickMilliseconds,
      runTimeMs: this.statistics.runTimeMs + tickMilliseconds,
      onlineTimeMs: this.statistics.onlineTimeMs + tickMilliseconds,
      activeStreakMs,
      longestActiveMs: Math.max(
        this.statistics.longestActiveMs,
        activeStreakMs,
      ),
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
    )
      .recordCurrentAge()
      .checkAchievements();
  }

  /**
   * Per-second rate of every producer resource as one record. This is the input
   * the save system multiplies by the elapsed seconds to size offline gains.
   */
  getProductionRates(): Partial<Record<ResourceKey, ExpNumber>> {
    const rates: Partial<Record<ResourceKey, ExpNumber>> = {};
    for (const resourceKey of producerResourceKeys) {
      rates[resourceKey] = this.computeResourceRate(resourceKey);
    }
    return rates;
  }

  /** Offline efficiency after achievement bonuses, as a fraction of live gain. */
  getOfflineEfficiency(): number {
    let efficiency = ExpNumber.fromNumber(0.25);
    for (const [, bonus] of this.activeBonuses()) {
      if (bonus.destination !== "offlineEfficiency") continue;
      if (bonus.type === "attributeFlat")
        efficiency = efficiency.add(bonus.value);
      if (bonus.type === "attributeMultiplier")
        efficiency = efficiency.mul(bonus.value);
    }
    return Math.max(0, efficiency.toNumber());
  }

  /**
   * Credit offline production (roadmap Milestone 3). The amounts are already
   * scaled by the offline efficiency factor and capped by the save system, so
   * this is only the addition — and no play time is recorded, because the player
   * was not playing. Returns `this` when there is nothing to credit.
   */
  applyOfflineGain(gains: Record<string, ExpNumber>): CivilizationState {
    const resources = { ...this.resources };
    let changed = false;
    for (const [key, amount] of Object.entries(gains)) {
      if (!(key in resources)) continue;
      if (!amount || !amount.isFinite || amount.sign <= 0) continue;
      resources[key as ResourceKey] = resources[key as ResourceKey].add(amount);
      changed = true;
    }
    if (!changed) return this;
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
    ).checkAchievements();
  }

  /** Record one imported/offline gap without advancing active play time. */
  recordOfflineTime(elapsedMs: number): CivilizationState {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return this;
    const statistics: Statistics = {
      ...this.statistics,
      offlineTimeMs: this.statistics.offlineTimeMs + elapsedMs,
      longestOfflineMs: Math.max(this.statistics.longestOfflineMs, elapsedMs),
      activeStreakMs: 0,
    };
    return this.withStatistics(statistics);
  }

  /**
   * The share of `destination`'s per-second drains that still applies once every
   * active `removeDrain` bonus is taken into account. `value` is a fraction, so
   * `1` cancels a drain outright and `0.5` halves it; sources compound as
   * `Π(1 − N)` and clamp at 0, matching the `costReductionPercent` stacking rule
   * in AGENTS.md §13.1. Returns exactly `ExpNumber.ONE` when nothing removes
   * drains, which is the common case and costs one pass over the cached
   * `activeBonuses()` list.
   *
   * This is the "rewards are bonuses" rule doing the work: the famine
   * achievement ends the citizen food upkeep simply by being earned, with no
   * engine branch naming either the achievement or the `people` building.
   */
  private remainingDrainShare(destination: string): ExpNumber {
    let remaining = ExpNumber.ONE;
    for (const [, bonus] of this.activeBonuses()) {
      if (bonus.type !== "removeDrain") continue;
      if (bonus.destination !== destination) continue;
      const kept = ExpNumber.ONE.sub(bonus.value);
      if (kept.lte(ExpNumber.ZERO)) return ExpNumber.ZERO;
      remaining = remaining.mul(kept);
    }
    return remaining;
  }

  getFactors(resourceKey: ResourceKey): ResourceFactors {
    const factors = this.resourceFactors[resourceKey];
    // Production resources include worker-assignable resources (food, wood, stone, gold)
    // and building-generated resources (military, science, metalwork, trade)
    const isProductionKey = resourceKey in this.workers;
    const resourceLabels: Record<string, string> = {
      military: "Military",
      science: "Science",
      metalwork: "Metalwork",
      trade: "Trade",
    };
    const workerProduction = isProductionKey
      ? this.getWorkerProduction(resourceKey as ProductionResourceKey)
      : new WorkerProduction(
          resourceKey as ProductionResourceKey,
          resourceLabels[resourceKey] || resourceKey,
        );
    const buildingFactors: ResourceFactors = {
      additional: [],
      multiplicative: [],
      additiveMultiplier: [],
      drain: [],
    };
    let drainScale: ExpNumber | undefined;

    for (const building of buildingDefinitions) {
      const count = this.buildingCount(building.key);
      if (count === 0) continue;
      const effects = this.getBuildingEffects(building.key, count);
      for (const additiveMultiplier of effects.additiveMultiplier ?? []) {
        if (additiveMultiplier.resource === resourceKey) {
          buildingFactors.additiveMultiplier.push([
            building.key,
            additiveMultiplier.perBuilding,
          ]);
        }
      }
      for (const resourceDrain of effects.resourceDrain ?? []) {
        if (resourceDrain.resource === resourceKey) {
          // Resolved at most once per getFactors() call, and only when this
          // resource actually has a drain, so the common path stays free.
          drainScale ??= this.remainingDrainShare(resourceKey);
          const amount = resourceDrain.amount.mul(drainScale);
          if (amount.gt(ExpNumber.ZERO)) {
            buildingFactors.drain.push([building.key, amount]);
          }
        }
      }
      for (const resourceProduction of effects.resourceProduction ?? []) {
        if (resourceProduction.resource === resourceKey) {
          buildingFactors.additional.push([
            building.key,
            resourceProduction.amount,
          ]);
        }
      }
    }

    // Attribute bonuses from every source (upgrades, encounters, achievements)
    // land in the existing factor path (§13.6); drains from bonuses stay
    // unimplemented until data needs them.
    const bonusFactors: ResourceFactors = {
      additional: [],
      multiplicative: [],
      additiveMultiplier: [],
      drain: [],
    };
    for (const [sourceId, bonus] of this.activeBonuses()) {
      const targetsResource = String(bonus.destination) === resourceKey;
      const targetsAllProduction =
        bonus.destination === "allProduction" && isProductionKey;
      if (!targetsResource && !targetsAllProduction) continue;
      if (bonus.type === "attributeMultiplier") {
        bonusFactors.multiplicative.push([sourceId, bonus.value]);
      } else if (bonus.type === "attributeFlat") {
        bonusFactors.additional.push([sourceId, bonus.value]);
      }
    }

    const workerAdditional: ResourceFactor[] = [
      [workerProduction, workerProduction.workerProduction],
    ];
    if (
      workerProduction.autoClickProduction.gt(ExpNumber.ZERO) &&
      this.isResourceGatherable(resourceKey)
    ) {
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
      additiveMultiplier: [
        ...factors.additiveMultiplier,
        ...buildingFactors.additiveMultiplier,
        ...bonusFactors.additiveMultiplier,
      ],
      drain: [
        ...factors.drain,
        ...buildingFactors.drain,
        ...bonusFactors.drain,
      ],
    };
  }

  /**
   * The live rate of a resource with everything in it **except the trade route's
   * own rows**: workers, buildings, bonuses, the dev multiplier, the trade
   * multiplier, and every other drain — the citizen food upkeep among them.
   * Used for time skips, which apply production at this rate before routes run.
   */
  private baseProductionFactors(resourceKey: ResourceKey): ResourceFactors {
    const base = this.getFactors(resourceKey);
    const multiplicative = [...base.multiplicative];

    // Add dev production multiplier
    if (!this.devProductionMultiplier.eq(ExpNumber.ONE)) {
      multiplicative.push([
        "dev production multiplier",
        this.devProductionMultiplier,
      ] as ResourceFactor);
    }

    // Add trade production multiplier for production resources
    const isProductionKey = resourceKey in this.workers;
    if (isProductionKey && this.resources.trade.gt(ExpNumber.ZERO)) {
      const tradeMultiplier = calculateTradeMultiplier(this.resources.trade);
      if (!tradeMultiplier.eq(ExpNumber.ONE)) {
        multiplicative.push([
          "trade production multiplier",
          tradeMultiplier,
        ] as ResourceFactor);
      }
    }

    return {
      ...base,
      multiplicative,
    };
  }

  /**
   * Production factors for trade pricing: buildings, bonuses, multipliers, and drains,
   * but **excluding worker production** so players cannot sway the market by reassigning
   * workers. Trade routes are priced against these rates to prevent market manipulation.
   */
  private getTradePriceFactors(resourceKey: ResourceKey): ResourceFactors {
    const factors = this.resourceFactors[resourceKey];
    const isProductionKey = resourceKey in this.workers;
    const buildingFactors: ResourceFactors = {
      additional: [],
      multiplicative: [],
      additiveMultiplier: [],
      drain: [],
    };
    let drainScale: ExpNumber | undefined;

    for (const building of buildingDefinitions) {
      const count = this.buildingCount(building.key);
      if (count === 0) continue;
      const effects = this.getBuildingEffects(building.key, count);
      for (const additiveMultiplier of effects.additiveMultiplier ?? []) {
        if (additiveMultiplier.resource === resourceKey) {
          buildingFactors.additiveMultiplier.push([
            building.key,
            additiveMultiplier.perBuilding,
          ]);
        }
      }
      for (const resourceDrain of effects.resourceDrain ?? []) {
        if (resourceDrain.resource === resourceKey) {
          drainScale ??= this.remainingDrainShare(resourceKey);
          const amount = resourceDrain.amount.mul(drainScale);
          if (amount.gt(ExpNumber.ZERO)) {
            buildingFactors.drain.push([building.key, amount]);
          }
        }
      }
      for (const resourceProduction of effects.resourceProduction ?? []) {
        if (resourceProduction.resource === resourceKey) {
          buildingFactors.additional.push([
            building.key,
            resourceProduction.amount,
          ]);
        }
      }
    }

    const bonusFactors: ResourceFactors = {
      additional: [],
      multiplicative: [],
      additiveMultiplier: [],
      drain: [],
    };
    for (const [sourceId, bonus] of this.activeBonuses()) {
      const targetsResource = String(bonus.destination) === resourceKey;
      const targetsAllProduction =
        bonus.destination === "allProduction" && isProductionKey;
      if (!targetsResource && !targetsAllProduction) continue;
      if (bonus.type === "attributeMultiplier") {
        bonusFactors.multiplicative.push([sourceId, bonus.value]);
      } else if (bonus.type === "attributeFlat") {
        bonusFactors.additional.push([sourceId, bonus.value]);
      }
    }

    const multiplicative = [
      ...factors.multiplicative,
      ...buildingFactors.multiplicative,
      ...bonusFactors.multiplicative,
    ];

    // Add dev production multiplier
    if (!this.devProductionMultiplier.eq(ExpNumber.ONE)) {
      multiplicative.push([
        "dev production multiplier",
        this.devProductionMultiplier,
      ] as ResourceFactor);
    }

    // Add trade production multiplier for production resources
    if (isProductionKey && this.resources.trade.gt(ExpNumber.ZERO)) {
      const tradeMultiplier = calculateTradeMultiplier(this.resources.trade);
      if (!tradeMultiplier.eq(ExpNumber.ONE)) {
        multiplicative.push([
          "trade production multiplier",
          tradeMultiplier,
        ] as ResourceFactor);
      }
    }

    return {
      additional: [
        ...factors.additional,
        ...buildingFactors.additional,
        ...bonusFactors.additional,
      ],
      multiplicative,
      additiveMultiplier: [
        ...factors.additiveMultiplier,
        ...buildingFactors.additiveMultiplier,
        ...bonusFactors.additiveMultiplier,
      ],
      drain: [
        ...factors.drain,
        ...buildingFactors.drain,
        ...bonusFactors.drain,
      ],
    };
  }

  /**
   * The full production factors for a resource, trade routes included. Every leg a
   * route contributes is a drain row (see `tradeRouteFactor`), recomputed from the
   * current state on every read so it is replaced each tick rather than stacked.
   */
  getProductionFactors(resourceKey: ResourceKey): ResourceFactors {
    const base = this.baseProductionFactors(resourceKey);
    const rows = this.tradeRouteFactor(resourceKey);
    if (rows.length === 0) return base;
    return { ...base, drain: [...base.drain, ...rows] };
  }

  computeResourceRate(resourceKey: ResourceKey): ExpNumber {
    return computeResourceRate(this.getProductionFactors(resourceKey));
  }

  computeClickGain(resourceKey: ResourceKey): ExpNumber {
    if (!(resourceKey in this.workers)) return ExpNumber.ZERO;
    const factors = this.getProductionFactors(resourceKey);
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
      additiveMultiplier: factors.additiveMultiplier,
      drain: [],
    });
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
    // A building's power folds in the global `buildingPower` multiplier, so the
    // displayed value is the effective one (§13.2).
    if (buildingPowerAttributeDefinitions.some(({ key: pk }) => pk === key)) {
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
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
    );
  }

  getBuildingMax(buildingKey: string): ExpNumber {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return ExpNumber.ZERO;
    const capacity = capacityKey(building.key);
    // Effective capacity: the stored base amount plus capacity provided by other buildings,
    // then multiplied by every capacity multiplier in force (§13.7 decision 3).
    let max = this.resources[capacity];

    // Apply capacity multipliers
    for (const [, bonus] of this.activeBonuses()) {
      if (
        bonus.type === "attributeMultiplier" &&
        bonus.destination === capacity
      ) {
        max = max.mul(bonus.value);
      }
    }
    return capacitySlotCount(max);
  }

  /** Shared production/stat recap; the base remains distinct from bonus additions. */
  getModifierSummary(key: string) {
    const derived = this.getDerivedAttributeFactors(key);
    const factors = derived
      ? {
          additional: derived.additional,
          multiplicative: derived.multiplicative,
          additiveMultiplier: [],
          drain: [],
        }
      : this.getProductionFactors(key as ResourceKey);
    const totals = summarizeResourceFactors(factors);
    const base = derived?.base ?? ExpNumber.ZERO;
    return {
      ...totals,
      base,
      result: base
        .add(totals.additional)
        .mul(totals.totalMultiplier)
        .sub(totals.drain),
    };
  }

  /**
   * A production building's power stat (its `${key}Power` derived attribute). Base
   * 1; `attributeMultiplier` bonuses raise it. Buildings with no power attribute
   * (house, townHall, people) and any power that resolves to 0 read as 1 so the
   * exponent never collapses a building's output.
   */
  buildingPower(buildingKey: BuildingKey): ExpNumber {
    const value = this.getAttributeValue(`${buildingKey}Power`);
    return value.gt(ExpNumber.ZERO) ? value : ExpNumber.ONE;
  }

  /** Effective effects for one or more buildings, shared by simulation and Pedia. */
  getBuildingEffects(buildingKey: BuildingKey, count = 1): BuildingEffects {
    const effects = buildingDefinitions.find(
      ({ key }) => key === buildingKey,
    )?.effects;
    if (!effects) return {};
    const quantity = ExpNumber.fromNumber(count);
    const power = this.buildingPower(buildingKey);
    return {
      additiveMultiplier:
        effects.additiveMultiplier?.map((effect) => ({
          ...effect,
          // Exponent scaling: the summed per-building bonus is
          // (perBuilding x count)^power (user's farm formula, §13.1).
          perBuilding: effect.perBuilding.mul(quantity).pow(power),
        })) ?? undefined,
      resourceProduction:
        effects.resourceProduction?.map((effect) => ({
          ...effect,
          // Flat +N/s per building has no count curve, so power scales it linearly.
          amount: effect.amount.mul(quantity).mul(power),
        })) ?? undefined,
      resourceDrain:
        effects.resourceDrain?.map((effect) => ({
          ...effect,
          amount: effect.amount.mul(quantity),
        })) ?? undefined,
      capacityProvided:
        effects.capacityProvided?.map((effect) => ({
          ...effect,
          perBuilding: effect.perBuilding.mul(quantity),
        })) ?? undefined,
    };
  }

  /** Cost-reduction bonuses targeting one buyable, folded the §13.1 way. */
  private costReductionsFor(buyableId: string) {
    const isBuilding = buildingDefinitions.some(({ key }) => key === buyableId);
    const isResearch = buyableId === "research"; // Virtual building for research
    const unit = findUnitDefinition(buyableId);
    const targetMatches = (destination: string): boolean => {
      if (destination === buyableId) return true;
      // Research is not a building, so the blanket `allBuildings` discounts do
      // not reach it — only a bonus that names "research" explicitly does.
      if (isResearch) return false;
      if (isBuilding) return destination === "allBuildings";
      if (!unit) return destination === "allUnits";
      if (destination === "allUnits") return true;
      // `tag.<t>` and `domain.<d>` are group scopes, not content ids: a
      // research can name "every ground unit" without enumerating the roster.
      // `domain` is separate from `tag` because the battlefield domain is its
      // own field on a unit — no unit carries a "ground" tag.
      if (destination.startsWith("domain."))
        return unit.domain === destination.slice("domain.".length);
      return (
        destination.startsWith("tag.") &&
        unit.tags.includes(destination.slice(4))
      );
    };
    const sources = this.activeBonuses().filter(
      ([, bonus]) =>
        targetMatches(String(bonus.destination)) &&
        bonus.type.startsWith("costReduction"),
    );
    return {
      sources,
      reductions: collectCostReductions(sources.map(([, bonus]) => bonus)),
    };
  }

  getBuildingCostModifiers(buildingKey: string) {
    const { sources, reductions } = this.costReductionsFor(buildingKey);
    const globalMultiplier = ExpNumber.max(
      ExpNumber.ZERO,
      this.getAttributeValue("buildingCostMultiplier"),
    );
    return {
      sources,
      globalMultiplier,
      reductions: {
        ...reductions,
        base: reductions.base.mul(globalMultiplier),
      },
    };
  }

  /**
   * Research cost reductions. Research is not a building and not a unit, so it
   * takes **only** bonuses that name `"research"` explicitly: the blanket
   * `allBuildings` discounts and the global `buildingCostMultiplier` stat do not
   * apply to it. `globalMultiplier` is therefore always ×1 here.
   */
  getResearchCostModifiers() {
    const { sources, reductions } = this.costReductionsFor("research");
    return { sources, globalMultiplier: ExpNumber.ONE, reductions };
  }

  /** Units are buyables (§13.3), so they take the same four cost-reduction types. */
  getUnitCostModifiers(unitId: string) {
    return this.costReductionsFor(unitId);
  }

  /**
   * Per-unit pipeline inputs, shared by buildings, units and their previews.
   * `unitFactor` raises the growth factor to `reductions.factor` (the product of
   * every `costReductionFactor` power, bonus.ts), floored at 1.01. Raising to a
   * power scales the log-growth exponent by exactly that power on every factor.
   */
  private costParameters(
    costs: BuildingCost[],
    reductions: CostReductions,
  ): CostParameters[] {
    return costs.map((cost) => ({
      cost,
      unitBase: ExpNumber.max(ExpNumber.ZERO, cost.base.mul(reductions.base)),
      unitFactor: ExpNumber.max(
        ExpNumber.fromNumber(1.01),
        ExpNumber.fromNumber(cost.factor).pow(reductions.factor),
      ),
      reductions,
    }));
  }

  getBuildingCostParameters(buildingKey: string): CostParameters[] {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building) return [];
    const costs = this.buildingCostOverrides[building.key] ?? building.costs;
    const { reductions } = this.getBuildingCostModifiers(buildingKey);
    return this.costParameters(costs, reductions);
  }

  getUnitCostParameters(unitId: string): CostParameters[] {
    const unit = findUnitDefinition(unitId);
    if (!unit) return [];
    const { reductions } = this.getUnitCostModifiers(unitId);
    return this.costParameters(unit.costs, reductions);
  }

  getBuildingCost(
    buildingKey: string,
    buildingsAlreadyBuilt: number,
    count: number = 1,
  ): BuildingCost[] {
    return this.costSeries(
      this.getBuildingCostParameters(buildingKey),
      ExpNumber.fromNumber(buildingsAlreadyBuilt),
      count,
    );
  }

  /** Cost of the next `count` units, growing with the number already owned. */
  getUnitCost(unitId: string, count: number = 1): BuildingCost[] {
    return this.costSeries(
      this.getUnitCostParameters(unitId),
      this.getUnitCount(unitId),
      count,
    );
  }

  /**
   * Cost of `count` units from scratch (owned = 0), for the battle simulator's
   * "raise the army" totals. Public so dev-only UI can reuse the series
   * evaluator instead of re-implementing the cost pipeline.
   */
  costSeriesFrom(
    parameters: readonly CostParameters[],
    count: number,
  ): BuildingCost[] {
    return this.costSeries(parameters, ExpNumber.ZERO, count);
  }

  /** Simulates arbitrary stacks for the dev-only battle simulator. */
  simulateWithStacks(
    player: readonly ArmyStack[],
    enemy: readonly ArmyStack[],
  ): BattleSimulation {
    return simulateBattle(player, enemy);
  }

  simulateWithStacksOutcome(
    player: readonly ArmyStack[],
    enemy: readonly ArmyStack[],
  ): BattleOutcome {
    return simulateBattleOutcome(player, enemy);
  }

  /** Owned count of one unit (units have no capacity ceiling, §13.3). */
  getUnitCount(unitId: string): ExpNumber {
    return this.unitCounts[unitId] ?? ExpNumber.ZERO;
  }

  /**
   * Every unit-stat bonus aimed at one unit, split per stat into summed flats
   * and compounded multipliers — the §13.1 stacking rule applied to units.
   */
  private collectUnitStatFactors(
    unit: UnitDefinition,
    sources: readonly (readonly [sourceId: string, bonus: Bonus])[],
  ): Record<UnitStatKey, { flat: ExpNumber; multiplier: ExpNumber }> {
    const factors: Record<
      UnitStatKey,
      { flat: ExpNumber; multiplier: ExpNumber }
    > = {
      hp: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      attack: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      armor: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      range: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      speed: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
      accuracy: { flat: ExpNumber.ZERO, multiplier: ExpNumber.ONE },
    };
    for (const [, bonus] of sources) {
      if (
        bonus.type !== "attributeFlat" &&
        bonus.type !== "attributeMultiplier"
      )
        continue;
      const target = parseUnitStatTarget(bonus.destination);
      if (!target || !unitMatchesStatTarget(unit, target)) continue;
      const bucket = factors[target.stat];
      if (bonus.type === "attributeFlat")
        bucket.flat = bucket.flat.add(bonus.value);
      else bucket.multiplier = bucket.multiplier.mul(bonus.value);
    }
    return factors;
  }

  /** Base stats, then summed flats, then compounded multipliers — per stat. */
  private unitStatsFromFactors(
    unit: UnitDefinition,
    factors: Record<UnitStatKey, { flat: ExpNumber; multiplier: ExpNumber }>,
  ): UnitStats {
    const grown = (stat: UnitStatKey): ExpNumber => {
      const base =
        stat === "hp" || stat === "attack"
          ? unit.stats[stat]
          : ExpNumber.fromNumber(unit.stats[stat]);
      return ExpNumber.max(
        ExpNumber.ZERO,
        base.add(factors[stat].flat).mul(factors[stat].multiplier),
      );
    };
    const scalar = (stat: UnitStatKey, upper: number): number =>
      Math.min(upper, Math.max(0, grown(stat).toNumber()));
    return {
      hp: grown("hp"),
      attack: grown("attack"),
      armor: scalar("armor", maximumArmor),
      range: Math.max(0, grown("range").toNumber()),
      speed: Math.max(0, grown("speed").toNumber()),
      accuracy: scalar("accuracy", 1),
    };
  }

  /**
   * Cumulative cost of `count` units starting at `alreadyBuilt` (§4.4): unit n
   * costs C(n) - C(n-1), so one purchase is C(owned + count) - C(owned) — one
   * O(1) evaluator for buy-N and buy-MAX. C is a linear floor for the first K
   * units (unit 1 = base) then the corrected sqrt curve, so a unit never costs
   * less than the one before it.
   */
  private costSeries(
    parameters: readonly CostParameters[],
    buildingsAlreadyBuilt: ExpNumber,
    count: number,
  ): BuildingCost[] {
    const owned = buildingsAlreadyBuilt.toNumber();
    return parameters.map(({ cost, unitBase, unitFactor, reductions }) => {
      if (count <= 0) return { ...cost, base: ExpNumber.ZERO };

      // Piecewise cumulative (§4.4, corrected first unit): linear floor for the
      // first K units (unit 1 = base), then T(n) = unitBase * unitFactor^(sqrt(n) - 1).
      // Buying count units is one subtraction: C(owned + count) - C(owned).
      const crossover = crossoverToSqrt(unitBase, unitFactor);
      const slope = linearSlope(unitBase, unitFactor);
      const linearSum = (n: number): ExpNumber =>
        unitBase
          .mul(ExpNumber.fromNumber(n))
          .add(slope.mul(ExpNumber.fromNumber((n * (n - 1)) / 2)));
      const cumulative = (n: number): ExpNumber =>
        n <= crossover
          ? linearSum(n)
          : linearSum(crossover).add(
              sqrtCurve(unitBase, unitFactor, n).sub(
                sqrtCurve(unitBase, unitFactor, crossover),
              ),
            );
      const unitPrice = (n: number): ExpNumber =>
        cumulative(n)
          .sub(cumulative(n - 1))
          .mul(reductions.percent);

      // Leading units the flat reduction absorbs entirely are free; scan a
      // bounded window for them.
      let clamped = 0;
      if (reductions.flat.gt(ExpNumber.ZERO)) {
        const window = Math.min(count, flatClampWindow);
        while (clamped < window) {
          if (unitPrice(owned + clamped + 1).gt(reductions.flat)) break;
          clamped += 1;
        }
      }

      const remaining = count - clamped;
      const gross = cumulative(owned + count)
        .sub(cumulative(owned + clamped))
        .mul(reductions.percent);
      const payable = ExpNumber.max(
        ExpNumber.ZERO,
        gross.sub(reductions.flat.mul(ExpNumber.fromNumber(remaining))),
      );
      // Snap float-subtraction residue below a relative epsilon to the integer
      // before ceiling: cumulative(owned+count) - cumulative(owned) can land a
      // few ULP above an exact linear price (14.000000000000004), which .ceil()
      // would bump up a whole unit. Genuine fractions stay put (their residue
      // dwarfs the epsilon) and large magnitudes carry zero residue.
      const floored = payable.floor();
      const snapped = payable
        .sub(floored)
        .lte(
          ExpNumber.max(payable, ExpNumber.ONE).mul(ExpNumber.fromNumber(1e-9)),
        )
        ? floored
        : payable;
      return { ...cost, base: snapped.ceil() };
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

    // Slots are discrete: floor the capacity headroom so a float residue in the
    // capacity (see wholeSlots) can never become a fractional MAX answer.
    const capacityLimit = wholeSlots(this.getBuildingMax(building.key));
    const currentCount = this.buildingCount(building.key);
    let maxPossible =
      capacityLimit > 0 ? Math.max(0, capacityLimit - currentCount) : Infinity;

    if (buildingKey === "people") {
      maxPossible = Math.min(
        maxPossible,
        Math.max(
          0,
          wholeSlots(this.maximumPopulation) - wholeSlots(this.population),
        ),
      );
    }

    // Dev-tools free mode: capacity still gates, but every in-capacity count is
    // affordable — the next cost stays displayed while the purchase skips payment.
    const canAffordCount = (n: number): boolean =>
      this.freeBuildings ||
      this.getBuildingCost(building.key, currentCount, n).every(
        ({ resource, base }) => this.resources[resource].gte(base),
      );

    // Upper bound: capacity-limited. Enhancer tiers push capacity to 1e9 by the
    // endgame, so allow the full range; the doubling probe stays O(log N).
    return maxAffordableCount(
      canAffordCount,
      Math.min(
        maxPossible === Infinity ? 1_000_000_000 : maxPossible,
        1_000_000_000,
      ),
    );
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
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
    );
  }

  upgradeBuildingCosts(
    buildingKey: BuildingKey,
    costs: BuildingCost[],
  ): CivilizationState {
    return this.withState(
      this.resources,
      {
        ...this.buildingCostOverrides,
        [buildingKey]: costs,
      },
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
    );
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
    if (count >= wholeSlots(this.getBuildingMax(building.key))) return true;
    if (buildingKey === "people" && this.population.gte(this.maximumPopulation))
      return true;
    return false;
  }

  /**
   * A purchase count as a whole number of things purchased.
   *
   * A building and a unit are each a whole thing, so every path that prices or
   * applies a count goes through this rather than trusting the caller's number.
   * `build()` has always floored its own count; the unit side did not, which let a
   * fractional recruit reach `unitCounts`, persist, and permanently offset every
   * later army comparison (`getUnitCount` reporting 4.7 warriors, with a shortfall
   * that can never be recruited away).
   *
   * Deliberately a plain floor, matching `build()` rather than the round-up
   * `capacitySlotCount` uses. That round-up is right for a *capacity* — a capacity
   * of 4.4e2 re-reads a few ULP high and must not lose a slot — but wrong for a
   * purchase: the residue between a full count and a full capacity is 5.68e-14 of
   * headroom, and rounding that up would buy a building or a recruit out of float
   * dust. Flooring also means `0.9999999999999999` reads as zero, which is what
   * `build()` has always done.
   */
  private wholeCount(count: number): number {
    return Number.isFinite(count) ? Math.floor(count) : 0;
  }

  hasResourcesForBuilding(buildingKey: string, count: number = 1): boolean {
    if (this.freeBuildings) return true;
    const whole = this.wholeCount(count);
    // Zero is a legitimate no-op query: it prices an empty cost list, which every
    // resource trivially affords. Only a negative or non-finite count is nonsense.
    // (A fractional request floors here, so "half a farm" reads as none.)
    if (whole < 0) return false;
    const currentCount = this.buildingCount(buildingKey);
    return this.getBuildingCost(buildingKey, currentCount, whole).every(
      ({ resource, base }) => this.resources[resource].gte(base),
    );
  }

  isBuildingAvailable(buildingKey: string): boolean {
    const building = buildingDefinitions.find(({ key }) => key === buildingKey);
    if (!building || !building.available) return false;
    const { unlock } = building;
    if (!unlock) return true;
    switch (unlock.source) {
      case "buildingCount":
        return this.buildingCount(unlock.building) >= unlock.threshold;
      case "battle":
        return this.defeatedEncounters.includes(unlock.encounterId);
      case "age":
        return this.isAgeUnlocked(unlock.ageId);
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
    if (currentCount + count > wholeSlots(this.getBuildingMax(building.key)))
      return "capacity";
    if (
      buildingKey === "people" &&
      wholeSlots(this.population) + count > wholeSlots(this.maximumPopulation)
    )
      return "capacity";

    if (!this.hasResourcesForBuilding(building.key, count)) return "resources";

    return null;
  }

  build(buildingKey: string, count: number = 1): CivilizationState {
    // A building is a whole thing: refuse a fractional count outright rather
    // than writing the fraction into `builtBuildings`, where it would persist
    // and permanently offset every later capacity comparison.
    const wholeCount = Math.floor(count);
    if (wholeCount <= 0 || !Number.isFinite(wholeCount)) return this;
    count = wholeCount;
    if (!this.canBuild(buildingKey, count)) return this;
    const builtCount = this.buildingCount(buildingKey);
    const cost = this.freeBuildings
      ? []
      : this.getBuildingCost(buildingKey, builtCount, count);

    const resources = { ...this.resources };
    for (const { resource, base } of cost) {
      resources[resource] = resources[resource].sub(base);
    }

    if (buildingKey === "people") {
      resources.population = resources.population.add(
        ExpNumber.fromNumber(count),
      );
    }
    for (const effect of buildingDefinitions.find(
      ({ key }) => key === buildingKey,
    )?.effects.capacityProvided ?? []) {
      const targetKey = capacityKey(effect.building);
      resources[targetKey] = resources[targetKey].add(
        effect.perBuilding.mul(ExpNumber.fromNumber(count)),
      );
    }

    const newBuildings = { ...this.builtBuildings };
    newBuildings[buildingKey as BuildingKey] =
      (newBuildings[buildingKey as BuildingKey] ?? 0) + count;

    return this.withState(
      resources,
      this.buildingCostOverrides,
      newBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.recordSpending(
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
        cost,
      ),
    );
  }

  canBuild(buildingKey: string, count: number = 1): boolean {
    if (!this.isBuildingAvailable(buildingKey)) return false;
    if (this.isBuildingAtCapacity(buildingKey)) return false;
    if (!this.hasResourcesForBuilding(buildingKey, count)) return false;
    return true;
  }

  private buildingCount(buildingKey: string): number {
    return this.builtBuildings[buildingKey as BuildingKey] ?? 0;
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
   * Open-ended hoarder tiers collapse into one summed `attributeFlat` per chain —
   * additive stacking (§13.7 decision 1) makes the math identical — under the
   * source id `<family>-total`, so the factor list stays one row per chain and
   * links the aggregate Gamepedia entry.
   */
  private earnedAchievementBonuses(): [achievementId: string, bonus: Bonus][] {
    const results: [achievementId: string, bonus: Bonus][] = [];
    for (const achievementId of this.earnedAchievements) {
      if (chainFamilyForId(achievementId)) continue;
      const definition = findAchievementDefinition(achievementId);
      for (const bonus of definition?.bonuses ?? []) {
        results.push([achievementId, bonus]);
      }
    }
    for (const chain of openEndedHoarderChains) {
      const prefix = `${chain.family}-e`;
      let total = ExpNumber.ZERO;
      let earned = false;
      for (const achievementId of this.earnedAchievements) {
        if (!achievementId.startsWith(prefix)) continue;
        earned = true;
        for (const bonus of findAchievementDefinition(achievementId)?.bonuses ??
          []) {
          if (
            bonus.type === "attributeFlat" &&
            bonus.destination === chain.resource
          ) {
            total = total.add(bonus.value);
          }
        }
      }
      if (earned && !total.isZero) {
        results.push([
          `${chain.family}-total`,
          { type: "attributeFlat", destination: chain.resource, value: total },
        ]);
      }
    }
    return results;
  }

  /**
   * Every bonus currently in force, paired with its source id. One seam for all
   * bonus sources keeps capacities, costs and stats on the same application path.
   * Cached on the identity of the four source id lists: rebuilt once per real
   * change, reused by every query in between (see the module cache note). Age bonuses
   * are derived from `enteredAges` (permanent entries) the same way research/encounters
   * derive from their bought/defeated lists.
   */
  private activeBonuses(): [sourceId: string, bonus: Bonus][] {
    let byUpgrades = activeBonusCaches.get(this.boughtUpgrades);
    if (!byUpgrades) {
      byUpgrades = new WeakMap<
        readonly string[],
        WeakMap<
          readonly string[],
          WeakMap<
            readonly string[],
            WeakMap<readonly string[], ActiveBonusList>
          >
        >
      >();
      activeBonusCaches.set(this.boughtUpgrades, byUpgrades);
    }
    let byEncounters = byUpgrades.get(this.defeatedEncounters);
    if (!byEncounters) {
      byEncounters = new WeakMap<
        readonly string[],
        WeakMap<readonly string[], WeakMap<readonly string[], ActiveBonusList>>
      >();
      byUpgrades.set(this.defeatedEncounters, byEncounters);
    }
    let byAchievements = byEncounters.get(this.earnedAchievements);
    if (!byAchievements) {
      byAchievements = new WeakMap<
        readonly string[],
        WeakMap<readonly string[], ActiveBonusList>
      >();
      byEncounters.set(this.earnedAchievements, byAchievements);
    }
    let byResearch = byAchievements.get(this.boughtResearch);
    if (!byResearch) {
      byResearch = new WeakMap<readonly string[], ActiveBonusList>();
      byAchievements.set(this.boughtResearch, byResearch);
    }
    const cached = byResearch.get(this.enteredAges);
    if (cached) return cached;
    const computed: [sourceId: string, bonus: Bonus][] = [
      ...this.boughtUpgradeBonuses(),
      ...this.defeatedEncounterBonuses(),
      ...this.earnedAchievementBonuses(),
      ...this.boughtResearchBonuses(),
      ...this.enteredAgeBonuses(),
    ];
    byResearch.set(this.enteredAges, computed);
    return computed;
  }

  /**
   * Bonuses from bought researches, paired with the research id as the source.
   * Derived from the bought id list, never stored as applied values (§13.4).
   */
  private boughtResearchBonuses(): [researchId: string, bonus: Bonus][] {
    const results: [researchId: string, bonus: Bonus][] = [];
    for (const researchId of this.boughtResearch) {
      const definition = findResearchDefinition(researchId);
      for (const bonus of definition?.bonuses ?? []) {
        results.push([researchId, bonus]);
      }
    }
    return results;
  }

  /**
   * Apply a batch of attribute bonuses (flat/multiplier/drain) to the resource factor
   * model, threading the accumulator through addFactor() calls. Used by enterAge() so age
   * bonuses flow into getFactors()/getBuildingMax() via activeBonuses() without aliasing
   * `this` (which the lint config forbids).
   */
  private applyAttributeBonuses(
    bonuses: readonly Bonus[],
    sourceId: string,
    state: CivilizationState,
  ): CivilizationState {
    let acc = state;
    for (const bonus of bonuses) {
      const factorType =
        bonus.type === "attributeFlat"
          ? "additional"
          : bonus.type === "attributeMultiplier"
            ? "multiplicative"
            : "drain";
      // Only resource and capacity destinations belong in the factor model.
      // Derived stats (clickPower, buildingPower, ...) are computed from
      // activeBonuses() by getDerivedAttributeFactors(), so they must not be
      // pushed here — they have no resourceFactors bucket.
      if (acc.resourceFactors[bonus.destination as ResourceKey] === undefined)
        continue;
      acc = acc.addFactor(
        bonus.destination as Parameters<typeof acc.addFactor>[0],
        factorType,
        [sourceId, bonus.value],
      );
    }
    return acc;
  }

  /**
   * Bonuses from entered ages, paired with the age id as the source.
   * Derived from the entered id list, never stored as applied values (§13.4).
   * Ages are permanent entries, so these persist for the life of the state.
   */
  private enteredAgeBonuses(): [ageId: string, bonus: Bonus][] {
    const results: [ageId: string, bonus: Bonus][] = [];
    for (const ageId of this.enteredAges) {
      const age = findAgeDefinition(ageId);
      for (const bonus of age?.bonuses ?? []) {
        results.push([ageId, bonus]);
      }
    }
    return results;
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
    return this.earnedAchievementSet().has(achievementId);
  }

  /** O(1) membership via a Set cached on the earned id list's identity. */
  private earnedAchievementSet(): Set<string> {
    let set = earnedAchievementSets.get(this.earnedAchievements);
    if (!set) {
      set = new Set(this.earnedAchievements);
      earnedAchievementSets.set(this.earnedAchievements, set);
    }
    return set;
  }

  /** Can the player buy this unit: base-available, unlocked by a won battle or
   *  a bought research — minus lines a bought research has closed. */
  isUnitAvailable(unitId: string): boolean {
    const unit = findUnitDefinition(unitId);
    if (!unit || !isBuyableUnit(unit)) return false;
    if (
      researchesClosingUnit(unitId).some((research) =>
        this.boughtResearch.includes(research.key),
      )
    ) {
      return false;
    }
    if (unit.available) return true;
    if (
      researchesUnlockingUnit(unitId).some((research) =>
        this.boughtResearch.includes(research.key),
      )
    ) {
      return true;
    }
    return false;
  }

  /** The Army tab's buyable roster: current + previous age, unlocked only. */
  getRosterUnits(): UnitDefinition[] {
    const currentAge = this.getCurrentAge();
    if (!currentAge) return [];
    const currentAgeIndex = ageDefinitions.findIndex(
      (a) => a.key === currentAge.key,
    );
    return unitDefinitions.filter(
      (unit) =>
        isBuyableUnit(unit) &&
        this.isUnitAvailable(unit.key) &&
        unit.age >= currentAgeIndex - 1 &&
        unit.age <= currentAgeIndex,
    );
  }

  hasResourcesForUnit(unitId: string, count: number = 1): boolean {
    if (this.freeUnits) return true;
    const whole = this.wholeCount(count);
    // Zero is a legitimate no-op query — it prices an empty cost list. Only a
    // negative or non-finite count is nonsense.
    if (whole < 0) return false;
    return this.getUnitCost(unitId, whole).every(({ resource, base }) =>
      this.resources[resource].gte(base),
    );
  }

  getUnitFailureReason(
    unitId: string,
    count: number = 1,
  ): "locked" | "resources" | null {
    if (!this.isUnitAvailable(unitId)) return "locked";
    if (!this.hasResourcesForUnit(unitId, count)) return "resources";
    return null;
  }

  canBuyUnit(unitId: string, count: number = 1): boolean {
    return this.getUnitFailureReason(unitId, count) === null;
  }

  /** Buy-MAX for units (no capacity cap): the shared O(log n) probe. */
  getMaxAffordableUnits(unitId: string): number {
    if (!this.isUnitAvailable(unitId)) return 0;
    return maxAffordableCount(
      (n) => this.hasResourcesForUnit(unitId, n),
      maximumUnitPurchase,
    );
  }

  buyUnit(unitId: string, count: number = 1): CivilizationState {
    const whole = this.wholeCount(count);
    if (whole <= 0 || !this.canBuyUnit(unitId, whole)) return this;
    const cost = this.freeUnits ? [] : this.getUnitCost(unitId, whole);
    const resources = { ...this.resources };
    for (const { resource, base } of cost) {
      resources[resource] = resources[resource].sub(base);
    }
    return this.withResources(resources).withUnitCount(
      unitId,
      this.getUnitCount(unitId).add(ExpNumber.fromNumber(whole)),
      this.recordSpending(this.statistics, cost),
    );
  }

  /**
   * Folds a cost list into the lifetime `resourcesSpent` tally, so every purchase
   * path records what it paid. A free purchase passes an empty cost list and so
   * adds nothing, which is what the dev `free*` switches expect. The input
   * statistics object is returned untouched when nothing was paid, so a
   * no-op purchase keeps referential equality with the previous state.
   */
  private recordSpending(
    statistics: Statistics,
    costs: readonly BuildingCost[],
  ): Statistics {
    if (costs.length === 0) return statistics;
    const resourcesSpent = { ...statistics.resourcesSpent };
    for (const { resource, base } of costs) {
      resourcesSpent[resource] = (
        resourcesSpent[resource] ?? ExpNumber.ZERO
      ).add(base);
    }
    return { ...statistics, resourcesSpent };
  }

  /** The player's army as battle stacks, with every bonus in force applied. */
  getArmyStacks(): ArmyStack[] {
    const stacks: ArmyStack[] = [];
    for (const unit of unitDefinitions) {
      const count = this.getUnitCount(unit.key);
      if (count.lte(ExpNumber.ZERO)) continue;
      const stats = this.getUnitStats(unit.key);
      if (stats) {
        stacks.push({
          unitId: unit.key,
          count,
          stats,
          order: this.getUnitOrder(unit.key),
          formation: this.getUnitFormation(unit.key),
        });
      }
    }
    return stacks;
  }

  /** The order a unit type fights under; `standard` when none is set. */
  getUnitOrder(unitId: string): BattleOrder {
    const order = this.unitOrders[unitId];
    return order && this.isOrderUnlocked(order) ? order : standardOrder;
  }

  /** Every order the player's current age has discovered. */
  getAvailableOrders(): readonly BattleOrder[] {
    const currentAge = this.getCurrentAge();
    // Before the first age is entered the player still fights the opening battle,
    // which is standard-only, so an unknown age falls back to age 0.
    const ageIndex = currentAge
      ? ageDefinitions.findIndex(({ key }) => key === currentAge.key)
      : 0;
    return ordersForAge(ageIndex < 0 ? 0 : ageIndex);
  }

  /** Orders are a classical-age discovery, gated by the age the player has reached. */
  isOrderUnlocked(order: BattleOrder): boolean {
    return this.getAvailableOrders().includes(order);
  }

  /**
   * Set (or clear, with `standard`) the order a unit type fights under. Returns
   * `this` unchanged for an unknown unit, a locked order, or a no-op change, so
   * callers can test `next === state`.
   */
  setUnitOrder(unitId: string, order: BattleOrder): CivilizationState {
    if (!findUnitDefinition(unitId) || !this.isOrderUnlocked(order))
      return this;
    if (order === standardOrder) {
      if (this.unitOrders[unitId] === undefined) return this;
      const { [unitId]: _removed, ...rest } = this.unitOrders;
      return this.withState(
        this.resources,
        this.buildingCostOverrides,
        this.builtBuildings,
        this.autoClicksPerSecond,
        this.boughtUpgrades,
        this.defeatedEncounters,
        this.enteredAges,
        this.earnedAchievements,
        this.statistics,
        this.unitCounts,
        this.devProductionMultiplier,
        this.freeBuildings,
        this.freeUnits,
        this.freeUpgrades,
        this.boughtResearch,
        rest,
        this.unitFormations,
      );
    }
    if (this.unitOrders[unitId] === order) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      { ...this.unitOrders, [unitId]: order },
      this.unitFormations,
      this.tradeRoutes,
    );
  }

  /** The formation a unit type uses; `standard` when none is set. */
  getUnitFormation(unitId: string): FormationId {
    const formation = this.unitFormations[unitId];
    return formation && this.isFormationUnlocked(formation)
      ? formation
      : DEFAULT_FORMATION;
  }

  /** Every formation the player's current age has discovered. */
  getAvailableFormations(): readonly FormationId[] {
    const currentAge = this.getCurrentAge();
    const ageIndex = currentAge
      ? ageDefinitions.findIndex(({ key }) => key === currentAge.key)
      : 0;
    return formationsForAge(ageIndex);
  }

  /** Whether a formation is unlocked for the current age. */
  isFormationUnlocked(formation: FormationId): boolean {
    return this.getAvailableFormations().includes(formation);
  }

  /**
   * Set (or clear, with `standard`) the formation a unit type uses. Returns
   * `this` unchanged for an unknown unit, a locked formation, or a no-op change.
   */
  setUnitFormation(unitId: string, formation: FormationId): CivilizationState {
    if (!findUnitDefinition(unitId) || !this.isFormationUnlocked(formation))
      return this;
    if (formation === DEFAULT_FORMATION) {
      if (this.unitFormations[unitId] === undefined) return this;
      const { [unitId]: _removed, ...rest } = this.unitFormations;
      return this.withState(
        this.resources,
        this.buildingCostOverrides,
        this.builtBuildings,
        this.autoClicksPerSecond,
        this.boughtUpgrades,
        this.defeatedEncounters,
        this.enteredAges,
        this.earnedAchievements,
        this.statistics,
        this.unitCounts,
        this.devProductionMultiplier,
        this.freeBuildings,
        this.freeUnits,
        this.freeUpgrades,
        this.boughtResearch,
        this.unitOrders,
        rest,
        this.unitFormations,
      );
    }
    if (this.unitFormations[unitId] === formation) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      { ...this.unitFormations, [unitId]: formation },
      this.tradeRoutes,
    );
  }

  getArmyPower(): ExpNumber {
    return armyPower(this.getArmyStacks());
  }

  /** Effective stats of one unit, with every active bonus applied. */
  getUnitStats(unitId: string): UnitStats | undefined {
    return this.getUnitStatsWithResearch(unitId, []);
  }

  getUnitStatsWithResearch(
    unitId: string,
    researchIds: readonly string[],
  ): UnitStats | undefined {
    const unit = findUnitDefinition(unitId);
    if (!unit) return undefined;
    const researchSources = researchBonusesForIds(
      researchIds.filter((id) => !this.boughtResearch.includes(id)),
    );
    return this.unitStatsFromFactors(
      unit,
      this.collectUnitStatFactors(unit, [
        ...this.activeBonuses(),
        ...researchSources,
      ]),
    );
  }

  /** Enemy armies receive all prior-age research, the unlock path for their units,
   * and every tech from the current age if the encounter is a boss. */
  getEnemyStacks(
    encounterId: string,
    additionalResearchIds: readonly string[] = [],
  ): ArmyStack[] {
    const encounter = findEncounterDefinition(encounterId);
    if (!encounter) return [];
    const researchIds = [
      ...researchIdsForBattle(
        encounter.age,
        encounter.enemyArmy.map(({ unitId }) => unitId),
        encounter.isBoss,
      ),
      ...additionalResearchIds,
    ];
    const boosts = [...researchBonusesForIds(researchIds)];
    const stacks: ArmyStack[] = [];
    for (const { unitId, count } of encounter.enemyArmy) {
      const unit = findUnitDefinition(unitId);
      if (!unit) continue;
      const stats = this.unitStatsFromFactors(
        unit,
        this.collectUnitStatFactors(unit, boosts),
      );
      stacks.push({ unitId, count: ExpNumber.fromNumber(count), stats });
    }
    return stacks;
  }

  /** The next battle the campaign offers: the first not-yet-won encounter in the
   *  current age only. Battles outside the current age are never offered. */
  getNextBattle(): EncounterDefinition | undefined {
    const currentAge = this.getCurrentAge();
    if (!currentAge) return undefined;
    const currentAgeIndex = ageDefinitions.findIndex(
      (a) => a.key === currentAge.key,
    );
    return encounterDefinitions.find(
      (encounter) =>
        encounter.age === currentAgeIndex &&
        !this.defeatedEncounters.includes(encounter.key),
    );
  }

  /** Whether more battles exist but are locked behind entering the next age. */
  hasLockedBattles(): boolean {
    return encounterDefinitions.some(
      (encounter) =>
        !this.defeatedEncounters.includes(encounter.key) &&
        !this.isAgeUnlocked(`age${encounter.age}`),
    );
  }

  /** Runs the fight without touching state so the UI can play it back. */
  simulateEncounter(encounterId: string): BattleSimulation | undefined {
    const encounter = findEncounterDefinition(encounterId);
    if (!encounter) return undefined;
    // Battles outside the current age cannot be fought.
    const currentAge = this.getCurrentAge();
    if (!currentAge) return undefined;
    const currentAgeIndex = ageDefinitions.findIndex(
      (a) => a.key === currentAge.key,
    );
    if (encounter.age !== currentAgeIndex) return undefined;
    const player = this.getArmyStacks();
    const enemy = this.getEnemyStacks(encounterId);
    if (player.length === 0 || enemy.length === 0) return undefined;
    return simulateBattle(player, enemy);
  }

  simulateEncounterOutcome(encounterId: string): BattleOutcome | undefined {
    const encounter = findEncounterDefinition(encounterId);
    if (!encounter) return undefined;
    const currentAge = this.getCurrentAge();
    if (!currentAge) return undefined;
    const currentAgeIndex = ageDefinitions.findIndex(
      (age) => age.key === currentAge.key,
    );
    if (encounter.age !== currentAgeIndex) return undefined;
    const player = this.getArmyStacks();
    const enemy = this.getEnemyStacks(encounterId);
    if (player.length === 0 || enemy.length === 0) return undefined;
    return simulateBattleOutcome(player, enemy);
  }

  /**
   * Applies a finished battle: a player win records the victory (and its
   * unlocks); a loss or stalemate changes nothing. Casualties never persist —
   * `unitCounts` is untouched, so armies are restored after every battle.
   */
  resolveBattle(
    encounterId: string,
    simulation?: BattleSimulation,
  ): CivilizationState {
    if (this.defeatedEncounters.includes(encounterId)) return this;
    const encounter = findEncounterDefinition(encounterId);
    if (!encounter) return this;
    // Battles outside the current age cannot be fought.
    const currentAge = this.getCurrentAge();
    if (!currentAge) return this;
    const currentAgeIndex = ageDefinitions.findIndex(
      (a) => a.key === currentAge.key,
    );
    if (encounter.age !== currentAgeIndex) return this;
    const result = simulation ?? this.simulateEncounter(encounterId);
    if (!result || result.outcome !== "player") return this;
    const finalRound = result.rounds[result.rounds.length - 1];
    const survivingPlayerUnitIds = (finalRound?.player ?? [])
      .filter(({ count }) => count.gt(ExpNumber.ZERO))
      .map(({ unitId }) => unitId);
    return this.defeatEncounter(encounterId).checkAchievements({
      encounterId,
      survivingPlayerUnitIds,
    });
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

  /** Records the first time the ordered age progression reaches its current age. */
  private recordCurrentAge(): CivilizationState {
    const age = this.getCurrentAge();
    if (!age || this.statistics.fastestAgeMs[age.key] !== undefined)
      return this;
    return this.withStatistics({
      ...this.statistics,
      fastestAgeMs: this.recordFastest(this.statistics.fastestAgeMs, age.key),
    });
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
      case "buildingCount":
        return ExpNumber.fromNumber(this.buildingCount(requirement.building));
      case "buildingsTotal":
        return this.statistics.buildingsBuilt;
      case "encounter":
        return this.defeatedEncounters.includes(requirement.encounterId)
          ? ExpNumber.ONE
          : ExpNumber.ZERO;
      case "battle":
        // A battle-shape condition is historical, not a live resource reading.
        return ExpNumber.ZERO;
      case "upgradeCount":
        return ExpNumber.fromNumber(this.boughtUpgrades.length);
      case "offlineTime":
        return ExpNumber.fromNumber(this.statistics.longestOfflineMs);
      case "activeTime":
        return ExpNumber.fromNumber(this.statistics.longestActiveMs);
      default:
        return ExpNumber.ZERO;
    }
  }

  private requirementThreshold(requirement: AchievementRequirement): ExpNumber {
    switch (requirement.type) {
      case "resource":
      case "population":
      case "clicks":
        return requirement.amount;
      case "buildingCount":
      case "buildingsTotal":
        return ExpNumber.fromNumber(requirement.count);
      case "encounter":
      case "battle":
        return ExpNumber.ONE;
      case "upgradeCount":
        return ExpNumber.fromNumber(requirement.count);
      case "offlineTime":
      case "activeTime":
        return ExpNumber.fromNumber(requirement.amount);
      default:
        return ExpNumber.ZERO;
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
    const earned = this.earnedAchievementSet();
    const concrete = achievementDefinitions
      .filter(({ family: achievementFamily }) => achievementFamily === family)
      .sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
    const nextTier = concrete.find(({ key }) => !earned.has(key));
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
      const endExponent =
        chain.startExponent +
        Math.floor((heldExponent - chain.startExponent) / chain.exponentStep) *
          chain.exponentStep;
      if (!Number.isSafeInteger(endExponent) || exponent > endExponent)
        continue;
      const count = (endExponent - exponent) / chain.exponentStep + 1;
      if (count > 1000) {
        newlyEarned.push(
          `${chain.family}-e${exponent}-through-e${endExponent}`,
        );
        continue;
      }
      for (; exponent <= endExponent; exponent += chain.exponentStep) {
        newlyEarned.push(`${chain.family}-e${exponent}`);
      }
    }
    return newlyEarned;
  }

  private meetsRequirement(
    requirement: AchievementRequirement,
    battle?: BattleAchievementContext,
  ): boolean {
    switch (requirement.type) {
      case "resource":
        return this.resources[requirement.resource].gte(requirement.amount);
      case "population":
        return this.resources.population.gte(requirement.amount);
      case "clicks":
        return this.statistics.productionClicks.gte(requirement.amount);
      case "buildingCount":
        return this.buildingCount(requirement.building) >= requirement.count;
      case "buildingsTotal":
        return this.statistics.buildingsBuilt.gte(
          ExpNumber.fromNumber(requirement.count),
        );
      case "encounter":
        return this.defeatedEncounters.includes(requirement.encounterId);
      case "battle":
        return (
          battle?.encounterId === requirement.encounterId &&
          battle.survivingPlayerUnitIds.length > 0 &&
          battle.survivingPlayerUnitIds.every(
            (unitId) =>
              findUnitDefinition(unitId)?.domain === requirement.unitDomain,
          )
        );
      case "upgradeCount":
        return this.boughtUpgrades.length >= requirement.count;
      case "offlineTime":
        return this.statistics.longestOfflineMs >= requirement.amount;
      case "activeTime":
        return this.statistics.longestActiveMs >= requirement.amount;
      case "famine":
        // A one-time historical record, like every other achievement: the
        // requirement is a conjunction and is recorded the first tick it holds.
        return (
          this.resources[requirement.resource].lte(requirement.amount) &&
          this.computeResourceRate(requirement.resource).lt(ExpNumber.ZERO) &&
          this.resources.population.gte(requirement.population)
        );
      default:
        return false;
    }
  }

  /**
   * Records every achievement whose requirement is met, once. `battle` is
   * supplied only while resolving the event that an army-shape requirement
   * describes. Earned ids are the only achievement data in state – never
   * applied bonuses – so migrations and re-balancing stay safe (roadmap
   * Milestone 6). Returns `this` when nothing is new.
   */
  checkAchievements(battle?: BattleAchievementContext): CivilizationState {
    const earned = this.earnedAchievementSet();
    const newlyEarned = [
      ...achievementDefinitions
        .filter(
          ({ key, requirement }) =>
            !earned.has(key) && this.meetsRequirement(requirement, battle),
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
    return this.withState(
      resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
    );
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
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
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
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
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
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
    );
  }

  private withUnitCount(
    unitId: string,
    count: ExpNumber,
    statistics = this.statistics,
  ): CivilizationState {
    const unitCounts = { ...this.unitCounts };
    // Snap on write, not on read: `ExpNumber.add` drifts, so an accumulated
    // count arrives here as 1218.999999999962. Correcting at the boundary keeps
    // `getUnitCount` integral and stops the residue reaching a save.
    const whole = snapToWholeCount(count);
    if (whole.lte(ExpNumber.ZERO)) delete unitCounts[unitId];
    else unitCounts[unitId] = whole;
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
      unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
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
    unitCounts = this.unitCounts,
    devProductionMultiplier = this.devProductionMultiplier,
    freeBuildings = this.freeBuildings,
    freeUnits = this.freeUnits,
    freeUpgrades = this.freeUpgrades,
    boughtResearch = this.boughtResearch,
    unitOrders = this.unitOrders,
    unitFormations = this.unitFormations,
    tradeRoutes = this.tradeRoutes,
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
      unitCounts,
      devProductionMultiplier,
      freeBuildings,
      freeUnits,
      freeUpgrades,
      boughtResearch,
      unitOrders,
      unitFormations,
      tradeRoutes,
    );
  }

  /** Dev-tools: global production multiplier (×N on every producer rate). */
  setDevProductionMultiplier(multiplier: ExpNumber): CivilizationState {
    const value =
      multiplier.isFinite && !multiplier.isNegative && !multiplier.isZero
        ? multiplier
        : ExpNumber.ONE;
    if (value.eq(this.devProductionMultiplier)) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      value,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      this.tradeRoutes,
    );
  }

  /** Dev-tools: free buildings (skip affordability + deduction, keep capacity). */
  setFreeBuildings(free: boolean): CivilizationState {
    if (free === this.freeBuildings) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      free,
    );
  }

  /** Dev-tools: free units (skip affordability + deduction, keep availability). */
  setFreeUnits(free: boolean): CivilizationState {
    if (free === this.freeUnits) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      free,
    );
  }

  /** Dev-tools: free upgrades (skip affordability + deduction, keep unlock gates). */
  setFreeUpgrades(free: boolean): CivilizationState {
    if (free === this.freeUpgrades) return this;
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      free,
    );
  }

  /**
   * Dev-tools: advance the simulation by whole seconds in one step. Every
   * production rate is constant across the window — nothing in the model feeds
   * resource amounts back into the rates — so the skip is one multiply per
   * producer resource instead of a per-second loop. Auto clicks are already
   * part of the rate; auto-buy and auto-assign stay with the live loop.
   */
  advanceTime(seconds: number): CivilizationState {
    const wholeSeconds = Math.floor(seconds);
    if (!Number.isFinite(wholeSeconds) || wholeSeconds <= 0) return this;
    const elapsed = Math.min(wholeSeconds, 86_400);
    const elapsedFactor = ExpNumber.fromNumber(elapsed);
    const resources = { ...this.resources };
    // A time skip applies the full rate — every drain in it, the citizen food upkeep
    // included — with only the route's own rows held back…
    for (const resourceKey of producerResourceKeys) {
      resources[resourceKey] = applyRate(
        resources[resourceKey],
        computeResourceRate(this.baseProductionFactors(resourceKey)).mul(
          elapsedFactor,
        ),
      );
    }
    // …and the route is then applied once for the whole window, its legs scaled by
    // the seconds and each capped by the balance the window ended with.
    this.applyTradeRouteSkip(resources, elapsedFactor);
    const activeStreakMs =
      this.statistics.activeStreakMs + elapsed * tickMilliseconds;
    const statistics: Statistics = {
      ...this.statistics,
      playTimeMs: this.statistics.playTimeMs + elapsed * tickMilliseconds,
      runTimeMs: this.statistics.runTimeMs + elapsed * tickMilliseconds,
      onlineTimeMs: this.statistics.onlineTimeMs + elapsed * tickMilliseconds,
      activeStreakMs,
      longestActiveMs: Math.max(
        this.statistics.longestActiveMs,
        activeStreakMs,
      ),
    };
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
    )
      .recordCurrentAge()
      .checkAchievements();
  }

  /**
   * The time skip's counterpart to the per-tick drain rows. The window's
   * production lands first, on the full rate with every drain in it *except* the
   * trade route's own rows; the route is then applied once for the whole window
   * with its legs scaled by the seconds, and each leg capped by the balance the
   * window ended with — so neither the goods sold nor the gold spent can take a
   * balance below zero.
   */
  private applyTradeRouteSkip(
    resources: ResourceAmounts,
    seconds: ExpNumber,
  ): void {
    for (const resource of this.getActiveTradeRoutes()) {
      const legs = this.tradeRouteVolumeLegs(resource);
      if (!legs) continue;
      const unitsPerGold = this.getTradePrice(resource).resourcePerGold;
      if (this.tradeRoutes[resource]?.mode === "buy") {
        const gold = ExpNumber.min(legs.gold.mul(seconds), resources.gold);
        if (gold.lte(ExpNumber.ZERO)) continue;
        resources.gold = resources.gold.sub(gold);
        resources[resource] = resources[resource].add(
          gold
            .mul(unitsPerGold)
            .div(ExpNumber.fromNumber(DEFAULT_TRADE_SPREAD)),
        );
        continue;
      }
      const units = ExpNumber.min(legs.units.mul(seconds), resources[resource]);
      if (units.lte(ExpNumber.ZERO)) continue;
      resources[resource] = resources[resource].sub(units);
      resources.gold = resources.gold.add(units.div(unitsPerGold));
    }
  }

  enterAge(ageId: string): CivilizationState {
    if (this.enteredAges.includes(ageId)) return this;
    const age = findAgeDefinition(ageId);
    if (!age) return this;

    // Retire units from N-2 age (units from two ages ago)
    const currentAgeIndex = ageDefinitions.findIndex((a) => a.key === ageId);
    const retireAgeIndex = currentAgeIndex - 2;
    let wasted = ExpNumber.ZERO;
    const newUnitCounts = { ...this.unitCounts };

    if (retireAgeIndex >= 0) {
      for (const [unitId, count] of Object.entries(this.unitCounts)) {
        const unitDef = findUnitDefinition(unitId);
        if (unitDef && unitDef.age === retireAgeIndex) {
          // Compute the cost of these units (what was "wasted")
          const unitCost = this.getUnitCost(unitId, 0);
          const totalCost = unitCost.reduce<ExpNumber>(
            (total, { base }) => total.add(base.mul(count)),
            ExpNumber.ZERO,
          );
          wasted = wasted.add(totalCost);
          delete newUnitCounts[unitId];
        }
      }
    }

    // Apply age bonuses (data-driven path: ages.json → AgeDefinition.bonuses → engine).
    // Attribute-targeted bonuses fold into the existing factor model via addFactor(); they
    // are then re-derived from enteredAges inside activeBonuses() so getBuildingMax() /
    // getFactors() / etc. pick them up. This replaces the old hardcoded "×10 townHall
    // capacity" with a data-driven path.
    const afterBonuses = this.applyAttributeBonuses(age.bonuses, ageId, this);

    return afterBonuses
      .withState(
        afterBonuses.resources,
        afterBonuses.buildingCostOverrides,
        afterBonuses.builtBuildings,
        afterBonuses.autoClicksPerSecond,
        afterBonuses.boughtUpgrades,
        afterBonuses.defeatedEncounters,
        [...afterBonuses.enteredAges, ageId],
        afterBonuses.earnedAchievements,
        {
          ...afterBonuses.statistics,
          fastestAgeMs: afterBonuses.recordFastest(
            afterBonuses.statistics.fastestAgeMs,
            ageId,
          ),
          wastedResources: afterBonuses.statistics.wastedResources.add(wasted),
        },
        newUnitCounts,
      )
      .recordCurrentAge();
  }

  /** Current age is the first age not yet completed, independent of population. */
  getCurrentAge(): AgeDefinition | undefined {
    const firstUnentered = ageDefinitions.findIndex(
      (a) => !this.enteredAges.includes(a.key),
    );
    const currentIndex =
      firstUnentered < 0 ? ageDefinitions.length - 1 : firstUnentered;
    return ageDefinitions[currentIndex];
  }

  /** Battle progress in the current age: [wonCount, totalCount]. */
  getAgeBattleProgress(): [number, number] {
    const age = this.getCurrentAge();
    if (!age) return [0, 0];
    const ageIndex = parseInt(age.key.slice(-1), 10);
    const totalBattles = encounterDefinitions.filter(
      (e) => e.age === ageIndex,
    ).length;
    const wonBattles = encounterDefinitions.filter(
      (e) => e.age === ageIndex && this.defeatedEncounters.includes(e.key),
    ).length;
    return [wonBattles, totalBattles];
  }

  /** Building progress in the current age: [buildings, target]. */
  getAgeBuildingProgress(): [number, number] {
    const age = this.getCurrentAge();
    if (!age) return [0, 0];
    const buildings = Object.values(this.builtBuildings).reduce(
      (sum, count) => sum + count,
      0,
    );
    const target = this.getAgeBuildingTarget(age);
    return [buildings, target];
  }

  /** Total buildings required to complete the age. */
  private getAgeBuildingTarget(age: AgeDefinition): number {
    const ageIndex = ageDefinitions.findIndex(({ key }) => key === age.key);
    if (ageIndex < 0) return age.buildingThreshold;
    return (
      ageDefinitions[ageIndex + 1]?.buildingThreshold ?? age.buildingThreshold
    );
  }

  /** Whether the current age can be completed (all its battles + its building target). */
  canEnterAge(ageId: string): boolean {
    const age = findAgeDefinition(ageId);
    if (!age) return false;
    if (this.enteredAges.includes(ageId)) return false;
    if (this.getCurrentAge()?.key !== ageId) return false;

    // Check battles: all battles in this age must be won
    const ageIndex = parseInt(age.key.slice(-1), 10);
    const ageBattles = encounterDefinitions.filter((e) => e.age === ageIndex);
    const allBattlesWon = ageBattles.every((b) =>
      this.defeatedEncounters.includes(b.key),
    );
    if (!allBattlesWon) return false;

    // Check buildings against this age's data-defined completion target.
    const target = this.getAgeBuildingTarget(age);
    const totalBuildings = Object.values(this.builtBuildings).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (totalBuildings < target) return false;

    return true;
  }

  /** Whether the given age is currently "unlocked" (winnable) — all prior ages entered. */
  isAgeUnlocked(ageId: string): boolean {
    const ageIndex = parseInt(ageId.slice(-1), 10);
    // Age 0 is always unlocked
    if (ageIndex === 0) return true;
    // Check that the previous age has been entered
    // Handle both formats: "age1" and "age-1"
    const prevAgeId = ageId.startsWith("age-")
      ? `age-${ageIndex - 1}`
      : `age${ageIndex - 1}`;
    return this.enteredAges.includes(prevAgeId);
  }

  getFastestAgeTime(ageId: string): number | undefined {
    return this.statistics.fastestAgeMs[ageId];
  }

  /**
   * Trade routes (Trade tab). A route buys or sells one resource for gold: it asks
   * for `intensity` of the banked trade power each second, one trade power being one
   * gold of goods, and moves `production(R) / production(gold)` units of the
   * resource for that gold — a tenth of it when buying, the spread. Both legs are
   * capped by what the settlement holds, and both ride the production factors as
   * drain rows — debits positive, credits negative — so neither picks up a
   * production multiplier and both show up in the Gamepedia's Drain list. The
   * reserve is never spent.
   */
  getTradeRoute(resource: TradeResourceKey): TradeRoute {
    return this.tradeRoutes[resource] ?? defaultTradeRoute;
  }

  /** Routes currently running, in the order they are served. */
  /** Trade power income per second — what markets and their boosts produce. */
  getTradePowerRate(): ExpNumber {
    return this.computeResourceRate("trade");
  }

  /** The live mid price of one tradable resource, from rates excluding worker production. */
  getTradePrice(resource: TradeResourceKey): TradePrice {
    return getTradePrice(resource, (key) =>
      computeResourceRate(this.getTradePriceFactors(key)),
    );
  }

  /**
   * Configures a route. Enabling one is refused while every slot is taken (the
   * caller surfaces that), and a no-op change returns `this`, so a UI can test
   * `next === state`.
   */
  setTradeRoute(
    resource: TradeResourceKey,
    patch: Partial<TradeRoute>,
  ): CivilizationState {
    if (!tradeableResourceKeys.includes(resource)) return this;
    const current = this.getTradeRoute(resource);
    const next: TradeRoute = {
      enabled: patch.enabled ?? current.enabled,
      mode: patch.mode ?? current.mode,
      intensity: clampTradeIntensity(patch.intensity ?? current.intensity),
    };
    if (
      next.enabled === current.enabled &&
      next.mode === current.mode &&
      next.intensity === current.intensity
    ) {
      return this;
    }
    if (
      next.enabled &&
      !current.enabled &&
      this.getActiveTradeRoutes().length >= this.getTradeRouteSlots()
    ) {
      return this;
    }
    return this.withState(
      this.resources,
      this.buildingCostOverrides,
      this.builtBuildings,
      this.autoClicksPerSecond,
      this.boughtUpgrades,
      this.defeatedEncounters,
      this.enteredAges,
      this.earnedAchievements,
      this.statistics,
      this.unitCounts,
      this.devProductionMultiplier,
      this.freeBuildings,
      this.freeUnits,
      this.freeUpgrades,
      this.boughtResearch,
      this.unitOrders,
      this.unitFormations,
      { ...this.tradeRoutes, [resource]: next },
    );
  }

  /**
   * Get the current trade production multiplier
   * Formula: 1 + log₁₀(trade + 1)
   */
  getTradeMultiplier(): ExpNumber {
    return calculateTradeMultiplier(this.resources.trade);
  }

  /**
   * What one second of a route would move, for the Trade tab preview. It is
   * computed from the settings alone, so the card can show it before the route is
   * switched on. `tradePower` is the value the route asks for out of the reserve
   * (one trade power being one gold of goods), and the two legs are capped by what
   * the settlement actually holds — the same numbers the tick will apply.
   */
  getTradeRouteThroughput(resource: TradeResourceKey): {
    tradePower: ExpNumber;
    resourcePerSecond: ExpNumber;
    goldPerSecond: ExpNumber;
  } {
    const legs = this.tradeRouteLegs(resource);
    return {
      tradePower: this.tradeRouteValue(resource),
      resourcePerSecond: legs?.units ?? ExpNumber.ZERO,
      goldPerSecond: legs?.gold ?? ExpNumber.ZERO,
    };
  }

  /** Routes that are actually served: enabled, and inside the slot cap. */
  getActiveTradeRoutes(): TradeResourceKey[] {
    return tradeableResourceKeys
      .filter((resource) => this.tradeRoutes[resource]?.enabled === true)
      .slice(0, this.getTradeRouteSlots());
  }

  /**
   * How many routes may run at once. The cap is a derived stat based at one, so
   * an `attributeFlat` bonus (research, achievement) opens a further route
   * without the engine naming that content.
   */
  getTradeRouteSlots(): number {
    const slots = Math.floor(this.getAttributeValue("tradeRoutes").toNumber());
    return Number.isFinite(slots) ? Math.max(1, slots) : 1;
  }

  /**
   * What a route asks for each second: its share of the banked trade power, at one
   * trade power to one gold. The reserve is never spent, so this grows with the
   * bank rather than with the income.
   */
  private tradeRouteValue(resource: TradeResourceKey): ExpNumber {
    const route = this.tradeRoutes[resource];
    if (!route) return ExpNumber.ZERO;
    const intensity = clampTradeIntensity(route.intensity);
    if (intensity <= 0) return ExpNumber.ZERO;
    return this.resources.trade
      .mul(ExpNumber.fromNumber(intensity))
      .mul(ExpNumber.fromNumber(GOLD_PER_TRADE_POWER));
  }

  /**
   * The two legs a route moves over a second, **uncapped**: what it asks for out
   * of the reserve, priced at the production ratio, divided by the spread when
   * buying. The per-tick rows and a time skip each cap this against what the
   * settlement holds.
   */
  private tradeRouteVolumeLegs(
    resource: TradeResourceKey,
  ): { units: ExpNumber; gold: ExpNumber } | undefined {
    const goldValue = this.tradeRouteValue(resource);
    if (goldValue.lte(ExpNumber.ZERO)) return undefined;
    const unitsPerGold = this.getTradePrice(resource).resourcePerGold;
    if (this.tradeRoutes[resource]?.mode === "buy") {
      return {
        gold: goldValue,
        units: goldValue
          .mul(unitsPerGold)
          .div(ExpNumber.fromNumber(DEFAULT_TRADE_SPREAD)),
      };
    }
    return { units: goldValue.mul(unitsPerGold), gold: goldValue };
  }

  /**
   * One second of a route, each leg capped by what the settlement holds right now:
   * buying by the purse and what the purse buys at the spread, selling by the
   * stock on hand and what that stock is worth in gold. `undefined` when the route
   * has nothing to move.
   */
  private tradeRouteLegs(
    resource: TradeResourceKey,
  ): { units: ExpNumber; gold: ExpNumber } | undefined {
    const raw = this.tradeRouteVolumeLegs(resource);
    if (!raw) return undefined;
    if (this.tradeRoutes[resource]?.mode === "buy") {
      const gold = ExpNumber.min(raw.gold, this.resources.gold);
      if (gold.lte(ExpNumber.ZERO)) return undefined;
      const scale = raw.gold.lte(ExpNumber.ZERO)
        ? ExpNumber.ZERO
        : gold.div(raw.gold);
      return { gold, units: raw.units.mul(scale) };
    }
    const units = ExpNumber.min(raw.units, this.resources[resource]);
    if (units.lte(ExpNumber.ZERO)) return undefined;
    return { units, gold: units.div(raw.units).mul(raw.gold) };
  }

  /**
   * The drain rows the served routes contribute to one resource.
   *
   * Both legs are drains — debits positive, credits negative — so nothing a route
   * does is multiplied by the production multipliers (the factor model multiplies
   * `additional` rows and subtracts `drain` rows), and so every effect a route has
   * lands in the Gamepedia's Drain list rather than an Add row. The values are read
   * from the state on every call, so a drain is replaced on the next tick instead
   * of stacking, and the tick applies them like any other production or upkeep —
   * no separate trade step. Gold is the numeraire of every route, so its rows can
   * come from several routes at once.
   */
  private tradeRouteFactor(resourceKey: ResourceKey): ResourceFactor[] {
    const tradable =
      resourceKey === "gold"
        ? undefined
        : tradeableResourceKeys.find((key) => key === resourceKey);
    if (resourceKey !== "gold" && !tradable) return [];
    // Cheap exit for the common case: no route is configured at all.
    if (Object.keys(this.tradeRoutes).length === 0) return [];
    const served = this.getActiveTradeRoutes();
    if (served.length === 0) return [];
    const rows: ResourceFactor[] = [];
    for (const resource of served) {
      const legs = this.tradeRouteLegs(resource);
      if (!legs) continue;
      const buying = this.tradeRoutes[resource]?.mode === "buy";
      if (resourceKey === "gold") {
        rows.push([
          tradeRouteSource(resource, buying ? "" : "sale"),
          buying ? legs.gold : legs.gold.neg(),
        ]);
      } else if (resourceKey === resource) {
        rows.push([
          tradeRouteSource(resource, buying ? "purchase" : ""),
          buying ? legs.units.neg() : legs.units,
        ]);
      }
    }
    return rows;
  }
}
