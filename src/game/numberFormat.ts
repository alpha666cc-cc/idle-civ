/**
 * Number formatting utilities for idle-civ.
 *
 * Supported formats:
 *   "scientific"  – 1.23e9      (mantissa 1–10, any exponent)
 *   "engineering" – 12.35e9     (mantissa 1–1000, exponent a multiple of 3)
 *   "named"       – 1.23B       (K, M, B, T, Qa, Qi, Sx, Sp, Oc, No, …)
 *   "compact"     – 1.23C       (none, A, B, … Z, AA, … ZZ, AAA, …)
 */

import { ExpNumber } from "./expNumber";

export type NumberFormat = "scientific" | "engineering" | "named" | "compact";

const NAMED_SUFFIXES = [
  "",
  "K",
  "M",
  "B",
  "T",
  "Qa",
  "Qi",
  "Sx",
  "Sp",
  "Oc",
  "No",
  "De",
  "Ud",
  "Dd",
  "Td",
  "Qad",
  "Qid",
  "Sxd",
  "Spd",
  "Ocd",
  "Nod",
  "Vi",
  "Uvi",
  "Dvi",
  "Tvi",
  "Qavi",
  "Qivi",
  "Sxvi",
  "Spvi",
  "Ocvi",
  "Novi",
  "Tr",
];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Excel-style column letters, unbounded:
 *   1  -> A, 26 -> Z, 27 -> AA,
 *   702 -> ZZ, 703 -> AAA, ... continues to 3+ letters as needed.
 */
function columnLetters(tier: number): string {
  let index = tier - 1;
  let out = "";
  while (index >= 0) {
    out = ALPHABET[index % 26] + out;
    index = Math.floor(index / 26) - 1;
  }
  return out;
}

/**
 * Compact suffix tiers, one full order-class per letter:
 *   tier 0 = "" (no suffix), tier 1 = A (1e3), tier 2 = B (1e6), ...
 *   tier 26 = Z, tier 27 = AA, tier 28 = AB, ... tier 702 = ZZ,
 *   tier 703 = AAA, ... (does not stop at 2 letters).
 */
export function compactSuffix(tier: number): string {
  return tier <= 0 ? "" : columnLetters(tier);
}

/**
 * Formats a duration in milliseconds as `3d 4h 5m`, `4h 2m 5s` or `1m 5s`
 * (components are not zero-padded). Sub-second values render as `0s`; negative
 * values clamp to `0s`.
 */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function scaled(fraction: number): string {
  const rounded = Number(fraction.toFixed(2));
  const nearestInt = Math.round(rounded);
  if (Math.abs(rounded - nearestInt) <= 1e-6) {
    return String(nearestInt);
  }
  return rounded.toString();
}

/**
 * Formats a base-10 exponent. Safe integers print in full ("e1139400000");
 * beyond safe-integer range the exponent itself is shown in scientific
 * notation so no magnitude is lost to JS's exponential number string form.
 */
function formatExponent(exponent: number): string {
  if (Number.isSafeInteger(exponent)) return String(exponent);
  if (exponent < 1) return String(exponent);
  const exp = Math.floor(Math.log10(exponent));
  return `${scaled(exponent / 10 ** exp)}e${exp}`;
}

/**
 * Formats an ExpNumber or a plain number. When the value fits in a double
 * the output matches the historical number-only behavior; beyond that range
 * the exponent is read straight off the ExpNumber representation, so values
 * like 10 * 1.3^1e10 (≈ 1.38e1139400000) still display correctly.
 */
export function formatNumber(
  value: ExpNumber | number,
  format: NumberFormat,
): string {
  const expValue =
    value instanceof ExpNumber ? value : ExpNumber.fromNumber(value);
  if (!expValue.isFinite) return expValue.toString();
  if (expValue.isZero) return "0";

  const negative = expValue.sign < 0;
  const abs = expValue.abs();
  const exponent = abs.exponent;
  const mantissa = abs.mantissa;
  const withSign = (text: string): string => (negative ? `-${text}` : text);

  if (exponent <= 0) {
    return withSign(scaled(abs.toNumber()));
  }

  switch (format) {
    case "scientific": {
      return withSign(`${scaled(mantissa)}e${formatExponent(exponent)}`);
    }

    case "engineering": {
      const tier = Math.floor(exponent / 3);
      const exp = tier * 3;
      const display = mantissa * 10 ** (exponent - exp);
      return withSign(`${scaled(display)}e${formatExponent(exp)}`);
    }

    case "named": {
      const tier = Math.floor(exponent / 3);
      if (tier <= 0) return withSign(scaled(abs.toNumber()));
      const suffix = NAMED_SUFFIXES[tier] ?? columnLetters(tier);
      const display = mantissa * 10 ** (exponent - tier * 3);
      return withSign(`${scaled(Number(display.toFixed(2)))}${suffix}`);
    }

    case "compact": {
      const tier = Math.floor(exponent / 3);
      if (tier <= 0) return withSign(scaled(abs.toNumber()));
      const suffix = compactSuffix(tier);
      const display = mantissa * 10 ** (exponent - tier * 3);
      return withSign(`${scaled(Number(display.toFixed(2)))}${suffix}`);
    }
  }
}
