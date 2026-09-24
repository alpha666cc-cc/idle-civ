import { ExpNumber } from "./expNumber";
import type { ResourceKey } from "./attributes";

/**
 * Trade system configuration and mechanics
 * Resources can be bought/sold for gold based on fixed ratios
 * Trade power acts as a currency for conversions
 */

export type TradeResourceKey = ResourceKey;

/**
 * Fixed trade ratios: how many resource units equal 1 gold when selling
 * Buying costs 10x the sell price (the "spread")
 */
export const tradeRatios: Record<string, number> = {
  food: 5, // 5 food = 1 gold (sell), 1 food = 5 gold (buy)
  wood: 5, // 5 wood = 1 gold (sell), 1 wood = 5 gold (buy)
  stone: 5, // 5 stone = 1 gold (sell), 1 stone = 5 gold (buy)
  gold: 1, // 1 gold = 1 gold (sell), 1 gold = 1 gold (buy)
  science: 25, // 1 science = 25 gold (sell), 1 science = 250 gold (buy)
  military: 5, // 5 military = 1 gold (sell), 1 military = 50 gold (buy)
  metalwork: 10, // 1 metalwork = 10 gold (sell), 1 metalwork = 100 gold (buy)
};

/**
 * The buy/sell spread factor (default 10x)
 * Can be configured via bonuses/research in the future
 */
export const DEFAULT_TRADE_SPREAD = 10;

/**
 * Calculate the gold value of a resource amount (sell price)
 */
export const resourceToGold = (
  resource: TradeResourceKey,
  amount: ExpNumber,
): ExpNumber => {
  const ratio = tradeRatios[resource];
  if (ratio === 0) return ExpNumber.ZERO;
  return amount.div(ExpNumber.fromNumber(ratio));
};

/**
 * Calculate the resource amount for a given gold amount (buy price)
 * Includes the trade spread factor
 */
export const goldToResource = (
  resource: TradeResourceKey,
  gold: ExpNumber,
  spread: number = DEFAULT_TRADE_SPREAD,
): ExpNumber => {
  const ratio = tradeRatios[resource];
  if (ratio === 0) return ExpNumber.ZERO;
  return gold.mul(ExpNumber.fromNumber(ratio * spread));
};

/**
 * Calculate the trade production multiplier bonus
 * Formula: 1 + log₁₀(trade + 1)
 */
export const calculateTradeMultiplier = (tradePower: ExpNumber): ExpNumber => {
  // Keep the logarithm in ExpNumber space; toNumber() would overflow to Infinity
  // for valid values above the JavaScript double range.
  const logarithm = tradePower.add(ExpNumber.ONE).log10();
  return ExpNumber.ONE.add(ExpNumber.fromNumber(logarithm));
};

/**
 * Check if a resource is tradable
 */
export const isTradable = (resource: TradeResourceKey): boolean => {
  return tradeRatios[resource] > 0;
};
