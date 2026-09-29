/**
 * Progressive cost-growth-factor reduction schedule (design artifact).
 *
 * Walks the square-root cost curve's growth factor `k` down from the planned
 * model baseline of 25 to its age7 endgame target over ten
 * production-building-count decades — the ten rows of the production-exponent
 * progression. Building values are derived exactly from the `pe` targets via
 * `k = 10^((pe - 1) / sqrt(pb))`: the first four rows hold flat at 25 (pe
 * noise there is rounding only), then the age3 cliff and the asymptotic decay.
 *
 * This module is intentionally NOT wired into `civilizationState.costSeries()`.
 * Live costs are per-entry JSON data: building factors currently include
 * 2.5 / 8 / 10 / 12 / 15, so the schedule remains a separate design artifact.
 * Wiring it into live costs — and choosing its trigger key (production-count
 * decade vs population vs age) and its scope (all buildings vs only the four
 * production buildings) — is a game-rule decision deferred until confirmed. See
 * docs/game-scope.md section 3.
 */

/** Growth factor `k` per step for buildings: 25 flat, age3 cliff, decay to ~1.0746. */
export const buildingFactorSchedule: readonly number[] = [
  25, 25, 25, 25, 8.128, 2.833, 1.774, 1.344, 1.155, 1.0745,
];

/**
 * Growth factor `k` per step for citizens: 2.5 -> 1.02. Smooth geometric
 * interpolation is a default only — citizens have no production-exponent rows
 * of their own, so just the two endpoints are fixed; the intermediate shape
 * is still to be confirmed.
 */
export const citizenFactorSchedule: readonly number[] = [
  2.5, 2.263, 2.048, 1.854, 1.678, 1.519, 1.375, 1.245, 1.127, 1.02,
];

/** One step per production-building decade (the ten progression rows). */
export const costFactorSteps = buildingFactorSchedule.length;

/**
 * Growth factor at `step`, clamped to the schedule's ends: overshoot holds the
 * age7 floor rather than running past it, and undershoot holds the schedule's
 * modeled starting value.
 */
export const costFactorAt = (
  schedule: readonly number[],
  step: number,
): number => {
  if (step <= 0) return schedule[0];
  const last = schedule.length - 1;
  if (step >= last) return schedule[last];
  return schedule[Math.floor(step)];
};

/**
 * Step index for a production-building count: its base-10 decade (0 for 1-9
 * buildings, 1 for 10-99, ... 9 for 1e9+). The natural self-sequencing trigger
 * implied by the progression table; exposed for the eventual wiring but not
 * yet consumed by the cost pipeline.
 */
export const productionStepFromCount = (count: number): number => {
  if (count <= 0) return 0;
  const decade = Math.floor(Math.log10(count));
  return Math.min(Math.max(decade, 0), costFactorSteps - 1);
};
