import { useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Hammer,
  Leaf,
  Pickaxe,
  Store,
  Swords,
  Wheat,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { findAttributeDefinition } from "../game/attributes";
import type { CivilizationState } from "../game/civilizationState";
import type { ExpNumber } from "../game/expNumber";
import {
  clampTradeIntensity,
  DEFAULT_TRADE_SPREAD,
  TRADE_INTENSITY_STOPS,
  tradeIntensityForStop,
  tradeIntensityStop,
  tradeableResourceKeys,
  type TradeMode,
  type TradeResourceKey,
  type TradeRoute,
} from "../game/trade";

/** A share as a readable percentage, from `0.0000001 %` up to `100 %`. */
const percentLabel = (share: number): string => {
  const percent = share * 100;
  if (percent <= 0) return "0";
  if (percent < 0.0001) {
    // Fixed notation on purpose: a trickle must never print as `3.2e-7`, and nine
    // decimals keep the √10 stops (3.162…e-7) from rounding down.
    return percent.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(Number(percent.toPrecision(3)));
};

type Props = {
  gameState: CivilizationState;
  setGameState: (
    update: (current: CivilizationState) => CivilizationState,
  ) => void;
  fmt: (n: ExpNumber | number) => string;
  onNotice: (message: ReactNode) => void;
};

/** Icon + tone per tradable resource, mirroring `resourcePresentation` in App. */
const routePresentation: Record<
  TradeResourceKey,
  { icon: LucideIcon; tone: string }
> = {
  food: { icon: Wheat, tone: "gold" },
  wood: { icon: Leaf, tone: "green" },
  stone: { icon: Pickaxe, tone: "slate" },
  science: { icon: BookOpen, tone: "violet" },
  military: { icon: Swords, tone: "amber" },
  metalwork: { icon: Hammer, tone: "teal" },
};

/** Buying spends gold (arrow up), selling receives it (arrow down). */
const directions: { mode: TradeMode; label: string; icon: LucideIcon }[] = [
  { mode: "buy", label: "Buy", icon: ArrowUp },
  { mode: "sell", label: "Sell", icon: ArrowDown },
];

/**
 * The percentage field beside the slider. It keeps a local draft so typing is
 * never fought by the controlled value, and commits on Enter or blur (Escape
 * reverts) — the same contract as the Dev Tools numeric field. The engine
 * clamps, so the field resyncs to whatever share was actually kept.
 */
const IntensityField = ({
  text,
  ariaLabel,
  onCommit,
}: {
  text: string;
  ariaLabel: string;
  onCommit: (percent: number) => void;
}) => {
  const [draft, setDraft] = useState(text);
  const [syncedText, setSyncedText] = useState(text);

  // Resync during render rather than in an effect, so no extra commit is needed
  // and typing is never clobbered (the committed value only moves on commit).
  if (text !== syncedText) {
    setSyncedText(text);
    setDraft(text);
  }

  const commit = () => {
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed) || draft.trim() === text) {
      setDraft(text);
      return;
    }
    onCommit(parsed);
  };

  return (
    <input
      className="trade-intensity"
      type="text"
      inputMode="numeric"
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(text);
          event.currentTarget.blur();
        }
      }}
    />
  );
};

/**
 * One market route: on or off, buying or selling, and the share of the trade
 * power bank it spends each second. The engine owns every value, so the card only
 * reads the route and writes the change — including the refusal notice when all
 * the route slots are taken.
 */
const TradeRouteCard = ({
  resource,
  gameState,
  setGameState,
  fmt,
  onNotice,
}: Props & { resource: TradeResourceKey }) => {
  const { icon: Icon, tone } = routePresentation[resource];
  const label = findAttributeDefinition(resource)?.label ?? resource;
  const route = gameState.getTradeRoute(resource);
  const price = gameState.getTradePrice(resource);
  const throughput = gameState.getTradeRouteThroughput(resource);
  // The routed flow reads as a gain and a drain, whichever way the route runs: a
  // buy hands gold over, a sell takes it.
  const buying = route.mode === "buy";
  const resourceLeg = buying
    ? `+${fmt(throughput.resourcePerSecond)} ${label.toLowerCase()}`
    : `−${fmt(throughput.resourcePerSecond)} ${label.toLowerCase()}`;
  const goldLeg = buying
    ? `−${fmt(throughput.goldPerSecond)} gold`
    : `+${fmt(throughput.goldPerSecond)} gold`;
  // The frame's caption spells the direction out, so the card is readable without
  // the buttons: a buy route buys the resource and sells the gold.
  const directionText = buying
    ? `buying (${label.toLowerCase()}), selling gold`
    : `selling (${label.toLowerCase()}), buying gold`;
  // The slider is logarithmic, so its position is a stop rather than a percent; the
  // typed field beside it still takes any percentage and lands on the nearest stop.
  const stop = tradeIntensityStop(route.intensity);
  const percentText = percentLabel(route.intensity);
  const slots = gameState.getTradeRouteSlots();
  const canEnable =
    route.enabled || gameState.getActiveTradeRoutes().length < slots;

  const setRoute = (patch: Partial<TradeRoute>) =>
    setGameState((current) => current.setTradeRoute(resource, patch));

  const toggleRoute = () => {
    if (route.enabled) {
      setRoute({ enabled: false });
      return;
    }
    if (!canEnable) {
      onNotice(
        `All ${slots} trade routes are in use. Switch one off before routing ${
          label.toLowerCase()
        }.`,
      );
      return;
    }
    setRoute({ enabled: true });
  };

  return (
    <article
      className={`trade-card trade-route-card ${route.enabled ? "active" : ""}`}
    >
      <div className="trade-resource-header">
        <span className={`resource-icon ${tone}`}>
          <Icon size={16} strokeWidth={1.8} />
        </span>
        <strong className="trade-route-name">{label}</strong>
        <button
          type="button"
          className={`trade-toggle ${route.enabled ? "on" : ""}`}
          aria-pressed={route.enabled}
          aria-disabled={!canEnable}
          title={
            canEnable
              ? "Route banked trade through this resource every second"
              : `Every one of the ${slots} trade routes is already in use`
          }
          onClick={toggleRoute}
        >
          {route.enabled ? "Routing" : "Idle"}
        </button>
      </div>

      <div className="trade-frame">
        <div className="trade-frame-head">
          <span className={`trade-frame-direction ${buying ? "buy" : "sell"}`}>
            {buying ? "Buy" : "Sell"}
          </span>
          <span className="trade-frame-unit">per second</span>
        </div>
        <div className="trade-values">
          <span className={`trade-value ${buying ? "gain" : "drain"}`}>
            {resourceLeg}
          </span>
          <span className={`trade-value ${buying ? "drain" : "gain"}`}>
            {goldLeg}
          </span>
        </div>
      </div>

      <p className={`trade-hint ${route.enabled ? "on" : "off"}`}>
        Route {route.enabled ? "on" : "off"} &mdash; {directionText}.
      </p>

      <p className="trade-price">
        <span className="trade-price-line">
          1 gold = {fmt(price.resourcePerGold)} {label.toLowerCase()}
        </span>
        <small>
          1 {label.toLowerCase()} = {fmt(price.goldPerResource)} gold
          {price.source === "fallback"
            ? " · fallback price, nothing produced yet"
            : ""}
        </small>
      </p>

      <div
        className="trade-mode-group"
        role="group"
        aria-label={`${label} route direction`}
      >
        {directions.map(({ mode, label: direction, icon: DirectionIcon }) => (
          <button
            type="button"
            key={mode}
            className={`trade-mode ${mode} ${route.mode === mode ? "on" : ""}`}
            aria-pressed={route.mode === mode}
            onClick={() => setRoute({ mode })}
          >
            <DirectionIcon size={14} strokeWidth={1.8} />
            {direction}
          </button>
        ))}
      </div>

      <div className="trade-intensity-row">
        <input
          className="trade-slider"
          type="range"
          min={0}
          max={TRADE_INTENSITY_STOPS}
          step={1}
          value={stop}
          aria-label={`${label} route intensity`}
          aria-valuetext={percentText}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value, 10);
            if (Number.isNaN(next)) return;
            setRoute({ intensity: tradeIntensityForStop(next) });
          }}
        />
        <IntensityField
          text={percentText}
          ariaLabel={`${label} route intensity, percent`}
          onCommit={(value) =>
            setRoute({ intensity: clampTradeIntensity(value / 100) })
          }
        />
        <span className="trade-intensity-suffix">%</span>
      </div>
      <p className="trade-intensity-caption">
        Log scale &middot; 0.0000001 % &rarr; 100 %
      </p>
    </article>
  );
};

/**
 * Trade tab: the market's routes. Each one turns banked trade into goods
 * at the production ratio against gold, so the route worth opening is whichever
 * resource the settlement cannot afford to produce itself.
 */
export default function TradePanel({
  gameState,
  setGameState,
  fmt,
  onNotice,
}: Props) {
  return (
    <section className="production-workbench" aria-label="Trade">
      <div className="workbench-heading">
        <div>
          <p className="eyebrow">Commerce</p>
          <h3>Trade</h3>
        </div>
        <span>
          <Store size={14} /> {fmt(gameState.resources.trade)} trade
        </span>
      </div>

      <div className="trade-overview">
        <div className="trade-metric">
          <span className="metric-label">Trade income</span>
          <span className="metric-value">
            +{fmt(gameState.getTradePowerRate())}/s
          </span>
        </div>
        <div className="trade-metric">
          <span className="metric-label">Routes in use</span>
          <span className="metric-value">
            {gameState.getActiveTradeRoutes().length} /{" "}
            {gameState.getTradeRouteSlots()}
          </span>
        </div>
        <div className="trade-metric">
          <span className="metric-label">Buy spread</span>
          <span className="metric-value">×{DEFAULT_TRADE_SPREAD}</span>
        </div>
        <div className="trade-metric">
          <span className="metric-label">Trade value</span>
          <span className="metric-value">
            1 = 1 gold
          </span>
        </div>
        <div className="trade-metric">
          <span className="metric-label">Trade multiplier</span>
          <span className="metric-value">
            ×{fmt(gameState.getTradeMultiplier())}
          </span>
        </div>
      </div>

      <div className="trade-grid">
        {tradeableResourceKeys.map((resource) => (
          <TradeRouteCard
            key={resource}
            resource={resource}
            gameState={gameState}
            setGameState={setGameState}
            fmt={fmt}
            onNotice={onNotice}
          />
        ))}
      </div>
    </section>
  );
}