import { ExpNumber } from "./expNumber";
import type { BuildingKey } from "./buildings";
import type { CapacityResourceKey, ResourceKey } from "./resources";

/**
 * The single unit of change (AGENTS.md §13.1). Resource-targeted bonuses reuse the
 * existing factor model; cost reductions apply per buyable unit in the fixed order
 * `base → factor → percent → flat`, clamped at 0. The engine currently applies the
 * three resource types (via `getFactors()` and `getBuildingMax()`); the four cost
 * types are defined here as the contract and land in `getBuildingCost()` (§13.6)
 * when a definition first uses them.
 */
export type BonusType =
  // resource-targeted: the destination is a resource
  | "resourceFlat" // +N to the destination resource's accrual
  | "resourceMultiplier" // ×N on the destination resource (or capacity) gain
  | "resourceDrain" // −N per second of the destination resource, clamped at 0
  // buyable-targeted: the destination is a buyable (building or unit) id
  | "costReductionFlat" // destination cost −N (absolute, per unit)
  | "costReductionPercent" // destination cost × (1 − N) per unit
  | "costReductionBase" // destination cost's base term reduced
  | "costReductionFactor"; // destination cost's growth factor reduced

/** A bonus targets a resource (including capacity resources) or a buyable id. */
export type BonusDestination = ResourceKey | string;

export type Bonus = {
  readonly type: BonusType;
  readonly destination: BonusDestination;
  readonly value: ExpNumber;
};

export const resourceBonus = (
  type: "resourceFlat" | "resourceMultiplier" | "resourceDrain",
  destination: ResourceKey,
  value: number | ExpNumber,
): Bonus => ({ type, destination, value: ExpNumber.from(value) });

/**
 * Capacity keeps its own representation (§13.7 decision 3): a capacity multiplier is a
 * `resourceMultiplier` whose destination is the capacity resource, so the capacity door
 * stays open for flat grants and future multiplier variants alike.
 */
export const capacityMultiplierBonus = (
  building: BuildingKey,
  factor: number | ExpNumber,
): Bonus => ({
  type: "resourceMultiplier",
  destination: `${building}Capacity` as CapacityResourceKey,
  value: ExpNumber.from(factor),
});

export const costReductionBonus = (
  type: "costReductionFlat" | "costReductionPercent" | "costReductionBase" | "costReductionFactor",
  buyableId: string,
  value: number | ExpNumber,
): Bonus => ({ type, destination: buyableId, value: ExpNumber.from(value) });

/** The four cost-reduction types folded into per-unit adjustments (§13.1). */
export type CostReductions = {
  /** Σ absolute reductions of the cost's base term. */
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
    base: ExpNumber.ZERO,
    factor: ExpNumber.ZERO,
    percent: ExpNumber.ONE,
    flat: ExpNumber.ZERO,
  };
  for (const bonus of bonuses) {
    switch (bonus.type) {
      case "costReductionBase":
        reductions.base = reductions.base.add(bonus.value);
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