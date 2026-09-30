import { ExpNumber } from "./expNumber";
import type { ProductionResourceKey } from "./attributes";

/**
 * Trade routes: the market turns its trade power into goods.
 *
 * A route has three settings — on or off, buy or sell, and an intensity. Every
 * second each enabled route forwards `intensity ×` the trade power income, and
 * one trade power of income is worth `GOLD_PER_TRADE_POWER` gold of goods. The
 * trade power reserve is never spent by a route: routing drains goods and gold,
 * nothing else. The price of a resource is the production ratio against gold, so
 * whatever the settlement produces fastest is what one gold buys most of, and the
 * slowest to sell for gold.
 */

/** Resources with a route: gold is the numeraire, trade power is the fuel. */
export const tradeableResourceKeys = [
  "food",
  "wood",
  "stone",
  "science",
  "military",
  "metalwork",
] as const;

export type TradeResourceKey = (typeof tradeableResourceKeys)[number];

export type TradeMode = "buy" | "sell";

/** One route's settings; `intensity` is a 0–1 share of the trade power income. */
export type TradeRoute = {
  readonly enabled: boolean;
  readonly mode: TradeMode;
  readonly intensity: number;
};

/** Sparse: a resource is absent until its route is configured for the first time. */
export type TradeRouteMap = Partial<Record<TradeResourceKey, TradeRoute>>;

/** Route settings before anything is configured: off, selling, at rest. */
export const defaultTradeRoute: TradeRoute = {
  enabled: false,
  mode: "sell",
  intensity: 0,
};

export const isTradeMode = (value: unknown): value is TradeMode =>
  value === "buy" || value === "sell";

/** Intensity is a share of the bank, so anything outside 0–1 clamps to an end. */
export const clampTradeIntensity = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
};

/**
 * The intensity slider is **logarithmic**: a linear 0–100% control spends nine
 * decades of travel on the range nobody uses, and the range that matters runs from
 * a trickle to the whole reserve. Stops go from 1e-9 of the bank (0.0000001 %)
 * to all of it, ×√10 apart — nineteen positions, each a comfortable thumb step.
 */
export const MIN_TRADE_INTENSITY_EXPONENT = -9;
export const TRADE_INTENSITY_STOPS_PER_DECADE = 2;
export const TRADE_INTENSITY_STOPS =
  -MIN_TRADE_INTENSITY_EXPONENT * TRADE_INTENSITY_STOPS_PER_DECADE;

/** The share a slider stop stands for, from `1e-9` up to `1`. */
export const tradeIntensityForStop = (stop: number): number => {
  const clamped = Math.min(
    Math.max(Math.round(stop), 0),
    TRADE_INTENSITY_STOPS,
  );
  return (
    10 **
    (MIN_TRADE_INTENSITY_EXPONENT + clamped / TRADE_INTENSITY_STOPS_PER_DECADE)
  );
};

/** The stop a share sits on, so a typed value still has a slider position. */
export const tradeIntensityStop = (intensity: number): number => {
  if (!(intensity > 0)) return 0;
  const stop =
    (Math.log10(intensity) - MIN_TRADE_INTENSITY_EXPONENT) *
    TRADE_INTENSITY_STOPS_PER_DECADE;
  return Math.min(Math.max(Math.round(stop), 0), TRADE_INTENSITY_STOPS);
};

/** One trade power of income moves this many gold of goods through a route. */
export const GOLD_PER_TRADE_POWER = 1;

/**
 * Units per gold used when a live rate cannot price a resource — no workers
 * assigned, or nothing generating it yet. It keeps a route from ever dividing by
 * zero, at the cost of a stale price that the card marks as a fallback.
 */
export const tradeRatios: Record<TradeResourceKey, number> = {
  food: 5,
  wood: 5,
  stone: 5,
  science: 25,
  military: 5,
  metalwork: 10,
};

/** Buying costs this multiple of the mid price; selling pays the mid price. */
export const DEFAULT_TRADE_SPREAD = 10;

/**
 * The factor-row id a route contributes for a resource: `<resource> route`, plus
 * `sale` or `purchase` for the crediting leg. Rows carrying one of these are
 * derived from `tradeRoutes` on every read, so they are never stored: a save
 * strips them and the first tick after a reload puts them back.
 */
export const tradeRouteSource = (
  resource: TradeResourceKey,
  direction: "" | "sale" | "purchase" = "",
): string => `${resource} route ${direction}`.trim();

/** Whether a factor row id belongs to a trade route rather than a stored source. */
export const isTradeRouteSource = (source: string): boolean =>
  tradeableResourceKeys.some(
    (resource) =>
      source === `${resource} route` ||
      source === `${resource} route sale` ||
      source === `${resource} route purchase`,
  );

export type TradePrice = {
  /** Mid price: units of the resource per 1 gold. */
  readonly resourcePerGold: ExpNumber;
  /** Mid price: gold per 1 unit of the resource. */
  readonly goldPerResource: ExpNumber;
  /** "production" when the ratio came from live rates, "fallback" otherwise. */
  readonly source: "production" | "fallback";
};

/**
 * The mid price of one tradable resource, from the production ratio:
 * `rate(R) / rate(gold)` units per gold. Gold at 1e15/s against food at 1e21/s
 * prices food at 1e6 units per gold. A zero or drained rate on either side
 * falls back to `tradeRatios`, so the ratio is never a division by zero.
 */
export const getTradePrice = (
  resource: TradeResourceKey,
  rateOf: (key: ProductionResourceKey) => ExpNumber,
): TradePrice => {
  const resourceRate = rateOf(resource);
  const goldRate = rateOf("gold");
  const fromRates =
    resourceRate.gt(ExpNumber.ZERO) && goldRate.gt(ExpNumber.ZERO);
  const resourcePerGold = fromRates
    ? resourceRate.div(goldRate)
    : ExpNumber.fromNumber(tradeRatios[resource]);
  return {
    resourcePerGold,
    goldPerResource: ExpNumber.ONE.div(resourcePerGold),
    source: fromRates ? "production" : "fallback",
  };
};

/** Resource units a gold-denominated volume buys or sells at the mid price. */
export const unitsForVolume = (
  price: TradePrice,
  volume: ExpNumber,
): ExpNumber => volume.mul(price.resourcePerGold);

/** Gold a volume pays out when selling, or costs when buying (the spread). */
export const goldForVolume = (volume: ExpNumber, mode: TradeMode): ExpNumber =>
  mode === "buy"
    ? volume.mul(ExpNumber.fromNumber(DEFAULT_TRADE_SPREAD))
    : volume;

/**
 * The trade multiplier stat: `1 + log₁₀(tradePower + 1)`, so a reserve an order
 * of magnitude deeper is worth one more point of multiplier.
 */
export const calculateTradeMultiplier = (tradePower: ExpNumber): ExpNumber => {
  // Keep the logarithm in ExpNumber space; toNumber() would overflow to Infinity
  // for valid values above the JavaScript double range.
  const logarithm = tradePower.add(ExpNumber.ONE).log10();
  return ExpNumber.ONE.add(ExpNumber.fromNumber(logarithm));
};
