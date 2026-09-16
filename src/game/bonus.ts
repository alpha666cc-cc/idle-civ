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
  // buyable-targeted: the destination is a buyable (building or unit) id
  | "costReductionFlat" // destination cost −N (absolute, per unit)
  | "costReductionPercent" // destination cost × (1 − N) per unit
  | "costReductionBase" // destination cost's base term reduced
  | "costReductionFactor"; // destination cost's growth factor reduced

/** A bonus targets an attribute (resource, capacity or stat) or a buyable id. */
export type BonusDestination = AttributeKey | string;

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
  type: "costReductionFlat" | "costReductionPercent" | "costReductionBase" | "costReductionFactor",
  buyableId: string,
  value: number | ExpNumber,
): Bonus => ({ type, destination: buyableId, value: ExpNumber.from(value) });

const bonusTypes: readonly BonusType[] = [
  "attributeFlat",
  "attributeMultiplier",
  "attributeDrain",
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

/** The four cost-reduction types folded into per-unit adjustments (§13.1). */
export type CostReductions = {
  /**
   * Π(1 − N) — base divisors compound (a value of 1/2 divides the base by 2);
   * each source clamped at a 0 floor.
   */
  base: ExpNumber;
  /** Σ reductions of the cost's growth factor (engine clamps the factor at 1). */
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
    factor: ExpNumber.ZERO,
    percent: ExpNumber.ONE,
    flat: ExpNumber.ZERO,
  };
  for (const bonus of bonuses) {
    switch (bonus.type) {
      case "costReductionBase":
        reductions.base = reductions.base.mul(
          ExpNumber.max(ExpNumber.ZERO, ExpNumber.ONE.sub(bonus.value)),
        );
        break;
      case "costReductionFactor":
        reductions.factor = reductions.factor.add(bonus.value);
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