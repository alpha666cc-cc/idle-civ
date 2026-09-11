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

type Tab = "Resources" | "Upgrades" | "Army" | "Research" | "Settings";
type ResourceKey = "food" | "wood" | "stone" | "gold";

type Resource = {
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

type Building = {
  name: string;
  description: string;
  cost: string;
  icon: LucideIcon;
  tone: string;
  available: boolean;
};

const tabs: { label: Tab; icon: LucideIcon }[] = [
  { label: "Resources", icon: Leaf },
  { label: "Upgrades", icon: ArrowUpRight },
  { label: "Army", icon: Swords },
  { label: "Research", icon: BookOpen },
  { label: "Settings", icon: Settings },
];

const resources: Resource[] = [
  { key: "wood", label: "Wood", icon: Leaf, tone: "green" },
  { key: "stone", label: "Stone", icon: Pickaxe, tone: "slate" },
  { key: "food", label: "Food", icon: Wheat, tone: "gold" },
  { key: "gold", label: "Gold", icon: Coins, tone: "amber" },
];

const summaryResources: SummaryResource[] = [
  { key: "population", label: "Population", icon: Users, tone: "teal" },
  { key: "food", label: "Food", icon: Wheat, tone: "gold" },
  { key: "wood", label: "Wood", icon: Leaf, tone: "green" },
  { key: "stone", label: "Stone", icon: Pickaxe, tone: "slate" },
  { key: "gold", label: "Gold", icon: Coins, tone: "amber" },
  { key: "science", label: "Science", icon: Sparkles, tone: "violet" },
];

const buildings: Building[] = [
  {
    name: "House",
    description: "+12 housing",
    cost: "80 wood",
    icon: Building2,
    tone: "teal",
    available: true,
  },
  {
    name: "Farm",
    description: "+6 food / min",
    cost: "120 wood",
    icon: Wheat,
    tone: "gold",
    available: true,
  },
  {
    name: "Quarry",
    description: "+4 stone / min",
    cost: "160 wood",
    icon: Pickaxe,
    tone: "slate",
    available: true,
  },
  {
    name: "Gold Mine",
    description: "+2 gold / min",
    cost: "240 stone",
    icon: Coins,
    tone: "amber",
    available: true,
  },
  {
    name: "Market",
    description: "Trade resources",
    cost: "300 wood",
    icon: Landmark,
    tone: "red",
    available: true,
  },
  {
    name: "Town Hall",
    description: "+1 civic slot",
    cost: "500 stone",
    icon: Castle,
    tone: "violet",
    available: true,
  },
  {
    name: "Smithy",
    description: "Unlocks equipment",
    cost: "360 wood",
    icon: Hammer,
    tone: "orange",
    available: true,
  },
  {
    name: "Barracks",
    description: "Train units",
    cost: "420 stone",
    icon: Shield,
    tone: "blue",
    available: true,
  },
  {
    name: "Academy",
    description: "+3 science / min",
    cost: "520 gold",
    icon: BookOpen,
    tone: "pink",
    available: true,
  },
  {
    name: "Monument",
    description: "Coming soon",
    cost: "Locked",
    icon: Landmark,
    tone: "locked",
    available: false,
  },
];

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("Resources");
  const [builtBuildings, setBuiltBuildings] = useState<string[]>([
    "House",
    "Farm",
  ]);
  const [notice, setNotice] = useState(
    "The first settlers have found fertile ground.",
  );
  const [resourceAmounts, setResourceAmounts] = useState<
    Record<ResourceKey, number>
  >({ food: 0, wood: 0, stone: 0, gold: 0 });
  const [population] = useState(0);
  const [workers, setWorkers] = useState<Record<ResourceKey, number>>({
    food: 0,
    wood: 0,
    stone: 0,
    gold: 0,
  });

  const assignedWorkers = Object.values(workers).reduce(
    (total, count) => total + count,
    0,
  );
  const availableWorkers = population - assignedWorkers;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setResourceAmounts((current) => {
        const next = { ...current };
        for (const resource of resources) {
          next[resource.key] += workers[resource.key];
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [workers]);

  const gatherResource = (resourceKey: ResourceKey) => {
    setResourceAmounts((current) => ({
      ...current,
      [resourceKey]: current[resourceKey] + 1,
    }));
  };

  const changeWorkers = (resourceKey: ResourceKey, change: number) => {
    if (change > 0 && availableWorkers <= 0) {
      setNotice("No unassigned population is available for this task yet.");
      return;
    }
    if (change < 0 && workers[resourceKey] <= 0) return;
    setWorkers((current) => ({
      ...current,
      [resourceKey]: current[resourceKey] + change,
    }));
  };

  const buyBuilding = (building: Building) => {
    if (!building.available) {
      setNotice(`${building.name} will unlock as your civilization advances.`);
      return;
    }
    if (builtBuildings.includes(building.name)) {
      setNotice(`${building.name} is already part of your settlement.`);
      return;
    }
    setBuiltBuildings((current) => [...current, building.name]);
    setNotice(`${building.name} founded. Your settlement grows stronger.`);
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
              {label === "Resources" && <span className="active-dot" />}
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
              <div className="resource-row" key={key}>
                <div className={`resource-icon ${tone}`}>
                  <Icon size={16} strokeWidth={1.8} />
                </div>
                <div className="resource-copy">
                  <span>{label}</span>
                  <strong>
                    {key === "population"
                      ? population
                      : key === "science"
                        ? 0
                        : resourceAmounts[key]}
                  </strong>
                </div>
              </div>
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
                {activeTab === "Resources"
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

          <section
            className="resource-workbench"
            aria-label="Resource gathering"
          >
            <div className="workbench-heading">
              <div>
                <p className="eyebrow">Available actions</p>
                <h3>Gather resources</h3>
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
          <span className="building-count">{builtBuildings.length} / 10</span>
        </div>
        <p className="panel-description">
          Lay the foundations of your growing civilization.
        </p>
        <div className="building-grid">
          {buildings.map((building) => {
            const Icon = building.icon;
            const isBuilt = builtBuildings.includes(building.name);
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
                  <small>{building.description}</small>
                  <em>{isBuilt ? "Built" : building.cost}</em>
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
