/**
 * Number formatting utilities for idle-civ.
 *
 * Supported formats:
 *   "default"     – 1,234,567   (browser toLocaleString)
 *   "scientific"  – 1.23e9      (mantissa 1–10, any exponent)
 *   "engineering" – 12.35e9     (mantissa 1–1000, exponent a multiple of 3)
 *   "named"       – 1.23B       (K, M, B, T, Qa, Qi, Sx, Sp, Oc, No, …)
 *   "compact"     – 1.23C       (none, A, B, … Z, AA, … ZZ, AAA, …)
 */

export type NumberFormat =
  | "default"
  | "scientific"
  | "engineering"
  | "named"
  | "compact";

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

function scaled(fraction: number): string {
  return fraction.toFixed(2);
}

export function formatNumber(value: number, format: NumberFormat): string {
  if (!Number.isFinite(value)) return String(value);
  const floored = Math.floor(value);
  if (floored === 0) return "0";

  const abs = Math.abs(floored);

  switch (format) {
    case "default":
      return floored.toLocaleString();

    case "scientific": {
      const exp = Math.floor(Math.log10(abs));
      return `${scaled(floored / 10 ** exp)}e${exp}`;
    }

    case "engineering": {
      // Exponent is always a multiple of 3 (mantissa in [1, 1000)).
      const exp = 3 * Math.floor(Math.log10(abs) / 3);
      return `${scaled(floored / 10 ** exp)}e${exp}`;
    }

    case "named": {
      const tier = Math.floor(Math.log10(abs) / 3);
      if (tier <= 0) return String(floored);
      const suffix = NAMED_SUFFIXES[tier] ?? columnLetters(tier);
      return `${scaled(floored / 10 ** (tier * 3))}${suffix}`;
    }

    case "compact": {
      const tier = Math.floor(Math.log10(abs) / 3);
      if (tier <= 0) return String(floored);
      return `${scaled(floored / 10 ** (tier * 3))}${compactSuffix(tier)}`;
    }
  }
}
