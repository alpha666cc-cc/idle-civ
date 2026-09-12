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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Details, { type DetailsResource } from "./components/Details";
import { buildingDefinitions } from "./game/buildings";
import { CivilizationState } from "./game/civilizationState";
import { resourceDefinitions, type ResourceKey } from "./game/resources";

type Tab = "Production" | "Upgrades" | "Army" | "Research" | "Settings";
type ResourcePresentation = {
  key: ResourceKey;
  label: string;
  icon: LucideIcon;
  tone: string;
};

type SummaryResource = {
  key: ResourceKey | "population" | "science";
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
];

const resourcePresentation: Record<
  ResourceKey,
  Omit<ResourcePresentation, "key" | "label">
> = {
  wood: { icon: Leaf, tone: "green" },
  stone: { icon: Pickaxe, tone: "slate" },
  food: { icon: Wheat, tone: "gold" },
  gold: { icon: Coins, tone: "amber" },
};

const resources: ResourcePresentation[] = resourceDefinitions.map(
  (resource) => ({
    key: resource.key,
    label: resource.label,
    ...resourcePresentation[resource.key],
  }),
);

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

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("Production");
  const [notice, setNotice] = useState(
    "The first settlers have found fertile ground.",
  );
  const [gameState, setGameState] = useState(() => new CivilizationState());
  const [selectedResource, setSelectedResource] = useState<ResourceKey | null>(
    null,
  );

  const {
    resources: resourceAmounts,
    population,
    workers,
    availableWorkers,
  } = gameState;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setGameState((current) => current.tick());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const gatherResource = (resourceKey: ResourceKey) => {
    setGameState((current) => current.gather(resourceKey));
  };

  const changeWorkers = (resourceKey: ResourceKey, change: number) => {
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

  const openResourceDetails = (resourceKey: ResourceKey) => {
    setSelectedResource(resourceKey);
  };

  const selectedResourceDefinition = resources.find(
    ({ key }) => key === selectedResource,
  );
  const selectedFactors = selectedResource
    ? gameState.getFactors(selectedResource)
    : null;
  const selectedRate = selectedResource
    ? gameState.computeResourceRate(selectedResource)
    : 0;

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
                onClick={() => {
                  if (key !== "population" && key !== "science")
                    openResourceDetails(key);
                }}
                disabled={key === "population" || key === "science"}
                title={
                  key === "population" || key === "science"
                    ? undefined
                    : `Open ${label} details`
                }
              >
                <div className={`resource-icon ${tone}`}>
                  <Icon size={16} strokeWidth={1.8} />
                </div>
                <div className="resource-copy">
                  <span>{label}</span>
                  <strong>
                    {key === "population"
                      ? `${availableWorkers}/${population}`
                      : key === "science"
                        ? 0
                        : resourceAmounts[key]}
                  </strong>
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
                      <small>{resourceAmounts[key]} stored</small>
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

          {selectedResource &&
            selectedFactors &&
            selectedResourceDefinition && (
              <Details
                resource={selectedResourceDefinition as DetailsResource}
                factors={selectedFactors}
                rate={selectedRate}
                onClose={() => setSelectedResource(null)}
              />
            )}

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
    </main>
  );
}

export default App;
