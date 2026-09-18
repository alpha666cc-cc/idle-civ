import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Building2,
  Castle,
  ChartColumn,
  Coins,
  Hammer,
  Landmark,
  Leaf,
  Menu,
  Pickaxe,
  Shield,
  Settings,
  Sparkles,
  Store,
  Swords,
  Trophy,
  Users,
  Wheat,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import GamepediaModal from "./components/GamepediaModal";
import DevNumberField from "./components/DevNumberField";
import {
  achievementDefinitions,
  findAchievementDefinition,
  type AchievementDefinition,
} from "./game/achievements";
import { ageDefinitions } from "./game/ages";
import { buildingDefinitions } from "./game/buildings";
import type { Bonus } from "./game/bonus";
import { CivilizationState } from "./game/civilizationState";
import { ExpNumber } from "./game/expNumber";
import { gamepedia } from "./game/gamepedia";
import { upgradeDefinitions, type UpgradeDefinition } from "./game/upgrades";
import { encounterDefinitions } from "./game/encounters";
import {
  formatDuration,
  formatNumber,
  type NumberFormat,
} from "./game/numberFormat";
import {
  capacityDefinitions,
  derivedAttributeDefinitions,
  productionDefinitions,
  type ProductionResourceKey,
  type ResourceKey,
} from "./game/attributes";
import ArmyPanel from "./components/ArmyPanel";
import {
  isBuyableUnit,
  unitDefinitions,
} from "./game/units";

type Tab =
  | "Production"
  | "Upgrades"
  | "Achievements"
  | "Army"
  | "Research"
  | "Trade"
  | "Settings"
  | "Stats"
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
};

const tabs: { label: Tab; icon: LucideIcon }[] = [
  { label: "Production", icon: Leaf },
  { label: "Upgrades", icon: ArrowUpRight },
  { label: "Achievements", icon: Trophy },
  { label: "Army", icon: Swords },
  { label: "Research", icon: BookOpen },
  { label: "Trade", icon: Store },
  { label: "Settings", icon: Settings },
  { label: "Stats", icon: ChartColumn },
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
  const resource = productionDefinitions.find(
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
  { key: "military", label: "Military", icon: Swords, tone: "blue" },
  { key: "metalwork", label: "Metalwork", icon: Hammer, tone: "orange" },
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
  };

const buildings: BuildingPresentation[] = buildingDefinitions.map(
  (building) => ({
    key: building.key,
    name: building.name,
    description: building.description,
    ...buildingPresentation[building.key],
  }),
);

/** Milestone chains group into one cumulative card; singletons render alone. */
const achievementFamilies: {
  family: string;
  tiers: AchievementDefinition[];
}[] = [];
const singletonAchievements: AchievementDefinition[] = [];
{
  const byFamily = new Map<string, AchievementDefinition[]>();
  for (const achievement of achievementDefinitions) {
    if (achievement.family === undefined) {
      singletonAchievements.push(achievement);
      continue;
    }
    const tiers = byFamily.get(achievement.family) ?? [];
    tiers.push(achievement);
    byFamily.set(achievement.family, tiers);
  }
  for (const [family, tiers] of byFamily) {
    tiers.sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
    achievementFamilies.push({ family, tiers });
  }
}

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
  const [dismissedAchievements, setDismissedAchievements] = useState<string[]>([]);
  const pendingAchievements = gameState.earnedAchievements
    .filter((id) => !dismissedAchievements.includes(id))
    .map(findAchievementDefinition)
    .filter((entry): entry is AchievementDefinition => entry !== undefined);

  const fmt = (n: ExpNumber | number) => formatNumber(n, numberFormat);
  const fmtSummary = (n: ExpNumber | number): string => fmt(n);
  const formatResourceRate = (key: ResourceKey): string => {
    const rate = gameState.computeResourceRate(key);
    return `${rate.sign > 0 ? "+" : ""}${fmt(rate)}/s`;
  };
  /** Presentation tone for a rate readout: growing, draining or idle. */
  const resourceRateTone = (key: ResourceKey): string => {
    const { sign } = gameState.computeResourceRate(key);
    if (sign > 0) return "positive";
    if (sign < 0) return "negative";
    return "flat";
  };

  const {
    resources: resourceAmounts,
    population,
    maximumPopulation,
    workers,
    availableWorkers,
    statistics,
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

  // Reveal upgrades, units and battles in the Gamepedia the moment their
  // unlock condition fires.
  useEffect(() => {
    for (const upgrade of upgradeDefinitions) {
      if (gameState.isUpgradeUnlocked(upgrade.key)) {
        gamepedia.reveal(upgrade.key);
      }
    }
    for (const unit of unitDefinitions) {
      if (isBuyableUnit(unit) && gameState.isUnitAvailable(unit.key)) {
        gamepedia.reveal(unit.key);
      }
    }
    const nextBattle = gameState.getNextBattle();
    if (nextBattle) gamepedia.reveal(nextBattle.key);
    for (const encounterId of gameState.defeatedEncounters) {
      gamepedia.reveal(encounterId);
    }
    for (const achievementId of gameState.earnedAchievements) {
      const definition = findAchievementDefinition(achievementId);
      if (definition) gamepedia.ensureAchievementEntry(definition);
      gamepedia.reveal(achievementId);
    }
  }, [gameState]);

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

  /**
   * Counts one click anywhere in the shell toward the UI click statistic. Gather
   * buttons carry `data-production-click`, because the engine counts those as
   * production clicks instead of UI clicks.
   */
  const countUiClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest?.("[data-production-click]")) return;
    setGameState((current) => current.recordUiClick());
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
    if (!gameState.isBuildingAvailable(building.key)) {
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

  const visibleTabs = tabs.filter(({ label }) => {
    if (label === "Army") return gameState.isBuildingAvailable("barracks");
    if (label === "Research")
      return gameState.isBuildingAvailable("university");
    if (label === "Trade")
      return gameState.isBuildingAvailable("market");
    return true;
  });

  const unlockedUpgrades = upgradeDefinitions.filter(
    (upgrade) =>
      gameState.isUpgradeUnlocked(upgrade.key) &&
      !gameState.isUpgradeBought(upgrade.key),
  );
  const hasAffordableUpgrade = unlockedUpgrades.some((upgrade) =>
    gameState.hasResourcesForUpgrade(upgrade.key),
  );
  const earnedAchievementCount = gameState.earnedAchievements.length;
  const builtByKeyRows = buildingDefinitions.flatMap((building) => {
    const count = statistics.buildingsBuiltByKey[building.key];
    return count === undefined || count.isZero
      ? []
      : [{ key: building.key, name: building.name, count }];
  });

  const describeUpgradeBonus = (bonus: Bonus): string => {
    if (bonus.type === "attributeMultiplier") {
      const capacity = capacityDefinitions.find(
        ({ key }) => key === bonus.destination,
      );
      if (capacity) return `${capacity.label} ×${fmt(bonus.value)}`;
      const resource = productionDefinitions.find(
        ({ key }) => key === bonus.destination,
      );
      if (resource) return `${resource.label} production ×${fmt(bonus.value)}`;
      return `${bonus.destination} ×${fmt(bonus.value)}`;
    }
    if (bonus.type.startsWith("costReduction")) {
      const building = buildingDefinitions.find(
        ({ key }) => key === bonus.destination,
      );
      const target = building ? building.name : String(bonus.destination);
      if (bonus.type === "costReductionPercent") {
        const percent =
          Math.round(
            bonus.value.mul(ExpNumber.fromNumber(100)).toNumber() * 10,
          ) / 10;
        return `${target} cost −${percent}%`;
      }
      if (bonus.type === "costReductionFactor") {
        return `${target} growth factor −${fmt(bonus.value)}`;
      }
      if (bonus.type === "costReductionFlat") {
        return `${target} cost −${fmt(bonus.value)}`;
      }
      if (bonus.type === "costReductionBase") {
        const percent = Math.round(bonus.value.mul(ExpNumber.fromNumber(100)).toNumber() * 10) / 10;
        return `${target} base cost −${percent}%`;
      }
    }
    return bonus.type;
  };

  /** Reward lines for the cumulative achievement cards (bonus → label). */
  const describeAchievementBonus = (bonus: Bonus): string => {
    const entry = gamepedia.get(String(bonus.destination));
    const definition = entry?.object as
      | { name?: string; label?: string; id: string }
      | undefined;
    const target = definition
      ? (definition.name ?? definition.label ?? definition.id)
      : String(bonus.destination);
    if (bonus.type === "attributeMultiplier") {
      if (bonus.destination === "buildingCostMultiplier" &&
          bonus.value.gt(ExpNumber.ZERO) && bonus.value.lte(ExpNumber.ONE)) {
        return `Building base costs: ÷${fmt(ExpNumber.ONE.div(bonus.value))}`;
      }
      return `${target} ×${fmt(bonus.value)}`;
    }
    if (bonus.type === "costReductionBase") {
      return `${target} base cost −${Math.round(
        bonus.value.mul(ExpNumber.fromNumber(100)).toNumber(),
      )}%`;
    }
    if (bonus.type.startsWith("costReduction")) {
      return `${target} −${fmt(bonus.value)}`;
    }
    return `${target} +${fmt(bonus.value)}${entry?.category === "resource" ? "/s" : ""}`;
  };

  const describeRewardList = (bonuses: Bonus[]): string => {
    const grouped = new Map<string, Bonus>();
    for (const bonus of bonuses) {
      const key = `${bonus.type}:${bonus.destination}`;
      const previous = grouped.get(key);
      const value = !previous ? bonus.value
        : bonus.type === "attributeMultiplier"
          ? previous.value.mul(bonus.value)
          : bonus.type === "costReductionBase" || bonus.type === "costReductionPercent"
            ? ExpNumber.ONE.sub(
                ExpNumber.ONE.sub(previous.value).mul(ExpNumber.ONE.sub(bonus.value)),
              )
            : previous.value.add(bonus.value);
      grouped.set(key, { ...bonus, value });
    }
    return [...grouped.values()].map(describeAchievementBonus).join(", ");
  };

  const buyUpgrade = (upgrade: UpgradeDefinition) => {
    const failureReason = gameState.getUpgradeFailureReason(upgrade.key);
    if (failureReason === "locked") {
      setNotice(`${upgrade.name} is not unlocked yet.`);
      return;
    }
    if (failureReason === "resources") {
      setNotice(
        <span>
          You need more resources for {upgrade.name}.{" "}
          <button
            type="button"
            className="notice-link"
            onClick={() => setActiveTab("Production")}
          >
            Go to Production tab &rarr;
          </button>
        </span>,
      );
      return;
    }
    setGameState((current) => current.buyUpgrade(upgrade.key));
    setNotice(`${upgrade.name} adopted. Your civilization advances.`);
  };

  // Age system
  const currentAge = gameState.getCurrentAge();
  const canEnterCurrentAge =
    currentAge && gameState.canEnterAge(currentAge.key);
  const battleProgress = gameState.getAgeBattleProgress();
  const buildingProgress = gameState.getAgeBuildingProgress();

  return (
    <main className="app-shell" onClickCapture={countUiClick}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Landmark size={20} strokeWidth={1.8} />
          </div>
          <div>
            <h1>Idle-civilization</h1>
          </div>
        </div>

        <div
          className={`era-card ${canEnterCurrentAge ? "available" : ""}`}
          role={canEnterCurrentAge ? "button" : undefined}
          tabIndex={canEnterCurrentAge ? 0 : -1}
          aria-label={
            canEnterCurrentAge
              ? `Advance from ${currentAge.name} to the next age`
              : undefined
          }
          onClick={() => {
            if (canEnterCurrentAge) {
              setGameState((s) => s.enterAge(currentAge.key));
            }
          }}
          onKeyDown={(event) => {
            if (!canEnterCurrentAge) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setGameState((s) => s.enterAge(currentAge.key));
            }
          }}
        >
          <span className="era-label">Current Age</span>
          {currentAge ? (
            <>
              <strong
                className={`era-age-name ${canEnterCurrentAge ? "available" : ""}`}
                title={
                  canEnterCurrentAge
                    ? "Click to enter the next age"
                    : "Win the age battles and build enough to advance"
                }
              >
                {currentAge.name}
              </strong>
              <div className="era-progress-bars">
                <div className="era-progress era-progress-battles" title="Battle progress">
                  <i
                    style={{
                      width: `${(battleProgress[0] / Math.max(1, battleProgress[1])) * 100}%`,
                    }}
                  />
                </div>
                <div className="era-progress era-progress-buildings" title="Building progress">
                  <i
                    style={{
                      width: `${(buildingProgress[0] / Math.max(1, buildingProgress[1])) * 100}%`,
                    }}
                  />
                </div>
              </div>
              <span className="era-meta">
                <span>
                  {battleProgress[0]}/{battleProgress[1]} battles ·
                  {buildingProgress[0]}/{buildingProgress[1]} buildings
                </span>
                <span>{canEnterCurrentAge ? "Click to advance" : ""}</span>
              </span>
            </>
          ) : (
            <strong className="era-age-name">Ancient</strong>
          )}
        </div>

        <nav className="tab-list" aria-label="Main game sections">
          <span className="nav-caption">Civilization</span>
          {visibleTabs.map(({ label, icon: Icon }) => (
            <button
              type="button"
              className={`tab-button ${activeTab === label ? "active" : ""}`}
              key={label}
              onClick={() => setActiveTab(label)}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {label === "Upgrades" && hasAffordableUpgrade && (
                <span
                  className="tab-notification"
                  title="Upgrade available to buy"
                >
                  <span className="visually-hidden">
                    Upgrade available to buy
                  </span>
                </span>
              )}
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
                      ? `${fmtSummary(availableWorkers)}/${fmtSummary(population)}`
                      : fmtSummary(resourceAmounts[key])}
                  </strong>
                  {key === "population" ? (
                    <small className="resource-note">
                      capacity {fmtSummary(maximumPopulation)}
                    </small>
                  ) : (
                    <small
                      className={`resource-rate ${resourceRateTone(key)}`}
                    >
                      {formatResourceRate(key)}
                    </small>
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
            <>
              <section className="dev-tools-panel" aria-label="Developer tools">
                <div className="dev-tools-heading">
                  <p className="eyebrow">Simulation controls</p>
                  <h3>Auto clicker</h3>
                  <p className="dev-tools-copy">
                    Generate clicks per second for every gatherable resource
                    (population is excluded). Accepts 10, 1e6, 1.5K, 2M, 1A, 1AA
                    — applied on Enter or on blur.
                  </p>
                </div>
                <div className="dev-tools-controls">
                  <DevNumberField
                    label="Clicks / second"
                    value={String(gameState.autoClicksPerSecond)}
                    ariaLabel="Auto clicks per second (accepts 1e6, 1.5K, 2M, 1A)"
                    placeholder="e.g. 10, 1e6, 2M"
                    onCommit={(parsed) => {
                      const clicks = Math.max(
                        0,
                        Math.floor(parsed.toNumber()),
                      );
                      if (!Number.isFinite(clicks)) return false;
                      setGameState((current) =>
                        current.setAutoClicksPerSecond(clicks),
                      );
                      return true;
                    }}
                  />
                  <DevNumberField
                    label="Production x"
                    value={gameState.devProductionMultiplier.toString()}
                    ariaLabel="Dev production multiplier (accepts 1e6, 1.5K, 2M, 1A)"
                    placeholder="e.g. 1, 10, 1e3"
                    onCommit={(parsed) => {
                      if (
                        parsed.isNegative ||
                        parsed.isZero ||
                        !parsed.isFinite
                      )
                        return false;
                      setGameState((current) =>
                        current.setDevProductionMultiplier(parsed),
                      );
                      return true;
                    }}
                  />
                  <button
                    type="button"
                    className={`dev-tools-toggle ${autoBuyBuildings ? "on" : ""}`}
                    aria-pressed={autoBuyBuildings}
                    onClick={() => setAutoBuyBuildings((current) => !current)}
                  >
                    <span>Auto buy buildings</span>
                    <strong>{autoBuyBuildings ? "ON" : "OFF"}</strong>
                  </button>
                  <button
                    type="button"
                    className={`dev-tools-toggle ${autoAssignWorkers ? "on" : ""}`}
                    aria-pressed={autoAssignWorkers}
                    onClick={() =>
                      setAutoAssignWorkers((current) => !current)
                    }
                  >
                    <span>Auto assign workers</span>
                    <strong>{autoAssignWorkers ? "ON" : "OFF"}</strong>
                  </button>
                  <div className="dev-tools-control">
                    <span>Win next battle (dev)</span>
                    <button
                      type="button"
                      onClick={() =>
                        setGameState((current) => {
                          const next = current.getNextBattle();
                          return next
                            ? current.defeatEncounter(next.key)
                            : current;
                        })
                      }
                      disabled={!gameState.getNextBattle()}
                    >
                      {gameState.getNextBattle()
                        ? `Resolve ${gameState.getNextBattle()!.key}`
                        : "Campaign complete"}
                    </button>
                  </div>
                </div>
              </section>
              <section className="dev-tools-panel" aria-label="Time skip">
                <div className="dev-tools-heading">
                  <p className="eyebrow">Time controls</p>
                  <h3>Skip ahead</h3>
                  <p className="dev-tools-copy">
                    Grants every producer its full rate for the whole window in
                    a single step, and advances play time with it.
                  </p>
                </div>
                <div
                  className="dev-tools-controls"
                  role="group"
                  aria-label="Skip time"
                >
                  <div className="dev-tools-buttons">
                    <button
                      type="button"
                      onClick={() =>
                        setGameState((current) => current.advanceTime(60))
                      }
                    >
                      +1m
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setGameState((current) => current.advanceTime(3600))
                      }
                    >
                      +1h
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setGameState((current) => current.advanceTime(86400))
                      }
                    >
                      +1d
                    </button>
                  </div>
                </div>
              </section>
              <section className="dev-tools-panel" aria-label="Free purchases">
                <div className="dev-tools-heading">
                  <p className="eyebrow">Free purchases</p>
                  <h3>Build for free</h3>
                  <p className="dev-tools-copy">
                    Skip cost checks and deduction; capacity gates and the next
                    cost stay unchanged.
                  </p>
                </div>
                <div className="dev-tools-controls">
                  <button
                    type="button"
                    className={`dev-tools-toggle ${gameState.freeBuildings ? "on" : ""}`}
                    aria-pressed={gameState.freeBuildings}
                    onClick={() =>
                      setGameState((current) =>
                        current.setFreeBuildings(!current.freeBuildings),
                      )
                    }
                  >
                    <span>Free buildings</span>
                    <strong>{gameState.freeBuildings ? "ON" : "OFF"}</strong>
                  </button>
                  <button
                    type="button"
                    className={`dev-tools-toggle ${gameState.freeUnits ? "on" : ""}`}
                    aria-pressed={gameState.freeUnits}
                    onClick={() =>
                      setGameState((current) =>
                        current.setFreeUnits(!current.freeUnits),
                      )
                    }
                  >
                    <span>Free units</span>
                    <strong>{gameState.freeUnits ? "ON" : "OFF"}</strong>
                  </button>
                </div>
              </section>
            </>
          )}

          {activeTab === "Army" && (
            <ArmyPanel
              gameState={gameState}
              setGameState={setGameState}
              multiplier={multiplier}
              fmt={fmt}
              onOpenGamepedia={openGamepediaAt}
            />
          )}

          {activeTab === "Production" && (
            <section className="production-workbench" aria-label="Production">
              <div className="workbench-heading">
                <div>
                  <p className="eyebrow">Available actions</p>
                  <h3>Produce resources</h3>
                </div>
                <span>
                  <Users size={14} /> {fmt(availableWorkers)} workers available
                </span>
              </div>
              <div className="gather-grid">
                {resources.map(({ key, label, icon: Icon, tone }) => (
                  <div className="gather-card" key={key}>
                    <button
                      className={`gather-button ${tone}`}
                      data-production-click
                      onClick={() => gatherResource(key)}
                    >
                      <span className="gather-card-icon">
                        <Icon size={18} strokeWidth={1.8} />
                      </span>
                      <span>
                        <strong>{label}</strong>
                        <small>{fmt(resourceAmounts[key])} stored</small>
                      </span>
                      <span className="gather-action">
                        +{fmt(gameState.computeClickGain(key))}
                      </span>
                    </button>
                    <div
                      className="worker-controls"
                      aria-label={`${label} workers`}
                    >
                      <button
                        onClick={() => changeWorkers(key, -1)}
                        disabled={workers[key] === ExpNumber.ZERO}
                        aria-label={`Remove ${label} worker`}
                      >
                        −
                      </button>
                      <span>{fmt(workers[key])}</span>
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
              {unlockedUpgrades.length === 0 ? (
                <p className="tab-placeholder-copy">
                  Building upgrades and capacity expansions will unlock as your
                  settlement advances.
                </p>
              ) : (
                <div className="upgrade-grid">
                  {unlockedUpgrades.map((upgrade) => (
                    <div className="upgrade-card" key={upgrade.key}>
                      <div className="upgrade-heading">
                        <strong>{upgrade.name}</strong>
                        <small>{upgrade.description}</small>
                      </div>
                      <ul className="upgrade-effects">
                        {upgrade.bonuses.map((bonus, index) => (
                          <li key={index}>{describeUpgradeBonus(bonus)}</li>
                        ))}
                      </ul>
                      <div className="upgrade-cost">
                        {upgrade.costs.map(({ resource, base }) => (
                          <span key={resource}>
                            {fmt(base)} {resource}
                          </span>
                        ))}
                      </div>
                      <button
                        type="button"
                        className={`upgrade-buy ${
                          gameState.hasResourcesForUpgrade(upgrade.key)
                            ? "affordable" : "unaffordable"
                        }`}
                        onClick={() => buyUpgrade(upgrade)}
                      >
                        {gameState.hasResourcesForUpgrade(upgrade.key)
                          ? "Adopt upgrade" : "Not enough resources"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeTab === "Achievements" && (
            <section className="production-workbench" aria-label="Achievements">
              <div className="workbench-heading">
                <div>
                  <p className="eyebrow">Records of the settlement</p>
                  <h3>Achievements</h3>
                </div>
                <span>
                  <Trophy size={15} strokeWidth={1.8} />
                  {earnedAchievementCount}/{achievementDefinitions.length}{" "}
                  earned
                </span>
              </div>
              <p className="dev-tools-copy">
                Achievements are permanent records of this civilization. Once
                earned they also appear in the Gamepedia; select one to read the
                entry.
              </p>
              <div className="achievement-grid">
                {achievementFamilies.map(({ family, tiers }) => {
                  const earnedTiers = gameState.earnedAchievements
                    .map(findAchievementDefinition)
                    .filter((tier): tier is AchievementDefinition =>
                      tier !== undefined && tier.family === family,
                    )
                    .sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
                  const goal = gameState.getNextAchievementGoal(family);
                  const complete = goal === undefined;
                  const progress = gameState.getRequirementValue(tiers[0].requirement);
                  const focus = earnedTiers[earnedTiers.length - 1] ?? tiers[0];
                  const state = complete
                    ? "earned"
                    : earnedTiers.length > 0
                      ? "partial"
                      : "locked";
                  return (
                    <button
                      type="button"
                      key={family}
                      className={`achievement-card chain ${state}`}
                      onClick={() => openGamepediaAt(focus.key)}
                      title={`Open ${focus.name} in gamepedia`}
                      aria-pressed={complete}
                    >
                      <span className="achievement-icon">
                        <Trophy size={18} strokeWidth={1.8} />
                      </span>
                      <span className="achievement-copy">
                        <strong>{focus.name}</strong>
                        <small>{focus.description.replaceAll("/sec", "/s")}</small>
                        {!complete && goal && progress && (
                          <small className="achievement-goal">
                            {fmt(progress)} / {fmt(goal.threshold)} — next:{" "}
                            {describeRewardList([
                              ...earnedTiers.flatMap((tier) => tier.bonuses)
                                .filter((bonus) => bonus.destination === "buildingCostMultiplier"),
                              ...goal.bonuses,
                            ])}
                            {goal.bonuses.some((bonus) =>
                              bonus.destination === "buildingCostMultiplier",
                            ) && " (total)"}
                          </small>
                        )}
                        {earnedTiers.length > 0 && (
                          <small className="achievement-earned-list">
                            {earnedTiers.length} earned:{" "}
                            {describeRewardList(
                              earnedTiers.flatMap((tier) => tier.bonuses),
                            )}
                          </small>
                        )}
                      </span>
                      <span className="achievement-status">
                        {complete
                          ? "Complete"
                          : earnedTiers.length > 0
                            ? "In progress"
                            : "Locked"}
                      </span>
                    </button>
                  );
                })}
                {singletonAchievements.map((achievement) => {
                  const earned = gameState.isAchievementEarned(achievement.key);
                  return (
                    <button
                      type="button"
                      key={achievement.key}
                      className={`achievement-card ${
                        earned ? "earned" : "locked"
                      }`}
                      onClick={() => openGamepediaAt(achievement.key)}
                      title={`Open ${achievement.name} in gamepedia`}
                      aria-pressed={earned}
                    >
                      <span className="achievement-icon">
                        <Trophy size={18} strokeWidth={1.8} />
                      </span>
                      <span className="achievement-copy">
                        <strong>{achievement.name}</strong>
                        <small>{achievement.description}</small>
                      </span>
                      <span className="achievement-status">
                        {earned ? "Earned" : "Locked"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {activeTab === "Trade" && (
            <section className="production-workbench" aria-label="Trade">
              <div className="workbench-heading">
                <div>
                  <p className="eyebrow">Commerce</p>
                  <h3>Trade</h3>
                </div>
              </div>
              <p className="tab-placeholder-copy">
                Trade caravans and market stalls will open here once your
                merchants have a market to work from.
              </p>
            </section>
          )}

          {activeTab === "Stats" && (
            <section className="production-workbench" aria-label="Statistics">
              <div className="workbench-heading">
                <div>
                  <p className="eyebrow">Records</p>
                  <h3>Statistics</h3>
                </div>
                <span>
                  <ChartColumn size={15} strokeWidth={1.8} />
                  {formatDuration(statistics.playTimeMs)} played
                </span>
              </div>

              <p className="gamepedia-category">Actions</p>
              <div className="stat-grid">
                {derivedAttributeDefinitions.map((attribute) => (
                  <button
                    type="button"
                    key={attribute.key}
                    className="stat-card clickable"
                    onClick={() => openGamepediaAt(attribute.key)}
                    title={`Open ${attribute.label} in gamepedia`}
                  >
                    <span>{attribute.label}</span>
                    <strong>
                      {attribute.key === "buildingCostMultiplier" && "×"}
                      {fmt(gameState.getAttributeValue(attribute.key))}
                    </strong>
                  </button>
                ))}
                <div className="stat-card">
                  <span>Production clicks</span>
                  <strong>{fmt(statistics.productionClicks)}</strong>
                </div>
                <div className="stat-card">
                  <span>UI clicks</span>
                  <strong>{fmt(statistics.uiClicks)}</strong>
                </div>
              </div>

              <p className="gamepedia-category">Time</p>
              <div className="stat-grid">
                <div className="stat-card">
                  <span>Played (all time)</span>
                  <strong>{formatDuration(statistics.playTimeMs)}</strong>
                </div>
                <div className="stat-card">
                  <span>Played (this run)</span>
                  <strong>{formatDuration(statistics.runTimeMs)}</strong>
                </div>
              </div>

              <p className="gamepedia-category">Construction</p>
              <div className="stat-grid">
                <div className="stat-card">
                  <span>Buildings built (all time)</span>
                  <strong>{fmt(statistics.buildingsBuilt)}</strong>
                </div>
                <div className="stat-card">
                  <span>Buildings standing</span>
                  <strong>{fmt(gameState.builtBuildings.length)}</strong>
                </div>
              </div>
              {builtByKeyRows.length > 0 && (
                <div className="stat-row-list">
                  {builtByKeyRows.map(({ key, name, count }) => (
                    <div className="stat-row" key={key}>
                      <span>{name}</span>
                      <strong>{fmt(count)}</strong>
                    </div>
                  ))}
                </div>
              )}

              <p className="gamepedia-category">Fastest battles</p>
              <p className="stat-note">
                Run time from the start of a game to each victory.
              </p>
              <div className="stat-row-list">
                {encounterDefinitions.map((encounter) => {
                  const best = gameState.getFastestBattleTime(encounter.key);
                  return (
                    <div className="stat-row" key={encounter.key}>
                      <span>{encounter.name}</span>
                      <strong>
                        {best === undefined ? "\u2014" : formatDuration(best)}
                      </strong>
                    </div>
                  );
                })}
              </div>

              <p className="gamepedia-category">Fastest ages</p>
              <p className="stat-note">
                Run time from the start of a game to each age's population
                threshold.
              </p>
              <div className="stat-row-list">
                {ageDefinitions.map((age) => {
                  const best = gameState.getFastestAgeTime(age.key);
                  return (
                    <div className="stat-row" key={age.key}>
                      <span>{age.name}</span>
                      <strong>
                        {best === undefined ? "\u2014" : formatDuration(best)}
                      </strong>
                    </div>
                  );
                })}
              </div>
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
                Choose how large numbers are displayed throughout the game. The
                preview below shows how each option formats{" "}
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

        </div>
        <div className="notice-bar">
          <Sparkles size={16} />
          <span>{notice}</span>
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
            const atCapacity =
              gameState.isBuildingAvailable(building.key) &&
              gameState.isBuildingAtCapacity(building.key);
            return (
              <div
                className={`building-actions ${atCapacity ? "at-capacity" : ""}`}
                key={building.key}
              >
              <button
                type="button"
                className={`building-card ${
                  !gameState.isBuildingAvailable(building.key) ? "locked" : ""
                }`}
                onClick={() => buyBuilding(building)}
              >
                <span className={`building-icon ${building.tone}`}>
                  <Icon size={19} strokeWidth={1.7} />
                </span>
                <span className="building-info">
                  <span className="building-title-row">
                    <strong>{building.name}</strong>
                    <small>{building.description}</small>
                    <span
                      className={`building-count-inline ${
                        atCapacity ? "maxed" : ""
                      }`}
                      title={
                        atCapacity ? "Maximum capacity reached" : undefined
                      }
                    >
                      {buildingCount}/
                      {fmt(gameState.getBuildingMax(building.key))}
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
              {gamepedia.get(building.key)?.object.seen && (
                <button
                  type="button"
                  className="building-pedia-button"
                  onClick={() => openGamepediaAt(building.key)}
                  aria-label={`Open ${building.name} in Gamepedia`}
                  title={`Open ${building.name} in Gamepedia`}
                >
                  <BookOpen size={16} strokeWidth={1.8} />
                </button>
              )}
              </div>
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

      <section className="achievement-notifications" aria-label="Achievement notifications">
        <div role="status" aria-live="polite" aria-atomic="true">
          {pendingAchievements.length > 0 && (
            <strong>
              <Trophy size={18} strokeWidth={1.8} />{" "}
              Achievements earned: {fmt(pendingAchievements.length)}
              <span className="visually-hidden">
                {pendingAchievements.map(({ name, description }) =>
                  `${name}: ${description.replaceAll("/sec", "/s")}`,
                ).join(". ")}
              </span>
            </strong>
          )}
        </div>
        {pendingAchievements.length > 0 && (
          <>
            <button
              type="button"
              className="notice-link"
              onClick={() => setDismissedAchievements((current) => [
                ...current, ...pendingAchievements.map(({ key }) => key),
              ])}
            >
              Dismiss notifications
            </button>
            <ul>
              {pendingAchievements.map((achievement) => (
                <li key={achievement.key}>
                  <button
                    type="button"
                    className="notice-link"
                    onClick={() => openGamepediaAt(achievement.key)}
                    aria-label={`Open ${achievement.name} in Gamepedia`}
                  >
                    {achievement.name} &rarr;
                  </button>
                  <p>{achievement.description.replaceAll("/sec", "/s")}</p>
                  <p>Reward: {describeRewardList(achievement.bonuses) || "Achievement recorded"}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {gamepediaOpen && (
        <GamepediaModal
          key={gamepediaFocusId ?? "index"}
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
