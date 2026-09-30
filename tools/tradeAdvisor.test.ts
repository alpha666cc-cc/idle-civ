import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
  type ResourceAmounts,
  type ResourceKey,
  type WorkerAssignments,
} from "../src/game/attributes";
import type { BuildingKey } from "../src/game/buildings";
import { CivilizationState } from "../src/game/civilizationState";
import { ExpNumber } from "../src/game/expNumber";
import { encounterDefinitions } from "../src/game/encounters";
import { emptyStatistics } from "../src/game/statistics";
import {
  TRADE_INTENSITY_STOPS,
  tradeIntensityForStop,
  type TradeRouteMap,
} from "../src/game/trade";
import { getStrategy } from "./strategies";
import {
  getTradeDirective,
  getTradeRouteAction,
  tradeProfile,
} from "./tradeAdvisor";
import { GameSimulation, type SimulationStrategy } from "./simulation";

/** Ten food and one gold per second before the reserve's trade multiplier. */
const workers = (food: number, gold: number): WorkerAssignments => ({
  ...emptyWorkerAssignments(),
  food: ExpNumber.fromNumber(food),
  gold: ExpNumber.fromNumber(gold),
});

const settlement = ({
  resources = {},
  assignments = emptyWorkerAssignments(),
  buildings = {},
  tradeRoutes = {},
  defeatedEncounters = [],
}: {
  resources?: Partial<Record<ResourceKey, number>>;
  assignments?: WorkerAssignments;
  buildings?: Partial<Record<BuildingKey, number>>;
  tradeRoutes?: TradeRouteMap;
  defeatedEncounters?: string[];
} = {}): CivilizationState => {
  const amounts: ResourceAmounts = { ...emptyResourceAmounts() };
  for (const [key, value] of Object.entries(resources)) {
    amounts[key as ResourceKey] = ExpNumber.fromNumber(value);
  }
  return new CivilizationState(
    amounts,
    assignments,
    { townHall: 1, ...buildings },
    emptyResourceFactors(),
    {},
    0,
    [],
    defeatedEncounters,
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
};

/** Every first-age encounter, so a fixture has no campaign battle left to fight. */
const AGE_ZERO_WON = encounterDefinitions
  .filter((encounter) => encounter.age === 0)
  .map((encounter) => encounter.key);

/**
 * A settlement with a 1e9 reserve (which multiplies every rate by
 * `1 + log10(reserve + 1)` = ×10), three markets feeding it, one gold worker, and
 * every tradable deep in surplus. Food is the only resource with production, so it is
 * the only thing a route can sell — a test only has to move the one resource it
 * cares about to make that resource the settlement's problem.
 */
const balancedSettlement = (
  resources: Partial<Record<ResourceKey, number>> = {},
  tradeRoutes: TradeRouteMap = {},
  extra: { defeatedEncounters?: string[] } = {},
): CivilizationState =>
  settlement({
    resources: {
      trade: 1e9,
      gold: 1e9,
      food: 1e9,
      wood: 1e9,
      stone: 1e9,
      science: 1e9,
      military: 1e9,
      metalwork: 1e9,
      ...resources,
    },
    assignments: workers(10, 1),
    buildings: { market: 3 },
    tradeRoutes,
    defeatedEncounters: extra.defeatedEncounters,
  });

const fullProfile = tradeProfile(TRADE_INTENSITY_STOPS);

describe("simulation trade advisor", () => {
  it("does nothing for a strategy that does not trade", () => {
    expect(getTradeRouteAction(balancedSettlement(), tradeProfile(0))).toBeNull();
  });

  it("leaves an empty reserve alone", () => {
    expect(getTradeDirective(balancedSettlement({ trade: 0 }), fullProfile)).toBeNull();
  });

  it("releases a route the empty reserve cannot feed", () => {
    const state = balancedSettlement(
      { trade: 0 },
      { food: { enabled: true, mode: "sell", intensity: 1 } },
    );
    expect(getTradeDirective(state, fullProfile)).toEqual({
      resource: "food",
      route: { enabled: false, mode: "sell", intensity: 1 },
    });
  });

  it("buys the resource the settlement has run out of", () => {
    const directive = getTradeDirective(
      balancedSettlement({ science: 0 }),
      fullProfile,
    );
    expect(directive?.resource).toBe("science");
    expect(directive?.route.enabled).toBe(true);
    expect(directive?.route.mode).toBe("buy");
  });

  it("never sells a stock nothing produces", () => {
    // Every other resource sits a billion deep with no production behind it. A
    // leftover is dead weight, not a surplus, so food is the only route on offer —
    // selling the dead stock would outbid it and drain the settlement to do it.
    expect(
      getTradeDirective(balancedSettlement(), fullProfile)?.resource,
    ).toBe("food");
  });

  it("sells a surplus, sized to one second of inflow", () => {
    const directive = getTradeDirective(balancedSettlement(), fullProfile);
    expect(directive?.resource).toBe("food");
    expect(directive?.route.mode).toBe("sell");
    // Food arrives at 100/s (10 workers × the reserve's ×10 multiplier) and prices
    // at 10 per gold, so one second of inflow is 10 gold out of the 1e9 reserve.
    expect(directive?.route.intensity).toBeCloseTo(1e-8, 14);
  });

  it("keeps the intensity on a slider stop and inside the profile's cap", () => {
    for (const maxStop of [1, 3, 6, TRADE_INTENSITY_STOPS]) {
      const route = getTradeDirective(
        balancedSettlement(),
        tradeProfile(maxStop),
      )?.route;
      expect(route).toBeDefined();
      if (!route) continue;
      const allowed = Array.from({ length: maxStop + 1 }, (_, stop) =>
        tradeIntensityForStop(stop),
      );
      expect(allowed).toContain(route.intensity);
    }
  });

  it("changes nothing once the route already matches", () => {
    const state = balancedSettlement();
    const directive = getTradeDirective(state, fullProfile);
    expect(directive).not.toBeNull();
    if (!directive) return;

    const routed = state.setTradeRoute(directive.resource, directive.route);
    expect(getTradeRouteAction(routed, fullProfile)).toBeNull();
  });

  it("hands the only route slot over before taking it", () => {
    const routed = balancedSettlement(
      {},
      { wood: { enabled: true, mode: "sell", intensity: 1 } },
    );
    expect(getTradeRouteAction(routed, fullProfile)).toEqual({
      type: "setTradeRoute",
      resource: "wood",
      route: { enabled: false, mode: "sell", intensity: 1 },
    });

    // The engine refuses a second route while the slot is taken, so the swap takes
    // two decisions: free it, then take it.
    const freed = routed.setTradeRoute("wood", { enabled: false });
    const next = getTradeRouteAction(freed, fullProfile);
    expect(next?.resource).toBe("food");
    expect(next?.route.enabled).toBe(true);
  });

  it("moves both legs through the engine on the next tick", () => {
    const state = balancedSettlement();
    const directive = getTradeDirective(state, fullProfile);
    expect(directive).not.toBeNull();
    if (!directive) return;

    const routed = state.setTradeRoute(directive.resource, directive.route);
    expect(routed.getActiveTradeRoutes()).toEqual(["food"]);

    const ticked = routed.tick();
    // The sale credits gold (10 for the sale, 10 for the gold worker), and it sells
    // exactly the inflow, so the shelves end up where they started rather than
    // drained by a route sized to the whole reserve.
    expect(ticked.resources.gold.sub(routed.resources.gold).toNumber()).toBeCloseTo(20, 3);
    expect(ticked.resources.food.toNumber()).toBeCloseTo(
      routed.resources.food.toNumber(),
      3,
    );
  });

  it("pays gold for a purchase instead of giving it away", () => {
    const state = balancedSettlement({ science: 0 });
    const directive = getTradeDirective(state, fullProfile);
    expect(directive?.resource).toBe("science");
    if (!directive) return;

    const routed = state.setTradeRoute(directive.resource, directive.route);
    const ticked = routed.tick();
    expect(ticked.resources.gold.lt(routed.resources.gold)).toBe(true);
    expect(ticked.resources.science.gt(ExpNumber.ZERO)).toBe(true);
  });

  it("registers a trading strategy and leaves the others on no routes", () => {
    const context = {
      gameTime: 0,
      snapshots: [],
      timing: {
        ticks: 0,
        tickMeanMs: 0,
        tickMaxMs: 0,
        decisions: 0,
        decisionMeanMs: 0,
        decisionMaxMs: 0,
      },
    };

    // The trading strategy asks for its route through the real ladder rather than
    // reaching around it. With no campaign battle left, the route is the
    // highest-priority discretionary action it has — it sits below the required
    // battle steps and the simulator's purchases, and above the growth ladder.
    const quiet = balancedSettlement({}, {}, { defeatedEncounters: AGE_ZERO_WON });
    const trader = getStrategy("trader");
    expect(trader?.name).toBe("trader");
    expect(trader?.decideAction(quiet, context)).toEqual({
      type: "setTradeRoute",
      resource: "food",
      route: { enabled: true, mode: "sell", intensity: expect.any(Number) },
    });

    // Every other strategy keeps the default profile, so nothing else ever opens a
    // route: the seven existing benchmarks have to stay exactly where they were.
    for (const name of ["balanced", "production", "economy", "speedrun"]) {
      const action = getStrategy(name)?.decideAction(
        balancedSettlement(),
        context,
      );
      expect(action?.type).not.toBe("setTradeRoute");
    }
  });
});

describe("the simulation runner's trade action", () => {
  it("opens the route and lets the tick move the goods", () => {
    const state = balancedSettlement();
    // A strategy that only ever maintains a route: whatever the advisor asks for is
    // handed straight to the runner, so this covers `executeAction` and the engine's
    // own `setTradeRoute` together.
    const trader: SimulationStrategy = {
      name: "test-trader",
      description: "maintains a route and does nothing else",
      decideAction: (current) => getTradeRouteAction(current, fullProfile),
    };

    const result = new GameSimulation(state, trader, {
      seed: 1,
      objective: { type: "timeLimit", seconds: 10 },
      gatherClicksPerAction: 1,
      maxGameTime: 10,
      recordSnapshots: false,
      fromScratch: false,
    }).run();

    const final = result.finalState;
    expect(final.getActiveTradeRoutes()).toEqual(["food"]);
    expect(final.resources.gold.gt(state.resources.gold)).toBe(true);
    // The reserve is never spent: it is the source, not the cost.
    expect(final.resources.trade.gt(state.resources.trade)).toBe(true);
  });

  it("holds the slot back while the reserve is empty", () => {
    // No market, so nothing ever feeds the reserve and there is nothing to route.
    const state = settlement({
      resources: {
        trade: 0,
        gold: 1e9,
        food: 1e9,
        wood: 1e9,
        stone: 1e9,
        science: 1e9,
        military: 1e9,
        metalwork: 1e9,
      },
      assignments: workers(10, 1),
    });
    expect(state.getTradePowerRate().toNumber()).toBe(0);

    const result = new GameSimulation(
      state,
      {
        name: "test-trader",
        description: "maintains a route and does nothing else",
        decideAction: (current) => getTradeRouteAction(current, fullProfile),
      },
      {
        seed: 1,
        objective: { type: "timeLimit", seconds: 5 },
        gatherClicksPerAction: 1,
        maxGameTime: 5,
        recordSnapshots: false,
        fromScratch: false,
      },
    ).run();

    expect(result.finalState.getActiveTradeRoutes()).toEqual([]);
  });
});
