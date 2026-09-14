import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Building2,
  Castle,
  Coins,
  Hammer,
  Landmark,
  Leaf,
  Menu,
  Pickaxe,
  Shield,
  Settings,
  Sparkles,
  Swords,
  Users,
  Wheat,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import GamepediaModal from "./components/GamepediaModal";
import { buildingDefinitions } from "./game/buildings";
import { CivilizationState } from "./game/civilizationState";
import { formatNumber, type NumberFormat } from "./game/numberFormat";
import {
  resourceDefinitions,
  type ProductionResourceKey,
  type ResourceKey,
} from "./game/resources";

type Tab =
  | "Production"
  | "Upgrades"
  | "Army"
  | "Research"
  | "Settings"
  | "Dev Tools";
type ResourcePresentation = {
  key: ProductionResourceKey;
  label: string;
  icon: LucideIcon;
  tone: string;
};

type SummaryResource = {
  key: ResourceKey;
  label: string;
  icon: LucideIcon;
  tone: string;
};

type BuildingPresentation = {
  key: string;
  name: string;
  description: string;
  icon: LucideIcon;
  tone: string;
  available: boolean;
};

const tabs: { label: Tab; icon: LucideIcon }[] = [
  { label: "Production", icon: Leaf },
  { label: "Upgrades", icon: ArrowUpRight },
  { label: "Army", icon: Swords },
  { label: "Research", icon: BookOpen },
  { label: "Settings", icon: Settings },
  { label: "Dev Tools", icon: Wrench },
];

const resourcePresentation: Record<
  ProductionResourceKey,
  Omit<ResourcePresentation, "key" | "label">
> = {
  wood: { icon: Leaf, tone: "green" },
  stone: { icon: Pickaxe, tone: "slate" },
  food: { icon: Wheat, tone: "gold" },
  gold: { icon: Coins, tone: "amber" },
};

const productionOrder: ProductionResourceKey[] = [
  "food",
  "wood",
  "stone",
  "gold",
];
const resources: ResourcePresentation[] = productionOrder.map((key) => {
  const resource = resourceDefinitions.find(
    (definition) => definition.key === key,
  )!;
  return {
    key: resource.key as ProductionResourceKey,
    label: resource.label,
    ...resourcePresentation[resource.key as ProductionResourceKey],
  };
});

const summaryResources: SummaryResource[] = [
  { key: "population", label: "Population", icon: Users, tone: "teal" },
  { key: "food", label: "Food", icon: Wheat, tone: "gold" },
  { key: "wood", label: "Wood", icon: Leaf, tone: "green" },
  { key: "stone", label: "Stone", icon: Pickaxe, tone: "slate" },
  { key: "gold", label: "Gold", icon: Coins, tone: "amber" },
  { key: "science", label: "Science", icon: Sparkles, tone: "violet" },
];

const numberFormatStorageKey = "idle-civ:number-format";

const numberFormatOptions: { value: NumberFormat; label: string }[] = [
  { value: "scientific", label: "Scientific" },
  { value: "engineering", label: "Engineering" },
  { value: "named", label: "Named" },
  { value: "compact", label: "Compact" },
];

const loadNumberFormat = (): NumberFormat => {
  try {
    const stored = window.localStorage.getItem(numberFormatStorageKey);
    if (stored) {
      for (const option of numberFormatOptions) {
        if (option.value === stored) return option.value;
      }
    }
  } catch {
    // localStorage unavailable – fall back to the named format.
  }
  return "named";
};

const buildingPresentation: Record<string, { icon: LucideIcon; tone: string }> =
  {
    people: { icon: Users, tone: "teal" },
    house: { icon: Building2, tone: "teal" },
    farm: { icon: Wheat, tone: "gold" },
    "lumber-yard": { icon: Leaf, tone: "green" },
    quarry: { icon: Pickaxe, tone: "slate" },
    "gold-mine": { icon: Coins, tone: "amber" },
    market: { icon: Landmark, tone: "red" },
    "town-hall": { icon: Castle, tone: "violet" },
    smithy: { icon: Hammer, tone: "orange" },
    barracks: { icon: Shield, tone: "blue" },
    university: { icon: BookOpen, tone: "pink" },
    monument: { icon: Landmark, tone: "locked" },
  };

const buildings: BuildingPresentation[] = buildingDefinitions.map(
  (building) => ({
    key: building.key,
    name: building.name,
    description: building.description,
    available: building.available,
    ...buildingPresentation[building.key],
  }),
);


type Multiplier =
  | 1
  | 10
  | 100
  | 1000
  | 10000
  | 100000
  | 1000000
  | 10000000
  | 100000000
  | 1000000000
  | "Max";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("Production");
  const [multiplier, setMultiplier] = useState<Multiplier>(1);
  const [largeMultiplier, setLargeMultiplier] = useState<number>(100);
  const [showLargeDropdown, setShowLargeDropdown] = useState(false);
  const [numberFormat, setNumberFormat] =
    useState<NumberFormat>(loadNumberFormat);
  const [notice, setNotice] = useState<ReactNode>(
    "The first settlers have found fertile ground.",
  );
  const [gameState, setGameState] = useState(() => new CivilizationState());
  const [gamepediaOpen, setGamepediaOpen] = useState(false);
  const [gamepediaFocusId, setGamepediaFocusId] = useState<string | null>(null);
  const [autoBuyBuildings, setAutoBuyBuildings] = useState(false);
  const [autoAssignWorkers, setAutoAssignWorkers] = useState(false);

  const fmt = (n: number) => formatNumber(n, numberFormat);

  const {
    resources: resourceAmounts,
    population,
    maximumPopulation,
    workers,
    availableWorkers,
  } = gameState;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setGameState((current) => {
        let next = current.tick();
        if (autoBuyBuildings) next = next.autoBuyBuildings();
        if (autoAssignWorkers) next = next.autoAssignWorkers();
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoBuyBuildings, autoAssignWorkers]);

  useEffect(() => {
    try {
      window.localStorage.setItem(numberFormatStorageKey, numberFormat);
    } catch {
      // localStorage unavailable – setting simply won't persist.
    }
  }, [numberFormat]);

  const gatherResource = (resourceKey: ProductionResourceKey) => {
    setGameState((current) => current.gather(resourceKey));
  };

  const changeWorkers = (
    resourceKey: ProductionResourceKey,
    change: number,
  ) => {
    const amount = multiplier === "Max" ? Infinity : multiplier;
    if (change > 0 && availableWorkers <= 0) {
      setNotice("No unassigned population is available for this task yet.");
      return;
    }
    setGameState((current) =>
      change > 0
        ? current.assignWorker(resourceKey, amount)
        : current.unassignWorker(resourceKey, amount),
    );
  };

  const buyBuilding = (building: BuildingPresentation) => {
    if (!building.available) {
      setNotice(`${building.name} will unlock as your civilization advances.`);
      return;
    }

    const maxAffordable = gameState.getMaxAffordableBuildings(building.key);
    let targetCount = multiplier === "Max" ? maxAffordable : multiplier;

    if (maxAffordable === 0) {
      const failureReason = gameState.getBuildFailureReason(building.key, 1);
      if (failureReason === "capacity") {
        if (building.key === "people") {
          setNotice(
            "Citizen capacity reached. Build more houses to increase capacity.",
          );
        } else if (building.key === "house") {
          setNotice(
            "House capacity reached. Build more Town Halls to increase capacity.",
          );
        } else {
          setNotice(
            <span>
              {building.name} capacity reached.{" "}
              <button
                type="button"
                className="notice-link"
                onClick={() => setActiveTab("Upgrades")}
              >
                Go to Upgrades tab &rarr;
              </button>
            </span>,
          );
        }
      } else if (failureReason === "resources") {
        setNotice(
          <span>
            You need more resources to build {building.name}.{" "}
            <button
              type="button"
              className="notice-link"
              onClick={() => setActiveTab("Production")}
            >
              Go to Production tab &rarr;
            </button>
          </span>,
        );
      }
      return;
    }

    if (multiplier !== "Max" && targetCount > maxAffordable) {
      targetCount = maxAffordable;
    }

    setGameState((current) => current.build(building.key, targetCount));
    setNotice(
      `${targetCount} ${building.name} founded. Your settlement grows stronger.`,
    );
  };

  const openGamepediaAt = (id: string) => {
    setGamepediaFocusId(id);
    setGamepediaOpen(true);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Landmark size={20} strokeWidth={1.8} />
          </div>
          <div>
            <h1>Idle-civilization</h1>
          </div>
        </div>

        <div className="era-card">
          <span className="era-label">Current era</span>
          <strong>Neolithic Dawn</strong>
          <span className="era-progress">
            <i />
          </span>
          <span className="era-meta">
            <span>Year 12</span>
            <span>68% to Bronze Age</span>
          </span>
        </div>

        <nav className="tab-list" aria-label="Main game sections">
          <span className="nav-caption">Civilization</span>
          {tabs.map(({ label, icon: Icon }) => (
            <button
              className={`tab-button ${activeTab === label ? "active" : ""}`}
              key={label}
              onClick={() => setActiveTab(label)}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="resource-panel">
          <div className="section-heading">
            <span className="nav-caption">Treasury</span>
            <button className="icon-button" aria-label="Open treasury menu">
              <Menu size={16} />
            </button>
          </div>
          <div className="resource-list">
            {summaryResources.map(({ key, label, icon: Icon, tone }) => (
              <button
                className="resource-row summary-resource-button"
                key={key}
                onClick={() => openGamepediaAt(key)}
                title={`Open ${label} in gamepedia`}
              >
                <div className={`resource-icon ${tone}`}>
                  <Icon size={16} strokeWidth={1.8} />
                </div>
                <div className="resource-copy">
                  <span>{label}</span>
                  <strong>
                    {key === "population"
                      ? `${availableWorkers}/${population}`
                      : fmt(resourceAmounts[key])}
                  </strong>
                  {key === "population" && (
                    <small>capacity {maximumPopulation}</small>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>

        <div className="sidebar-footer">
          <span className="pulse" /> Autosaving <span>just now</span>
        </div>
      </aside>

      <section className="world-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <span>HOME</span>
            <b>/</b>
            <strong>{activeTab.toUpperCase()}</strong>
          </div>
        </header>

        <div className="world-content">
          {activeTab === "Dev Tools" && (
            <section className="dev-tools-panel" aria-label="Developer tools">
              <div>
                <p className="eyebrow">Simulation controls</p>
                <h3>Auto clicker</h3>
                <p className="dev-tools-copy">
                  Generate clicks per second for every gatherable resource
                  (population is excluded).
                </p>
              </div>
              <label className="dev-tools-control">
                <span>Clicks / second</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={gameState.autoClicksPerSecond}
                  onChange={(event) =>
                    setGameState((current) =>
                      current.setAutoClicksPerSecond(
                        Number(event.target.value),
                      ),
                    )
                  }
                />
              </label>
              <label className="dev-tools-control">
                <span>Auto buy buildings</span>
                <input
                  type="checkbox"
                  checked={autoBuyBuildings}
                  onChange={(event) =>
                    setAutoBuyBuildings(event.target.checked)
                  }
                  aria-label="Auto buy affordable buildings"
                />
              </label>
              <label className="dev-tools-control">
                <span>Auto assign workers</span>
                <input
                  type="checkbox"
                  checked={autoAssignWorkers}
                  onChange={(event) =>
                    setAutoAssignWorkers(event.target.checked)
                  }
                  aria-label="Auto assign up to 10 idle workers per tick"
                />
              </label>
            </section>
          )}

          {activeTab === "Production" && (
            <section className="production-workbench" aria-label="Production">
              <div className="workbench-heading">
                <div>
                  <p className="eyebrow">Available actions</p>
                  <h3>Produce resources</h3>
                </div>
                <span>
                  <Users size={14} /> {availableWorkers} workers available
                </span>
              </div>
              <div className="gather-grid">
                {resources.map(({ key, label, icon: Icon, tone }) => (
                  <div className="gather-card" key={key}>
                    <button
                      className={`gather-button ${tone}`}
                      onClick={() => gatherResource(key)}
                    >
                      <span className="gather-card-icon">
                        <Icon size={18} strokeWidth={1.8} />
                      </span>
                      <span>
                        <strong>{label}</strong>
                        <small>
                          {fmt(resourceAmounts[key])} stored
                        </small>
                      </span>
                      <span className="gather-action">+1</span>
                    </button>
                    <div
                      className="worker-controls"
                      aria-label={`${label} workers`}
                    >
                      <button
                        onClick={() => changeWorkers(key, -1)}
                        disabled={workers[key] === 0}
                        aria-label={`Remove ${label} worker`}
                      >
                        −
                      </button>
                      <span>{workers[key]}</span>
                      <button
                        onClick={() => changeWorkers(key, 1)}
                        disabled={availableWorkers === 0}
                        aria-label={`Assign ${label} worker`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {activeTab === "Upgrades" && (
            <section className="production-workbench" aria-label="Upgrades">
              <div className="workbench-heading">
                <div>
                  <p className="eyebrow">Civilization advancement</p>
                  <h3>Upgrades</h3>
                </div>
              </div>
              <p className="tab-placeholder-copy">
                Building upgrades and capacity expansions will unlock as your
                settlement advances.
              </p>
            </section>
          )}

          {activeTab === "Settings" && (
            <section className="settings-panel" aria-label="Settings">
              <div className="workbench-heading">
                <div>
                  <p className="eyebrow">Preferences</p>
                  <h3>Number format</h3>
                </div>
              </div>
              <p className="dev-tools-copy">
                Choose how large numbers are displayed throughout the game.
                The preview below shows how each option formats{" "}
                {fmt(12_345_678_900)}.
              </p>
              <div
                className="format-picker"
                role="group"
                aria-label="Number format"
              >
                {numberFormatOptions.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    className={`format-option ${
                      numberFormat === value ? "active" : ""
                    }`}
                    onClick={() => setNumberFormat(value)}
                    aria-pressed={numberFormat === value}
                  >
                    <strong>{label}</strong>
                    <small>{formatNumber(12_345_678_900, value)}</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="notice-bar">
            <Sparkles size={16} />
            <span>{notice}</span>
          </div>
        </div>
      </section>

      <aside className="buildings-panel">
        <div className="buildings-header">
          <h2>Build</h2>
          <span className="building-count">
            {gameState.builtBuildings.length} built
          </span>
        </div>
        <div className="building-grid">
          {buildings.map((building) => {
            const Icon = building.icon;
            const buildingCount = gameState.builtBuildings.filter(
              (builtKey) => builtKey === building.key,
            ).length;
            return (
              <button
                className={`building-card ${!building.available ? "locked" : ""}`}
                key={building.name}
                onClick={() => buyBuilding(building)}
              >
                <span className={`building-icon ${building.tone}`}>
                  <Icon size={19} strokeWidth={1.7} />
                </span>
                <span className="building-info">
                  <span className="building-title-row">
                    <strong>{building.name}</strong>
                    <small>{building.description}</small>
                    <span className="building-count-inline">
                      {buildingCount}/{gameState.getBuildingMax(building.key)}
                    </span>
                  </span>
                  <em>
                    {gameState.formatBuildingCost(
                      building.key,
                      buildingCount,
                      multiplier === "Max"
                        ? Math.max(
                            1,
                            gameState.getMaxAffordableBuildings(building.key),
                          )
                        : multiplier,
                      fmt,
                    )}
                  </em>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div
        className="fab-container"
        onMouseLeave={() => setShowLargeDropdown(false)}
      >
        <div className="multiplier-buttons">
          {([1, 10] as const).map((v) => (
            <button
              key={v}
              className={`multiplier-button ${multiplier === v ? "active" : ""}`}
              onClick={() => {
                setMultiplier(v);
                setShowLargeDropdown(false);
              }}
            >
              {v}
            </button>
          ))}
          <div className="multiplier-dropdown-anchor">
            <button
              className={`multiplier-button ${
                typeof multiplier === "number" && multiplier >= 100
                  ? "active"
                  : ""
              }`}
              onMouseDown={() => setShowLargeDropdown(true)}
              onClick={() => {
                setMultiplier(largeMultiplier as Multiplier);
              }}
            >
              {fmt(largeMultiplier)}
            </button>
            {showLargeDropdown && (
              <div className="large-dropdown">
                {[
                  100, 1000, 10000, 100000, 1000000, 10000000, 100000000,
                  1000000000,
                ].map((v) => (
                  <button
                    key={v}
                    className={`multiplier-button ${multiplier === v ? "active" : ""}`}
                    onClick={() => {
                      setLargeMultiplier(v);
                      setMultiplier(v as Multiplier);
                      setShowLargeDropdown(false);
                    }}
                  >
                    {fmt(v)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={`multiplier-button ${multiplier === "Max" ? "active" : ""}`}
            onClick={() => {
              setMultiplier("Max");
              setShowLargeDropdown(false);
            }}
          >
            Max
          </button>
        </div>
        <button
          className="gamepedia-fab"
          onClick={() => {
            setGamepediaFocusId(null);
            setGamepediaOpen(true);
          }}
          aria-label="Open gamepedia"
          title="Gamepedia"
        >
          <BookOpen size={20} strokeWidth={1.9} />
          <span>Pedia</span>
        </button>
      </div>

      {gamepediaOpen && (
        <GamepediaModal
          gameState={gameState}
          numberFormat={numberFormat}
          focusId={gamepediaFocusId}
          onClose={() => {
            setGamepediaOpen(false);
            setGamepediaFocusId(null);
          }}
        />
      )}
    </main>
  );
}

export default App;
