import { useEffect, useState } from "react";
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
    academy: { icon: BookOpen, tone: "pink" },
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

const formatResourceAmount = (amount: number): string =>
  Math.floor(amount).toLocaleString();

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("Production");
  const [notice, setNotice] = useState(
    "The first settlers have found fertile ground.",
  );
  const [gameState, setGameState] = useState(() => new CivilizationState());
  const [gamepediaOpen, setGamepediaOpen] = useState(false);
  const [gamepediaFocusId, setGamepediaFocusId] = useState<string | null>(null);

  const {
    resources: resourceAmounts,
    population,
    maximumPopulation,
    workers,
    availableWorkers,
  } = gameState;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setGameState((current) => current.tick());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const gatherResource = (resourceKey: ProductionResourceKey) => {
    setGameState((current) => current.gather(resourceKey));
  };

  const changeWorkers = (
    resourceKey: ProductionResourceKey,
    change: number,
  ) => {
    if (change > 0 && availableWorkers <= 0) {
      setNotice("No unassigned population is available for this task yet.");
      return;
    }
    setGameState((current) =>
      change > 0
        ? current.assignWorker(resourceKey)
        : current.unassignWorker(resourceKey),
    );
  };

  const buyBuilding = (building: BuildingPresentation) => {
    if (!building.available) {
      setNotice(`${building.name} will unlock as your civilization advances.`);
      return;
    }
    if (!gameState.canBuild(building.key)) {
      setNotice(`You need more resources to build ${building.name}.`);
      return;
    }
    setGameState((current) => current.build(building.key));
    setNotice(`${building.name} founded. Your settlement grows stronger.`);
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
            <p className="brand-kicker">Ages of</p>
            <h1>Hearth &amp; Horizon</h1>
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
              {label === "Production" && <span className="active-dot" />}
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
                      : formatResourceAmount(resourceAmounts[key])}
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
          <div className="topbar-status">
            <span className="status-live" /> Simulation running{" "}
            <span className="divider" /> <span>Turn 0048</span>
          </div>
        </header>

        <div className="world-content">
          <div className="welcome-row">
            <div>
              <p className="eyebrow">The valley of first light</p>
              <h2>
                {activeTab === "Production"
                  ? "Shape a civilization from the soil."
                  : activeTab}
              </h2>
              <p className="intro">
                A small settlement, a wide horizon, and every decision still
                ahead.
              </p>
            </div>
            <div className="season-badge">
              <span>Spring</span>
              <strong>12°C</strong>
              <small>Clear skies</small>
            </div>
          </div>

          {activeTab === "Dev Tools" && (
            <section className="dev-tools-panel" aria-label="Developer tools">
              <div>
                <p className="eyebrow">Simulation controls</p>
                <h3>Auto clicker</h3>
                <p className="dev-tools-copy">
                  Generate clicks per second for every gatherable
                  resource (population is excluded).
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
            </section>
          )}

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
                        {formatResourceAmount(resourceAmounts[key])} stored
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

          <div className="map-stage">
            <div className="sun-disc" />
            <div className="mountain mountain-back" />
            <div className="mountain mountain-front" />
            <div className="river" />
            <div className="settlement-label">
              <span className="map-pin" />
              <span>
                <strong>Riverbend</strong>
                <small>Your first settlement</small>
              </span>
            </div>
            <div className="map-legend">
              <span className="legend-line" /> Territory{" "}
              <span className="legend-dot" /> Fertile ground
            </div>
          </div>

          <div className="notice-bar">
            <Sparkles size={16} />
            <span>{notice}</span>
            <button
              onClick={() =>
                setNotice(
                  "Your people look to you for the next great decision.",
                )
              }
            >
              View journal <ArrowUpRight size={14} />
            </button>
          </div>
        </div>
      </section>

      <aside className="buildings-panel">
        <div className="buildings-header">
          <div>
            <p className="eyebrow">Settlement</p>
            <h2>Build</h2>
          </div>
          <span className="building-count">
            {gameState.builtBuildings.length} built
          </span>
        </div>
        <p className="panel-description">
          Lay the foundations of your growing civilization.
        </p>
        <div className="building-grid">
          {buildings.map((building) => {
            const Icon = building.icon;
            const isBuilt = gameState.builtBuildings.includes(building.key);
            const buildingCount = gameState.builtBuildings.filter(
              (builtKey) => builtKey === building.key,
            ).length;
            return (
              <button
                className={`building-card ${isBuilt ? "built" : ""} ${!building.available ? "locked" : ""}`}
                key={building.name}
                onClick={() => buyBuilding(building)}
              >
                <span className={`building-icon ${building.tone}`}>
                  <Icon size={19} strokeWidth={1.7} />
                </span>
                <span className="building-info">
                  <strong>{building.name}</strong>
                  <small>
                    {building.description} · {buildingCount}/
                    {gameState.getBuildingMax(building.key)}
                  </small>
                  <em>
                    {gameState.formatBuildingCost(building.key, buildingCount)}
                  </em>
                </span>
                {isBuilt && <span className="built-check">✓</span>}
              </button>
            );
          })}
        </div>
        <div className="build-tip">
          <span className="tip-mark">i</span>
          <span>Buildings produce resources automatically over time.</span>
        </div>
      </aside>

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

      {gamepediaOpen && (
        <GamepediaModal
          gameState={gameState}
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
