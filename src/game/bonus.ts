import { ExpNumber } from "./expNumber";
import type { BuildingKey } from "./buildings";
import type { AttributeKey, CapacityResourceKey } from "./attributes";
import { findAttributeDefinition } from "./attributes";
import { buildingDefinitions } from "./buildings";
import {
  findUnitDefinition,
  parseUnitStatTarget,
  unitDomainLabels,
} from "./units";

/**
 * The single unit of change (AGENTS.md §13.1). Attribute-targeted bonuses reuse the
 * existing factor model; cost reductions apply per buyable unit in the fixed order
 * `base → factor → percent → flat`, clamped at 0. The engine applies the three
 * attribute types (via `getFactors()`, `getBuildingMax()` and the computed-stat
 * paths); the four cost types land in `getBuildingCost()` (§13.6) when a
 * definition first uses them.
 */
export type BonusType =
  // attribute-targeted: the destination is a resource, capacity or stat
  | "attributeFlat" // +N to the destination attribute's accrual
  | "attributeMultiplier" // ×N on the destination attribute (or capacity) gain
  | "attributeDrain" // −N per second of the destination attribute, clamped at 0
  | "removeDrain" // cancels a share (0–1) of the destination attribute's drains
  // buyable-targeted: the destination is a buyable (building or unit) id
  | "costReductionFlat" // destination cost −N (absolute, per unit)
  | "costReductionPercent" // destination cost × (1 − N) per unit
  // destination cost's base term ×N — <1 reduces, >1 augments. Absorbs what used
  // to be a separate `costMultiplier`, which expressed the same ×N with a
  // confusing sign: a value above 1 is now a price *increase*, not a discount.
  | "costReductionBase"
  // destination cost's growth factor raised to the power N (floored at 1.01)
  | "costReductionFactor";

/** A bonus targets an attribute (resource, capacity or stat) or a buyable id. */
export type BuyableCostTarget = "allBuildings" | "allUnits";

export type BonusDestination = AttributeKey | BuyableCostTarget | string;

/** Group targets for cost reductions */
export type BuildingCostGroup =
  | "basicProductionBuildings" // farm, lumberYard, quarry, goldMine
  | "advancedProductionBuildings"; // barracks, university, smithy, market

export type Bonus = {
  readonly type: BonusType;
  readonly destination: BonusDestination;
  readonly value: ExpNumber;
};

export const attributeBonus = (
  type: "attributeFlat" | "attributeMultiplier" | "attributeDrain",
  destination: AttributeKey,
  value: number | ExpNumber,
): Bonus => ({ type, destination, value: ExpNumber.from(value) });

/**
 * Capacity keeps its own representation (§13.7 decision 3): a capacity multiplier is an
 * `attributeMultiplier` whose destination is the capacity resource, so the capacity door
 * stays open for flat grants and future multiplier variants alike.
 */
export const capacityMultiplierBonus = (
  building: BuildingKey,
  factor: number | ExpNumber,
): Bonus => ({
  type: "attributeMultiplier",
  destination: `${building}Capacity` as CapacityResourceKey,
  value: ExpNumber.from(factor),
});

export const costReductionBonus = (
  type:
    | "costReductionFlat"
    | "costReductionPercent"
    | "costReductionBase"
    | "costReductionFactor",
  buyableId: string,
  value: number | ExpNumber,
): Bonus => ({ type, destination: buyableId, value: ExpNumber.from(value) });

const bonusTypes: readonly BonusType[] = [
  "attributeFlat",
  "attributeMultiplier",
  "attributeDrain",
  "removeDrain",
  "costReductionFlat",
  "costReductionPercent",
  "costReductionBase",
  "costReductionFactor",
];

/**
 * Validates a bonus type arriving from JSON data. Definition payloads are
 * `as`-cast, so a stale type string would otherwise match no engine branch and
 * silently no-op; this fails loudly instead.
 */
export const parseBonusType = (type: string): BonusType => {
  if (bonusTypes.includes(type as BonusType)) return type as BonusType;
  throw new Error(`Unknown bonus type: ${type}`);
};

/**
 * Validates a bonus destination string. Returns true if the destination is a
 * recognized target (attribute, building, unit, or group scope), false otherwise.
 * Used by data loaders to catch typos in bonus destinations.
 */
export const isValidBonusDestination = (destination: string): boolean => {
  // Group targets for production
  if (
    destination === "allProduction" ||
    destination === "basicProduction" ||
    destination === "advancedProduction" ||
    destination === "allProductionPerWorker" ||
    destination === "basicProductionPerWorker" ||
    destination === "advancedProductionPerWorker"
  ) {
    return true;
  }

  // Group targets for building cost reductions
  if (
    destination === "basicProductionBuildings" ||
    destination === "advancedProductionBuildings"
  ) {
    return true;
  }

  // Unit stat targets
  if (parseUnitStatTarget(destination)) return true;

  // Attribute definitions
  if (findAttributeDefinition(destination)) return true;

  // Building keys
  if (buildingDefinitions.some(({ key }) => key === destination)) return true;

  // Buyable group targets
  if (destination === "allBuildings" || destination === "allUnits") return true;

  // Unit tag scopes
  if (destination.startsWith("tag.")) return true;

  // Unit domain scopes
  const domain = /^domain\.([a-z]+)$/.exec(destination);
  if (domain && domain[1] in unitDomainLabels) return true;

  // Unit ids
  if (findUnitDefinition(destination)) return true;

  return false;
};

/** Parses a bonus from JSON data (AGENTS.md §13.5: one file per type). Definition
 * payloads are `as`-cast, so a stale type string would otherwise match no engine branch
 * and silently no-op; this fails loudly instead. Numeric `value` strings use scientific
 * notation for |value| > 1,000,000 (AGENTS.md §4.3). */
export const parseBonus = (
  type: string,
  destination: string,
  value: number | string,
): Bonus => ({
  type: parseBonusType(type),
  destination,
  value: ExpNumber.from(value),
});

/** The four cost-reduction types folded into per-unit adjustments (§13.1). */
export type CostReductions = {
  /**
   * Π of the base-term multipliers — the value IS the multiplier, so `< 1`
   * discounts the base and `> 1` augments it (clamped at a 0 floor). This also
   * carries what used to be the separate `costMultiplier` type, so an age that
   * made a resource *dearer* is now just a base multiplier above 1.
   */
  base: ExpNumber;
  /**
   * Π of the growth-factor *powers*: the curve is re-shaped as
   * `B · ((F^√n)^Π(value) − 1)`, applied as `max(1.01, F^Π(value))`.
   *
   * The point of a power is that it scales the **log-growth exponent** by
   * exactly `value` for every growth factor — `ln(F_eff)/ln(F)` is precisely
   * `value` (measured 0.900000 on F = 2.5, 8, 10, 12 and 15 alike), whereas the
   * old `1.01 + (F − 1.01)·m` form drifted from 0.933 to 0.964 across that same
   * range. So "0.9" means "grow at 90% of the rate" wherever it lands, which is
   * what makes a single value reusable from one building to `allBuildings`.
   *
   * Note this is a statement about the *exponent*, not the cost ratio: cost still
   * scales with F at high n, because F itself is the design knob.
   */
  factor: ExpNumber;
  /** Π(1 − N) — percent reductions compound; each source clamped at a 0 floor. */
  percent: ExpNumber;
  /** Σ absolute per-unit reductions, applied after percent, clamped at 0 per unit. */
  flat: ExpNumber;
};

/**
 * Folds every cost-reduction bonus targeting one buyable into the per-unit adjustment
 * record the engine applies inside `getBuildingCost()` in the fixed order
 * `base → factor → percent → flat`.
 */
export const collectCostReductions = (bonuses: Bonus[]): CostReductions => {
  const reductions: CostReductions = {
    base: ExpNumber.ONE,
    factor: ExpNumber.ONE,
    percent: ExpNumber.ONE,
    flat: ExpNumber.ZERO,
  };
  for (const bonus of bonuses) {
    switch (bonus.type) {
      case "costReductionBase":
        // The value is the multiplier itself: <1 discounts the base, >1 makes it
        // dearer. (Use costReductionPercent when a percentage is wanted.)
        reductions.base = reductions.base.mul(
          ExpNumber.max(ExpNumber.ZERO, bonus.value),
        );
        break;
      case "costReductionFactor":
        // The value is a power, not a multiplier: 0.99 means "costs grow at 99%
        // of the default rate" for every growth factor, so powers compound by
        // multiplication (F^a then ^b is F^(a·b)).
        reductions.factor = reductions.factor.mul(
          ExpNumber.max(ExpNumber.ZERO, bonus.value),
        );
        break;
      case "costReductionPercent":
        reductions.percent = reductions.percent.mul(
          ExpNumber.max(ExpNumber.ZERO, ExpNumber.ONE.sub(bonus.value)),
        );
        break;
      case "costReductionFlat":
        reductions.flat = reductions.flat.add(bonus.value);
        break;
      default:
        break;
    }
  }
  return reductions;
};
