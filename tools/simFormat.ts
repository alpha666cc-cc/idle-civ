/**
 * Number formatting for simulation CLI output (balance reports).
 *
 * Every number the simulation tools print goes through `formatExpoNumber` so
 * reports are rounded a little: readable values keep at most two decimals
 * with trailing zeros trimmed ("0.1", "2.50" -> "2.5", "113.9999999999995"
 * -> "114"), while anything from a million up (or smaller than the
 * two-decimal floor) switches to scientific notation with three digits after
 * the decimal point ("9999999 -> 9.999e+6", "2.354e256"). The game's own
 * `formatNumber()` is intentionally not used: it clamps |x| < 1 to "0" and
 * hides sub-integer production, which is exactly the signal a balance report
 * needs.
 */

/** First magnitude printed in scientific notation (a million). */
const SCIENTIFIC_THRESHOLD = 1e6;

/**
 * `toFixed` is only defined up to 1e21; above that it silently returns the
 * raw value with no decimals at all, so hand those to the scientific path.
 */
const FIXED_NOTATION_LIMIT = 1e21;

/** Smallest magnitude the two-decimal floor can still show. */
const FIXED_FLOOR = 0.01;

/**
 * Formats a number (or a numeric string such as `ExpNumber.toString()`
 * output) for simulation reports. Non-finite and unparsable input is passed
 * through unchanged ("Infinity", "NaN").
 */
export function formatExpoNumber(value: number | string): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);

  const magnitude = Math.abs(number);
  if (
    magnitude >= SCIENTIFIC_THRESHOLD ||
    magnitude >= FIXED_NOTATION_LIMIT ||
    (magnitude > 0 && magnitude < FIXED_FLOOR)
  ) {
    return number.toExponential(3);
  }

  const fixed = number.toFixed(2);
  // toFixed can round up across the threshold (999999.996 -> 1000000);
  // renormalise so the output never contradicts the mode it printed in.
  if (Math.abs(Number(fixed)) >= SCIENTIFIC_THRESHOLD) {
    return number.toExponential(3);
  }
  // Trim trailing decimal zeros: "114.00" -> "114", "2.50" -> "2.5".
  return fixed.replace(/\.?0+$/, "") || "0";
}