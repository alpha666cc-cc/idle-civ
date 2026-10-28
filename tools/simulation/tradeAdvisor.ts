/**
 * Market trade routes for the balance simulation: which route a strategy should be
 * running, and at what intensity.
 *
 * Trade power is a reserve nothing else spends — markets bank it, no cost list
 * pays for it, and without a route it simply accumulates. This module is how a
 * strategy puts that reserve to work, and it drives the real engine entry point
 * (`CivilizationState.setTradeRoute`), so a simulated route is the same route the
 * Trade tab configures: same price, same spread, same per-tick drain rows.
 *
 * The policy in one sentence: **point the route at the resource whose stock has
 * drifted furthest from what the settlement's own production justifies, and size it
 * to the flow it should move rather than to the reserve it could liquidate.**
 *
 * - Every tradable resource gets a *buffer* — a few seconds of its own net
 *   production. Stock below the buffer is a shortage (buy it back), stock above it
 *   is a surplus (sell it). A resource the settlement produces nothing of yet is
 *   sized against the slowest thing it does make, so buying one starts as a trickle
 *   rather than a flood.
 * - Candidates are ranked in **gold**, the currency every price in the game is
 *   quoted in: a flow is worth `units × goldPerResource`, and buying one costs that
 *   again multiplied by the spread. Gold is what makes "sell this" and "buy that"
 *   comparable — units of food and units of science are not.
 * - The route is **sized to a flow**. A sell route moves one second of the
 *   resource's inflow, so a surplus drains as fast as it builds; a buy route
 *   replaces the shortfall it found over a fixed window. Asking the reserve for its
 *   whole share would instead dump the settlement's entire stock into gold on the
 *   first tick and leave nothing to sell on the next. A resource nothing produces
 *   has no inflow to sell, so it is a candidate for a purchase but never for a
 *   sale — a stock the settlement stopped making is dead weight, not a surplus.
 * - Every rate is read with the settlement's own route rows put back, so a route can
 *   never consume the production it is judged on and then conclude it has none.
 * - Because a route converts `intensity × reserve × gold-per-trade`, the intensity
 *   is sized against the bank's current gold value and quantised onto the same
 *   logarithmic slider stops the Trade tab uses. That keeps the decision cheap:
 *   the intensity only moves when the target flow moves by a factor of √10.
 *
 * The advisor holds no memory of its own — the route settings on the state are the
 * memory — so `decideAction` stays a pure function and a route swap cannot flap
 * between two nearly-equal imbalances.
 */

import type { CivilizationState } from "../../src/game/civilizationState.js";
import { ExpNumber } from "../../src/game/expNumber.js";
import {
  DEFAULT_TRADE_SPREAD,
  TRADE_INTENSITY_STOPS,
  isTradeRouteSource,
  tradeableResourceKeys,
  tradeIntensityForStop,
  tradeIntensityStop,
  type TradeMode,
  type TradeResourceKey,
  type TradeRoute,
} from "../../src/game/trade.js";
import type { SimulationAction } from "./simulation.js";

/** Seconds of a resource's own production it should carry before it is tradable. */
const BUFFER_SECONDS = ExpNumber.fromNumber(600);

/** Seconds over which a buy route replaces the shortfall it found. */
const TOP_UP_SECONDS = ExpNumber.fromNumber(600);

/** How far ahead another candidate must be before a running route is re-pointed. */
const SWITCH_MARGIN = ExpNumber.fromNumber(2);

const SPREAD = ExpNumber.fromNumber(DEFAULT_TRADE_SPREAD);

/**
 * How much a strategy is willing to lean on trade. `maxStop` is a slider stop, so
 * it is bounded by the same grid the Trade tab exposes; `0` means "do not trade".
 * `bias` pins one direction instead of letting the balance sheet choose.
 */
export type TradeProfile = {
  readonly maxStop: number;
  readonly bias: TradeMode | "auto";
};

export const tradeProfile = (
  maxStop: number,
  bias: TradeMode | "auto" = "auto",
): TradeProfile => ({
  maxStop: Math.min(
    Math.max(Math.round(maxStop) || 0, 0),
    TRADE_INTENSITY_STOPS,
  ),
  bias,
});

/** One imbalance the settlement could trade away, valued in gold per second. */
type Candidate = {
  readonly resource: TradeResourceKey;
  readonly mode: TradeMode;
  readonly goldPerSecond: ExpNumber;
};

/** What the settlement should be running, or `null` when it should change nothing. */
export type TradeDirective = {
  readonly resource: TradeResourceKey;
  readonly route: TradeRoute;
};

/**
 * Every route switched on, in trade order. Wider than the served set: the slot cap
 * is applied by the engine when a route is enabled, not when it is configured.
 */
const enabledRoutes = (state: CivilizationState): TradeResourceKey[] =>
  tradeableResourceKeys.filter((resource) =>
    state.getTradeRoute(resource).enabled,
  );

/**
 * A tradable resource's net rate with the settlement's own trade rows taken back out.
 *
 * The engine prices a route from `baseProductionFactors` so that a route can never
 * price itself, and the advisor needs the same discipline with the rate: a running
 * route's drain is part of `computeResourceRate`, so a sell route would otherwise
 * read the very production it is consuming as gone and walk away from the resource
 * it is serving. `computeResourceRate` subtracts drains last, so adding them back
 * recovers the pre-route rate exactly.
 */
const baseNetRate = (
  state: CivilizationState,
  resource: TradeResourceKey,
  routing: boolean,
): ExpNumber => {
  const rate = state.computeResourceRate(resource);
  if (!routing) return rate;
  const routeRows = state
    .getProductionFactors(resource)
    .drain.filter(
      ([source]) => typeof source === "string" && isTradeRouteSource(source),
    );
  return routeRows.reduce((restored, [, value]) => restored.add(value), rate);
};

/**
 * The stand-in rate for a resource the settlement produces nothing of yet: the
 * slowest thing it does produce, so a first purchase of it is a small trickle
 * rather than whatever the static fallback ratio would imply.
 */
const slowestPositiveRate = (
  state: CivilizationState,
  routing: boolean,
): ExpNumber => {
  let slowest: ExpNumber | null = null;
  for (const resource of tradeableResourceKeys) {
    const rate = baseNetRate(state, resource, routing);
    if (rate.lte(ExpNumber.ZERO)) continue;
    if (slowest === null || rate.lt(slowest)) slowest = rate;
  }
  return slowest ?? ExpNumber.ONE;
};

/** Every tradable resource the settlement is meaningfully out of balance on. */
const getCandidates = (
  state: CivilizationState,
  profile: TradeProfile,
): Candidate[] => {
  const routing = enabledRoutes(state).length > 0;
  const fallback = slowestPositiveRate(state, routing);
  const candidates: Candidate[] = [];

  for (const resource of tradeableResourceKeys) {
    const stock = state.resources[resource];
    // Net rate: worker production plus building output minus upkeep, so a resource
    // the settlement is actively losing never reads as surplus — and with any route
    // rows of its own taken back out, so a sell route does not read the production
    // it is consuming as gone.
    const rate = baseNetRate(state, resource, routing);
    const { goldPerResource } = state.getTradePrice(resource);
    const buffer = (rate.gt(ExpNumber.ZERO) ? rate : fallback).mul(
      BUFFER_SECONDS,
    );
    const shortage = ExpNumber.max(ExpNumber.ZERO, buffer.sub(stock));
    const surplus = ExpNumber.max(ExpNumber.ZERO, stock.sub(buffer));

    if (shortage.gt(ExpNumber.ZERO)) {
      if (profile.bias === "sell") continue;
      // Buying costs the mid price times the spread, so topping a shortfall up
      // `shortage / window` per second costs that many units at that price.
      const goldPerSecond = shortage
        .div(TOP_UP_SECONDS)
        .mul(goldPerResource)
        .mul(SPREAD);
      if (goldPerSecond.gt(ExpNumber.ZERO)) {
        candidates.push({ resource, mode: "buy", goldPerSecond });
      }
      continue;
    }

    // Nothing produces this, so there is no inflow to sell: a leftover stock is
    // dead weight rather than a surplus, and the route is better spent elsewhere.
    if (surplus.gt(ExpNumber.ZERO) && rate.gt(ExpNumber.ZERO)) {
      if (profile.bias === "buy") continue;
      candidates.push({
        resource,
        mode: "sell",
        goldPerSecond: rate.mul(goldPerResource),
      });
    }
  }

  return candidates;
};

/**
 * The candidate to serve: the largest imbalance in gold, unless the route already
 * running is within `SWITCH_MARGIN` of it. Without that margin a settlement sitting
 * between two similar imbalances would re-point its only route every second and
 * pay the spread twice for the privilege.
 */
const pickCandidate = (
  state: CivilizationState,
  candidates: readonly Candidate[],
): Candidate | null => {
  if (candidates.length === 0) return null;
  const best = candidates.reduce((left, right) =>
    right.goldPerSecond.gt(left.goldPerSecond) ? right : left,
  );

  const serving = enabledRoutes(state)[0];
  const running = serving
    ? candidates.find(
        (candidate) =>
          candidate.resource === serving &&
          candidate.mode === state.getTradeRoute(serving).mode,
      )
    : undefined;
  if (
    running &&
    running.goldPerSecond.mul(SWITCH_MARGIN).gte(best.goldPerSecond)
  ) {
    return running;
  }
  return best;
};

/** The share of the banked reserve that moves `goldPerSecond`, on a slider stop. */
const intensityFor = (
  state: CivilizationState,
  goldPerSecond: ExpNumber,
  profile: TradeProfile,
): number => {
  const bank = state.resources.trade;
  if (bank.lte(ExpNumber.ZERO)) return 0;
  // The engine values each reserve unit against raw gold production before
  // routing, so size the share against that converted bank.
  const valuedBank = bank.mul(state.getGoldPerTradePower());
  const share = goldPerSecond.div(valuedBank).toNumber();
  return tradeIntensityForStop(
    Math.min(profile.maxStop, tradeIntensityStop(share)),
  );
};

/** The route the settlement should be running, or null when it already is. */
export const getTradeDirective = (
  state: CivilizationState,
  profile: TradeProfile,
): TradeDirective | null => {
  if (profile.maxStop <= 0) return null;

  const serving = enabledRoutes(state)[0];
  // An empty reserve moves nothing, and a route that cannot move anything only
  // holds a slot another resource could be using.
  const release = (): TradeDirective | null =>
    serving
      ? {
          resource: serving,
          route: { ...state.getTradeRoute(serving), enabled: false },
        }
      : null;
  if (state.resources.trade.lte(ExpNumber.ZERO)) return release();

  const chosen = pickCandidate(state, getCandidates(state, profile));
  if (!chosen) return release();

  const route: TradeRoute = {
    enabled: true,
    mode: chosen.mode,
    intensity: intensityFor(state, chosen.goldPerSecond, profile),
  };
  const current = state.getTradeRoute(chosen.resource);
  if (
    current.enabled &&
    current.mode === route.mode &&
    current.intensity === route.intensity
  ) {
    return null;
  }
  return { resource: chosen.resource, route };
};

/**
 * The route action for this turn, or null when the settlement's routes already say
 * what they should.
 *
 * The engine refuses to enable a second route while every slot is taken, so a swap
 * hands the slot over first: this frees the running route, and the next decision —
 * same simulated second, the runner spends several actions per tick — fills it.
 */
export const getTradeRouteAction = (
  state: CivilizationState,
  profile: TradeProfile,
): SimulationAction | null => {
  const directive = getTradeDirective(state, profile);
  if (!directive) return null;
  const holding = enabledRoutes(state).find(
    (resource) => resource !== directive.resource,
  );
  if (holding !== undefined && directive.route.enabled) {
    return {
      type: "setTradeRoute",
      resource: holding,
      route: { ...state.getTradeRoute(holding), enabled: false },
    };
  }
  return {
    type: "setTradeRoute",
    resource: directive.resource,
    route: directive.route,
  };
};
