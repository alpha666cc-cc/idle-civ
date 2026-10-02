import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  type ResourceAmounts,
  type ResourceFactor,
  type ResourceKey,
  type WorkerAssignments,
} from "./attributes";
import type { BuildingKey } from "./buildings";
import { CivilizationState } from "./civilizationState";
import { ExpNumber } from "./expNumber";
import { formatNumber } from "./numberFormat";
import { emptyStatistics } from "./statistics";
import {
  calculateTradeMultiplier,
  clampTradeIntensity,
  DEFAULT_TRADE_SPREAD,
  getTradePrice,
  goldForVolume,
  TRADE_INTENSITY_STOPS,
  tradeableResourceKeys,
  tradeIntensityForStop,
  tradeIntensityStop,
  unitsForVolume,
  type TradeResourceKey,
  type TradeRouteMap,
} from "./trade";

/**
 * A settlement with the given stock, workers and buildings. Prices read the live
 * rates, so the workers handed in here are also what each price is derived from.
 */
const settlement = (
  resources: Partial<ResourceAmounts> = {},
  workers: WorkerAssignments = emptyWorkerAssignments(),
  builtBuildings: Partial<Record<BuildingKey, number>> = {},
  tradeRoutes: TradeRouteMap = {},
): CivilizationState =>
  new CivilizationState(
    { ...emptyResourceAmounts(), ...resources },
    workers,
    builtBuildings,
    emptyResourceFactors(),
    {},
    0,
    [],
    [],
    [],
    [],
    emptyStatistics(),
    {},
    ExpNumber.ONE,
    false,
    false,
    false,
    [],
    {},
    tradeRoutes,
  );

/** Four food and one gold per second, so the mid price is 4 food per gold. */
const foodAndGoldWorkers = (
  gold: number = 1,
  food: number = 4,
): WorkerAssignments => ({
  ...emptyWorkerAssignments(),
  gold: ExpNumber.fromNumber(gold),
  food: ExpNumber.fromNumber(food),
});

const enabledRoute = (
  mode: "buy" | "sell",
  intensity: number = 1,
): TradeRouteMap["food"] => ({ enabled: true, mode, intensity });

/**
 * A settlement whose markets produce `tradePower` trade power per second, so the
 * bank keeps growing. `resources.trade` seeds the reserve a route reads, and the
 * banked amount (not the income) is what a route moves.
 */
const marketState = (
  tradePower: number,
  resources: Partial<ResourceAmounts> = {},
  workers: WorkerAssignments = emptyWorkerAssignments(),
  tradeRoutes: TradeRouteMap = {},
): CivilizationState =>
  settlement(resources, workers, {}, tradeRoutes).addFactor(
    "trade" as ResourceKey,
    "additional",
    ["market", ExpNumber.fromNumber(tradePower)],
  );

/**
 * The value one source contributes, found by its factor row id (`"food route"`).
 * Compared with a tolerance: the price is a ratio of two `ExpNumber`s, so it
 * lands a hair off 400 rather than exactly on it.
 */
const rowValue = (rows: ResourceFactor[], source: string): number => {
  const row = rows.find(([id]) => id === source);
  return row ? row[1].toNumber() : Number.NaN;
};

/** Every drain a resource currently carries, as `[source, value]` rows. */
const drains = (state: CivilizationState, key: ResourceKey): ResourceFactor[] =>
  state.getProductionFactors(key).drain;

/** Every extra production a resource currently carries. */
const additions = (
  state: CivilizationState,
  key: ResourceKey,
): ResourceFactor[] => state.getProductionFactors(key).additional;

/** The rows a trade route contributed, by direction: debits positive, credits negative. */
const routeRows = (rows: ResourceFactor[], pattern: string): ResourceFactor[] =>
  rows.filter(
    ([source]) => typeof source === "string" && source.includes(pattern),
  );

/**
 * Asserts a value against an expected amount within a tolerance. `ExpNumber`
 * keeps ~15 significant digits, so an exact `toBe` on a derived figure drifts in
 * the last bits (400 food prices itself out as 399.99999999999994).
 */
const expectClose = (value: ExpNumber, expected: number): void => {
  expect(Math.abs(value.toNumber() - expected)).toBeLessThan(1e-6);
};

describe("trade multiplier arithmetic", () => {
  it("keeps a finite trade power beyond the JavaScript number range", () => {
    const tradePower = ExpNumber.from("1e400");

    expect(tradePower.isFinite).toBe(true);
    expect(tradePower.toNumber()).toBe(Infinity);

    const multiplier = calculateTradeMultiplier(tradePower);
    expect(multiplier.isFinite).toBe(true);
    expect(multiplier.toNumber()).toBe(401);
    expect(formatNumber(multiplier, "named")).toBe("401");
  });

  it("keeps the zero-trade multiplier at one", () => {
    expect(calculateTradeMultiplier(ExpNumber.ZERO).toNumber()).toBe(1);
  });
});

describe("trade prices", () => {
  it("derives the mid price from the production ratio", () => {
    const rates: Record<string, ExpNumber> = {
      gold: ExpNumber.fromNumber(1e15),
      food: ExpNumber.fromNumber(1e21),
    };
    const price = getTradePrice("food", (key) => rates[key]);

    expect(price.source).toBe("production");
    // Gold at 1e15/s against food at 1e21/s: one gold is worth a million food.
    expect(price.resourcePerGold.toString()).toBe("1e6");
    expect(price.goldPerResource.toString()).toBe("1e-6");
  });

  it("falls back to the static table when a rate cannot price the pair", () => {
    const dead = getTradePrice("food", () => ExpNumber.ZERO);
    expect(dead.source).toBe("fallback");
    expect(dead.resourcePerGold.toNumber()).toBe(5);

    // Food produced but no gold: still a fallback, never a division by zero.
    const foodOnly = getTradePrice("food", (key) =>
      key === "food" ? ExpNumber.TEN : ExpNumber.ZERO,
    );
    expect(foodOnly.source).toBe("fallback");
  });

  it("charges the spread on the buying side only", () => {
    const price = getTradePrice("food", () => ExpNumber.ONE);
    const volume = ExpNumber.fromNumber(100);

    expect(unitsForVolume(price, volume).toNumber()).toBe(100);
    expect(goldForVolume(volume, "sell").toNumber()).toBe(100);
    expect(goldForVolume(volume, "buy").toNumber()).toBe(
      100 * DEFAULT_TRADE_SPREAD,
    );
  });

  it("clamps every intensity into 0..1", () => {
    expect(clampTradeIntensity(-3)).toBe(0);
    expect(clampTradeIntensity(7)).toBe(1);
    expect(clampTradeIntensity(Number.NaN)).toBe(0);
    expect(clampTradeIntensity(0.25)).toBe(0.25);
  });

  it("keeps every intensity inside 0..1", () => {
    expect(clampTradeIntensity(-3)).toBe(0);
    expect(clampTradeIntensity(7)).toBe(1);
    expect(clampTradeIntensity(Number.NaN)).toBe(0);
    expect(clampTradeIntensity(0.25)).toBe(0.25);
  });

  it("scales the slider logarithmically from a trickle to the whole bank", () => {
    expect(TRADE_INTENSITY_STOPS).toBe(18);
    expect(tradeIntensityForStop(0)).toBe(1e-9);
    expect(tradeIntensityForStop(TRADE_INTENSITY_STOPS)).toBe(1);
    // Every step is the same factor, so one thumb turn feels identical everywhere.
    const step = tradeIntensityForStop(3) / tradeIntensityForStop(1);
    expect(step).toBeCloseTo(
      tradeIntensityForStop(5) / tradeIntensityForStop(3),
      10,
    );
  });

  it("clamps slider stops and maps a share back onto the scale", () => {
    expect(tradeIntensityForStop(-5)).toBe(1e-9);
    expect(tradeIntensityForStop(99)).toBe(1);
    expect(tradeIntensityStop(0)).toBe(0);
    expect(tradeIntensityStop(1e-9)).toBe(0);
    expect(tradeIntensityStop(1)).toBe(TRADE_INTENSITY_STOPS);
    // A typed value between two stops lands on the nearer one.
    expect(tradeIntensityStop(tradeIntensityForStop(4) * 1.02)).toBe(4);
    for (let stop = 0; stop <= TRADE_INTENSITY_STOPS; stop += 1) {
      expect(tradeIntensityStop(tradeIntensityForStop(stop))).toBe(stop);
    }
    // The scale is a UI affordance only: any share stays legal, stop or not.
    expect(clampTradeIntensity(0.00037)).toBe(0.00037);
  });

  it("routes every roster resource, gold and trade power excluded", () => {
    expect([...tradeableResourceKeys]).toEqual([
      "food",
      "wood",
      "stone",
      "science",
      "military",
      "metalwork",
    ]);
    expect(tradeableResourceKeys).not.toContain("gold");
    expect(tradeableResourceKeys).not.toContain("trade");
  });
});

describe("trade routes", () => {
  it("sells the banked trade power at the mid price from buildings, not workers", () => {
    const state = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(1_000) },
      foodAndGoldWorkers(),
      { food: enabledRoute("sell") },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);

    // A hundred banked trade power is a hundred gold, and the mid price is four
    // food to the gold (from buildings, not workers), so the route drains 400 food
    // and credits 100 gold. Both legs are drains: the sale is a negative one, so it
    // carries no multiplier.
    expect(rowValue(drains(state, "food"), "food route")).toBeCloseTo(400, 6);
    expect(rowValue(drains(state, "gold"), "food route sale")).toBeCloseTo(
      -100,
      6,
    );
    // Nothing a route does is an addition, so no route row reaches the Add tab.
    expect(routeRows(additions(state, "gold"), "route")).toHaveLength(0);

    // The tick then applies those rows like any other production and upkeep.
    const traded = state.tick();
    expectClose(
      traded.resources.food,
      1_000 + state.computeResourceRate("food").toNumber(),
    );
    expectClose(
      traded.resources.gold,
      state.computeResourceRate("gold").toNumber(),
    );
    // The reserve is untouched.
    expect(traded.resources.trade.toNumber()).toBe(100);
  });

  it("spends only the configured share of the bank", () => {
    const state = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(1_000) },
      foodAndGoldWorkers(),
      { food: enabledRoute("sell", 0.5) },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);

    expect(rowValue(drains(state, "food"), "food route")).toBeCloseTo(200, 6);
    expect(rowValue(drains(state, "gold"), "food route sale")).toBeCloseTo(
      -50,
      6,
    );
    expectClose(state.getTradeRouteThroughput("food").tradePower, 50);
  });

  it("replaces the drain on every read instead of stacking it", () => {
    const state = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(1_000) },
      foodAndGoldWorkers(),
      { food: enabledRoute("sell") },
    );

    // Two reads, one row each: the value is derived, never accumulated.
    expect(drains(state, "food")).toHaveLength(1);
    expect(drains(state, "food")).toHaveLength(1);
    // A tick leaves no row behind for the next one to double.
    expect(drains(state.tick(), "food")).toHaveLength(1);
  });

  it("never spends the trade power reserve", () => {
    const routed = marketState(
      4,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(1_000) },
      foodAndGoldWorkers(),
      { food: enabledRoute("sell") },
    );
    const idle = marketState(
      4,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(1_000) },
      foodAndGoldWorkers(),
    );

    // Routing drains goods and gold, never trade power: a running route leaves the
    // reserve exactly as an idle one does.
    expect(routed.tick().resources.trade.toString()).toBe(
      idle.tick().resources.trade.toString(),
    );
  });

  it("divides what a purchase receives by the spread", () => {
    const state = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), gold: ExpNumber.fromNumber(1_000) },
      foodAndGoldWorkers(),
      { food: enabledRoute("buy") },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);

    // The same hundred gold, but a tenth of the goods: 400 / 10 = 40 food, and
    // the purchase lands as a negative drain rather than an addition.
    expect(rowValue(drains(state, "gold"), "food route")).toBeCloseTo(100, 6);
    expect(rowValue(drains(state, "food"), "food route purchase")).toBeCloseTo(
      -40,
      6,
    );
    expect(routeRows(additions(state, "food"), "route")).toHaveLength(0);
  });

  it("caps a sale at the stock on hand and credits the gold for that", () => {
    // The route would like to sell 400 food, but only ten are on hand.
    const state = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(10) },
      foodAndGoldWorkers(),
      { food: enabledRoute("sell") },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);

    // Ten food is capped in, and the gold credit follows the capped amount:
    // 10 / 4 = 2.5 gold, not the 100 the route asked for.
    expect(rowValue(drains(state, "food"), "food route")).toBeCloseTo(10, 6);
    expect(rowValue(drains(state, "gold"), "food route sale")).toBeCloseTo(
      -2.5,
      6,
    );

    // The tick applies those capped rows like any other production: the ten sold
    // are gone and the tick's own production is untouched.
    const foodRate = state.computeResourceRate("food").toNumber();
    const goldRate = state.computeResourceRate("gold").toNumber();
    const emptied = state.tick();
    expectClose(emptied.resources.food, 10 + foodRate);
    expectClose(emptied.resources.gold, goldRate);
  });

  it("caps a purchase at the purse", () => {
    // Thirty gold cannot cover a hundred, so only thirty is spent.
    const state = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), gold: ExpNumber.fromNumber(30) },
      foodAndGoldWorkers(),
      { food: enabledRoute("buy") },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);

    expect(rowValue(drains(state, "gold"), "food route")).toBeCloseTo(30, 6);
    // 30 gold buys a tenth of 30 × 4 = 12 food.
    expect(rowValue(drains(state, "food"), "food route purchase")).toBeCloseTo(
      -12,
      6,
    );
  });

  it("credits the gold without the production multiplier", () => {
    const idle = marketState(
      0,
      {
        trade: ExpNumber.fromNumber(100),
        gold: ExpNumber.fromNumber(0),
        food: ExpNumber.fromNumber(1e6),
      },
      foodAndGoldWorkers(),
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);
    const routed = idle.setTradeRoute("food", { enabled: true, intensity: 1 });

    // The sale is a negative drain, so gold is the plain rate plus the exact sale
    // — not (rate + sale) × the trade multiplier, which would be ~3× bigger.
    expectClose(
      routed.tick().resources.gold,
      idle.computeResourceRate("gold").toNumber() + 100,
    );
  });

  it("sells nothing at all from an empty larder", () => {
    // The cap is the stock, so an empty one leaves the route idle rather than
    // crediting gold for goods the settlement never had.
    const state = marketState(
      0,
      { trade: ExpNumber.fromNumber(1e6) },
      foodAndGoldWorkers(),
      { food: enabledRoute("sell") },
    );

    expect(drains(state, "food")).toHaveLength(0);
    expect(drains(state, "gold")).toHaveLength(0);

    // Only the plain production remains, with no route row in either direction.
    const traded = state.tick();
    expectClose(
      traded.resources.food,
      state.computeResourceRate("food").toNumber(),
    );
    expectClose(
      traded.resources.gold,
      state.computeResourceRate("gold").toNumber(),
    );
  });

  it("previews the flow even while the route is off", () => {
    const state = marketState(
      0,
      {
        trade: ExpNumber.fromNumber(100),
        food: ExpNumber.fromNumber(1e6),
        gold: ExpNumber.fromNumber(1e6),
      },
      foodAndGoldWorkers(),
      { food: { enabled: false, mode: "sell", intensity: 1 } },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);
    expect(state.getTradeRoute("food").enabled).toBe(false);

    // The card shows what the settings are worth before the route is switched on:
    // the banked trade power, and what it buys on either side.
    const throughput = state.getTradeRouteThroughput("food");
    expectClose(throughput.tradePower, 100);
    expectClose(throughput.goldPerSecond, 100);
    expectClose(throughput.resourcePerSecond, 400);
  });

  it("keeps one route at a time and lets it be swapped", () => {
    const idle = settlement();

    expect(idle.getTradeRouteSlots()).toBe(1);
    const routed = idle.setTradeRoute("food", { enabled: true, intensity: 1 });
    expect(routed.getActiveTradeRoutes()).toEqual(["food"]);

    // Every slot is taken, so a second route is refused: the call is a no-op.
    const refused = routed.setTradeRoute("wood", { enabled: true });
    expect(refused).toBe(routed);

    const swapped = routed
      .setTradeRoute("food", { enabled: false })
      .setTradeRoute("wood", { enabled: true });
    expect(swapped.getActiveTradeRoutes()).toEqual(["wood"]);
  });

  it("serves only the first slot when a save carries extra routes", () => {
    const state = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(1_000) },
      foodAndGoldWorkers(),
      { food: enabledRoute("sell"), wood: enabledRoute("sell") },
    );

    // Food took the only slot, so it is the only route carrying rows.
    expect(state.getActiveTradeRoutes()).toEqual(["food"]);
    expect(drains(state, "food")).toHaveLength(1);
    expect(drains(state, "wood")).toHaveLength(0);
  });

  it("ignores resources the market does not trade", () => {
    const state = settlement();

    expect(
      state.setTradeRoute("gold" as TradeResourceKey, { enabled: true }),
    ).toBe(state);
    // Reconfiguring a route to what it already is changes nothing.
    expect(state.setTradeRoute("food", { enabled: false })).toBe(state);
    expect(
      state.setTradeRoute("food", { enabled: true }).getTradeRoute("food"),
    ).toEqual({ enabled: true, mode: "sell", intensity: 0 });
  });

  it("scales the route legs with a time skip", () => {
    const stock = {
      trade: ExpNumber.fromNumber(100),
      food: ExpNumber.fromNumber(1e6),
    };
    const state = marketState(0, stock, foodAndGoldWorkers(), {
      food: enabledRoute("sell"),
    })
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);
    // The skip switches the route off for the window, so the sixty seconds of
    // production land first, and the route is then applied once for the window.
    const skipped = state.advanceTime(60);
    const untouched = marketState(0, stock, foodAndGoldWorkers())
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ])
      .advanceTime(60);

    expectClose(
      skipped.resources.food,
      untouched.resources.food.toNumber() - 400 * 60,
    );
    expectClose(
      skipped.resources.gold,
      untouched.resources.gold.toNumber() + 100 * 60,
    );
  });

  it("caps a time skip against the balance the window ended with", () => {
    // Only ten food on hand when the skip starts, so a minute of selling asks for
    // far more than that — and the cap is the balance the window produced, not the
    // ten it started with. Everything it ended holding is sold (four food to the
    // gold), and nothing goes negative.
    const stock = {
      trade: ExpNumber.fromNumber(100),
      food: ExpNumber.fromNumber(10),
    };
    const state = marketState(0, stock, foodAndGoldWorkers(), {
      food: enabledRoute("sell"),
    })
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);
    const skipped = state.advanceTime(60);
    const untouched = marketState(0, stock, foodAndGoldWorkers())
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ])
      .advanceTime(60);

    expectClose(skipped.resources.food, 0);
    expectClose(
      skipped.resources.gold,
      untouched.resources.gold.toNumber() +
        untouched.resources.food.toNumber() / 4,
    );
  });

  it("caps a skipped purchase at the purse", () => {
    // One percent of a hundred banked is one gold a second, so sixty seconds of it
    // asks for sixty gold and buys a sixtieth of that in food.
    const stock = {
      trade: ExpNumber.fromNumber(100),
      gold: ExpNumber.fromNumber(1e6),
    };
    const state = marketState(0, stock, foodAndGoldWorkers(), {
      food: enabledRoute("buy", 0.01),
    })
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);
    const bought = state.advanceTime(60);
    const untouched = marketState(0, stock, foodAndGoldWorkers())
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ])
      .advanceTime(60);

    expectClose(
      bought.resources.gold,
      untouched.resources.gold.toNumber() - 60,
    );
    expectClose(
      bought.resources.food,
      untouched.resources.food.toNumber() + 24,
    );
    expect(bought.resources.gold.toNumber()).toBeGreaterThanOrEqual(0);
  });

  it("keeps the citizen upkeep in a time skip", () => {
    // A hundred citizens drain a hundred food a second; the skip applies that rate
    // like any other and then runs the route for the window.
    const state = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e6),
        trade: ExpNumber.fromNumber(100),
      },
      foodAndGoldWorkers(),
      { townHall: 1, house: 200, people: 100 },
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      [],
      [],
      emptyStatistics(),
      {},
      ExpNumber.ONE,
      false,
      false,
      false,
      [],
      {},
      { food: enabledRoute("sell") },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);
    const upkeep = state.getProductionFactors("food").drain;
    const skipped = state.advanceTime(60);

    // The upkeep is still a row on the rate the skip used, and food fell by it.
    expect(upkeep.map(([source]) => String(source))).toContain("people");
    expect(skipped.resources.food.toNumber()).toBeLessThan(1e6);
  });

  it("trade prices are independent of worker assignments", () => {
    // Create a state with buildings but no workers
    const noWorkers = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(1_000) },
      emptyWorkerAssignments(),
      { food: enabledRoute("sell") },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);

    // Create a state with many workers assigned to food
    const manyFoodWorkers = marketState(
      0,
      { trade: ExpNumber.fromNumber(100), food: ExpNumber.fromNumber(1_000) },
      {
        ...emptyWorkerAssignments(),
        food: ExpNumber.fromNumber(100),
        gold: ExpNumber.fromNumber(1),
      },
      { food: enabledRoute("sell") },
    )
      .addFactor("food" as ResourceKey, "additional", [
        "farm",
        ExpNumber.fromNumber(4),
      ])
      .addFactor("gold" as ResourceKey, "additional", [
        "goldMine",
        ExpNumber.fromNumber(1),
      ]);

    // Both should have the same trade price since it's based on buildings, not workers
    const priceNoWorkers = noWorkers.getTradePrice("food");
    const priceManyWorkers = manyFoodWorkers.getTradePrice("food");

    expect(priceNoWorkers.resourcePerGold.toNumber()).toBeCloseTo(4, 6);
    expect(priceManyWorkers.resourcePerGold.toNumber()).toBeCloseTo(4, 6);
    expect(priceNoWorkers.resourcePerGold.toNumber()).toEqual(
      priceManyWorkers.resourcePerGold.toNumber(),
    );

    // The route should drain the same amount in both cases
    expect(rowValue(drains(noWorkers, "food"), "food route")).toBeCloseTo(
      400,
      6,
    );
    expect(rowValue(drains(manyFoodWorkers, "food"), "food route")).toBeCloseTo(
      400,
      6,
    );
  });
});
