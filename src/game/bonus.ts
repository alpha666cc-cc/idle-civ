import { ExpNumber } from "./expNumber";
import type { BuildingKey } from "./buildings";
import type { AttributeKey, CapacityResourceKey } from "./attributes";

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
  | "costReductionBase" // destination cost's base term reduced
  | "costReductionFactor" // destination cost's growth factor reduced multiplicatively (clamped at 1.01 minimum)
  | "costMultiplier"; // destination cost ×N (for cost increases, e.g., age scaling)

/** A bonus targets an attribute (resource, capacity or stat) or a buyable id. */
export type BuyableCostTarget = "allBuildings" | "allUnits";

export type BonusDestination = AttributeKey | BuyableCostTarget | string;

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
  "costMultiplier",
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

/** The four cost-reduction types plus cost multiplier folded into per-unit adjustments (§13.1). */
export type CostReductions = {
  /**
   * Π(1 − N) — base divisors compound (a value of 1/2 divides the base by 2);
   * each source clamped at a 0 floor.
   */
  base: ExpNumber;
  /**
   * Π multiplicative factor reductions (clamped at 1.01 minimum).
   * Each 0.01 value reduces the (factor - 1.01) range by 1% multiplicatively.
   * Formula: 1.01 + (baseFactor - 1.01) * Π(1 - value)
   */
  factor: ExpNumber;
  /** Π(1 − N) — percent reductions compound; each source clamped at a 0 floor. */
  percent: ExpNumber;
  /** Σ absolute per-unit reductions, applied after percent, clamped at 0 per unit. */
  flat: ExpNumber;
  /** Π cost multipliers compound (for cost increases, e.g., age scaling). */
  multiplier: ExpNumber;
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
    multiplier: ExpNumber.ONE,
  };
  for (const bonus of bonuses) {
    switch (bonus.type) {
      case "costReductionBase":
        reductions.base = reductions.base.mul(
          ExpNumber.max(ExpNumber.ZERO, ExpNumber.ONE.sub(bonus.value)),
        );
        break;
      case "costReductionFactor":
        // Multiplicative factor reduction: each value reduces the (factor - 1.01) range
        reductions.factor = reductions.factor.mul(
          ExpNumber.max(ExpNumber.ZERO, ExpNumber.ONE.sub(bonus.value)),
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
      case "costMultiplier":
        reductions.multiplier = reductions.multiplier.mul(bonus.value);
        break;
      default:
        break;
    }
  }
  return reductions;
};
