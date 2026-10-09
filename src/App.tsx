import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
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
import { buildingDefinitions, type BuildingKey } from "./game/buildings";
import { researchDefinitions } from "./game/research";
import type { Bonus } from "./game/bonus";
import { CivilizationState } from "./game/civilizationState";
import { ExpNumber } from "./game/expNumber";
import { gamepedia } from "./game/gamepedia";
import { upgradeDefinitions, type UpgradeDefinition } from "./game/upgrades";
import { encounterDefinitions } from "./game/encounters";
import {
  formatDuration,
  formatNumber,
  formatWholeNumber,
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
import TradePanel from "./components/TradePanel";
import WorkerCountInput from "./components/WorkerCountInput";
import { type BattleSimulation } from "./game/battle";
import ResearchPanel from "./components/ResearchPanel";
import BattleSimulatorPanel from "./components/BattleSimulatorPanel";
import {
  isBuyableUnit,
  parseUnitStatTarget,
  unitDefinitions,
  unitStatTargetLabel,
} from "./game/units";
import {
  MAX_OFFLINE_MS,
  SaveFormatError,
  calculateOfflineGain,
  cappedOfflineMs,
  createSaveData,
  detectSaveFormat,
  generateSaveGuid,
  loadSaveData,
  parseSave,
  remapSaveIds,
  saveFileName,
  saveFromJson,
  serializeSave,
  type SaveData,
  type SaveFormat,
  type SaveGuid,
} from "./game/saveSystem";
import {
  acceptForSaveFormat,
  anySaveAccept,
  copyTextToClipboard,
  downloadTextFile,
  mimeForSaveFormat,
  openTextFile,
  readTextFromClipboard,
  saveTextToFile,
} from "./components/saveFileIo";
import { resolveEntryId } from "./game/dataIds";
import {
  DEFAULT_DEV_LOG_SNAPSHOT_SECONDS,
  appendDevLogEvent,
  appendDevLogSnapshot,
  buildDevLogEvent,
  buildDevLogSnapshot,
  createDevLog,
  devLogFromSave,
  devLogGameSeconds,
  diffDevLogEvents,
  isDevLogSnapshotDue,
  serializeDevLog,
  type DevLogDocument,
} from "./game/devLog";

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
  military: { icon: Swords, tone: "red" },
  science: { icon: BookOpen, tone: "blue" },
  metalwork: { icon: Hammer, tone: "slate" },
  trade: { icon: Landmark, tone: "amber" },
};

const productionOrder: ProductionResourceKey[] = [
  "food",
  "wood",
  "stone",
  "gold",
  "military",
  "science",
  "metalwork",
  "trade",
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
  { key: "trade", label: "Trade power", icon: Store, tone: "purple" },
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

/**
 * The internal autosave document. It is always JSON, whatever interchange radio
 * is selected — the radio only chooses how an *export* is encoded.
 */
const saveStorageKey = "idle-civ:save-v1";
const autosaveIntervalStorageKey = "idle-civ:autosave-interval";
const saveFormatStorageKey = "idle-civ:save-format";

const saveFormatOptions: { value: SaveFormat; label: string; hint: string }[] =
  [
    { value: "base64", label: "Base64", hint: "clipboard" },
    { value: "json", label: "JSON", hint: "save .json file" },
    { value: "xml", label: "XML", hint: "save .xml file" },
  ];

const loadSaveFormat = (): SaveFormat => {
  try {
    const stored = window.localStorage.getItem(saveFormatStorageKey);
    if (stored === "base64" || stored === "json" || stored === "xml") {
      return stored;
    }
  } catch {
    // localStorage unavailable - keep the default.
  }
  return "base64";
};

const loadAutosaveInterval = (): number => {
  try {
    const stored = window.localStorage.getItem(autosaveIntervalStorageKey);
    const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  } catch {
    // localStorage unavailable - keep the default.
  }
  return 10;
};

/** Every id a save may legitimately name. */
const knownContentIds: ReadonlySet<string> = (() => {
  const ids = new Set<string>();
  for (const entry of gamepedia.all()) ids.add(entry.object.id);
  for (const definition of capacityDefinitions) ids.add(definition.key);
  for (const age of ageDefinitions) ids.add(age.key);
  for (const unit of unitDefinitions) ids.add(unit.key);
  for (const upgrade of upgradeDefinitions) ids.add(upgrade.key);
  return ids;
})();

const readStoredSave = (): string | null => {
  try {
    return window.localStorage.getItem(saveStorageKey);
  } catch {
    return null;
  }
};

const writeStoredSave = (text: string): void => {
  try {
    window.localStorage.setItem(saveStorageKey, text);
  } catch {
    // Private mode or a full quota: the in-memory run continues either way.
  }
};

const clearStoredSave = (): void => {
  try {
    window.localStorage.removeItem(saveStorageKey);
  } catch {
    // Nothing to clear.
  }
};

const devModeStorageKey = "idle-civ:dev-mode";

/**
 * Dev mode decides whether the Dev Tools tab exists at all. Launching through
 * the VS Code run task (`vite dev`) is dev mode for now; a production build
 * starts with it off, and the Settings toggle can always override either way.
 */
const devBuildDefault = import.meta.env.DEV;

const loadDevMode = (): boolean => {
  try {
    const stored = window.localStorage.getItem(devModeStorageKey);
    if (stored === "on") return true;
    if (stored === "off") return false;
  } catch {
    // localStorage unavailable — fall back to the build default.
  }
  return devBuildDefault;
};

const storeDevMode = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(devModeStorageKey, enabled ? "on" : "off");
  } catch {
    // The preference simply won't persist.
  }
};

/** Where the dev server writes the run log; absent under a production build. */
const devLogEndpoint = "/__dev-log";

/** Pushes the log to the dev server, which writes it into `saves/auto`. */
const flushDevLogToDisk = (log: DevLogDocument): void => {
  void fetch(devLogEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: log.fileName, text: serializeDevLog(log) }),
  }).catch(() => {
    // No dev server (production build or the port is closed). The log still
    // lives in the save's dev section and can be downloaded from Dev Tools.
  });
};

const buildingPresentation: Record<string, { icon: LucideIcon; tone: string }> =
  {
    people: { icon: Users, tone: "teal" },
    house: { icon: Building2, tone: "teal" },
    farm: { icon: Wheat, tone: "gold" },
    "lumberYard": { icon: Leaf, tone: "green" },
    quarry: { icon: Pickaxe, tone: "slate" },
    "goldMine": { icon: Coins, tone: "amber" },
    market: { icon: Landmark, tone: "red" },
    "townHall": { icon: Castle, tone: "violet" },
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
  const [dismissedAchievements, setDismissedAchievements] = useState<string[]>(
    [],
  );
  const [paused, setPaused] = useState(false);
  /** Battle state persists across tab switches */
  const [activeBattle, setActiveBattle] = useState<{
    battleId: string;
    sim: BattleSimulation;
    startTime: number;
  } | null>(null);
  const [battleRoundIndex, setBattleRoundIndex] = useState(0);
  const [autosaveIntervalSeconds, setAutosaveIntervalSeconds] =
    useState(loadAutosaveInterval);
  const [saveFormat, setSaveFormat] = useState<SaveFormat>(loadSaveFormat);
  const [saveGuid, setSaveGuid] = useState<SaveGuid>("");
  const [lastSavedAtMs, setLastSavedAtMs] = useState<number | null>(null);
  /** A loaded save waiting behind the offline-gain panel. */
  const [pendingLoad, setPendingLoad] = useState<{
    state: CivilizationState;
    gains: Record<string, ExpNumber>;
    elapsedMs: number;
    source: string;
  } | null>(null);
  const tickMsRef = useRef(0);
  const [devMode, setDevMode] = useState(loadDevMode);
  /** The run log, mirrored in a ref so the save writer and effects can read it. */
  const [devLog, setDevLog] = useState<DevLogDocument | null>(null);
  const devLogRef = useRef<DevLogDocument | null>(null);
  /** Cleared by reset so the next run gets its own id — and its own file. */
  const devRunIdRef = useRef<string | null>(null);
  /**
   * False until the stored save has been read (or found absent). The run log
   * only starts after that decision, so a reload continues the existing log
   * instead of opening a new one.
   */
  const [devLogReady, setDevLogReady] = useState(false);
  const previousLoggedStateRef = useRef<CivilizationState | null>(null);
  const [lastTickMs, setLastTickMs] = useState(0);
  /** Save-file identity, kept out of render so the autosave timer reads it. */
  const saveIdentityRef = useRef<{
    guid: SaveGuid;
    createdAtMs: number;
  } | null>(null);
  /** The latest state, so the autosave timer writes without a state updater. */
  const gameStateRef = useRef(gameState);
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);
  const pendingAchievements = gameState.earnedAchievements
    .filter((id) => !dismissedAchievements.includes(id))
    .map(findAchievementDefinition)
    .filter((entry): entry is AchievementDefinition => entry !== undefined);

  const fmt = (n: ExpNumber | number) => formatNumber(n, numberFormat);
  const fmtCount = (n: ExpNumber | number) =>
    formatWholeNumber(n, numberFormat);
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
  const totalTimeMs = statistics.onlineTimeMs + statistics.offlineTimeMs;

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      setGameState((current) => {
        const start = performance.now();
        let next = current.tick();
        if (autoBuyBuildings) next = next.autoBuyBuildings();
        if (autoAssignWorkers) next = next.autoAssignWorkers();
        tickMsRef.current = performance.now() - start;
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [paused, autoBuyBuildings, autoAssignWorkers]);

  useEffect(() => {
    storeDevMode(devMode);
  }, [devMode]);

  /**
   * Dev mode drives two things: whether the Dev Tools tab is in the list, and
   * whether the run log is recorded. Turning it off must not leave the shell
   * sitting on the tab that just disappeared.
   */
  const toggleDevMode = (): void => {
    const next = !devMode;
    setDevMode(next);
    if (!next && activeTab === "Dev Tools") setActiveTab("Settings");
  };

  /**
   * Dev log: remarkable events plus a snapshot every 300 game-seconds, on the
   * same clock and with the same fields the simulator records. Runs in its own
   * effect rather than inside the tick updater, so logging can never run twice
   * for one tick under StrictMode.
   *
   * It waits for `devLogReady` so it never starts a log before the stored save
   * has been read: creating one on the first render would mint a fresh run id
   * and leave a stray file behind on every browser restart.
   */
  useEffect(() => {
    if (!devMode || !devLogReady) {
      previousLoggedStateRef.current = null;
      return;
    }
    const previous = previousLoggedStateRef.current;
    previousLoggedStateRef.current = gameState;

    const runId =
      devRunIdRef.current ?? (devRunIdRef.current = generateSaveGuid());
    let log = devLogRef.current ?? createDevLog(runId);
    const time = devLogGameSeconds(gameState);

    if (previous) {
      for (const event of diffDevLogEvents(previous, gameState, time)) {
        log = appendDevLogEvent(log, event);
      }
    }
    if (isDevLogSnapshotDue(log, time)) {
      log = appendDevLogSnapshot(log, buildDevLogSnapshot(gameState, time));
    }

    if (log !== devLogRef.current) {
      devLogRef.current = log;
      setDevLog(log);
      flushDevLogToDisk(log);
    }
  }, [gameState, devMode, devLogReady]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLastTickMs(tickMsRef.current);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

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
    for (const research of researchDefinitions) {
      if (
        gameState.isResearchUnlocked(research.key) ||
        gameState.isResearchBought(research.key)
      ) {
        gamepedia.reveal(research.key);
      }
    }
    const nextBattle = gameState.getNextBattle();
    if (nextBattle) gamepedia.reveal(nextBattle.key);
    for (const encounterId of gameState.defeatedEncounters) {
      gamepedia.reveal(encounterId);
    }
    for (const ageId of gameState.enteredAges) {
      gamepedia.reveal(ageId);
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

  useEffect(() => {
    try {
      window.localStorage.setItem(saveFormatStorageKey, saveFormat);
    } catch {
      // localStorage unavailable — the preference simply won't persist.
    }
  }, [saveFormat]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        autosaveIntervalStorageKey,
        String(autosaveIntervalSeconds),
      );
    } catch {
      // localStorage unavailable — the preference simply won't persist.
    }
  }, [autosaveIntervalSeconds]);

  /** The save-file identity, created on first use and then carried forward. */
  const ensureSaveIdentity = (): { guid: SaveGuid; createdAtMs: number } => {
    const existing = saveIdentityRef.current;
    if (existing) return existing;
    const identity = { guid: generateSaveGuid(), createdAtMs: Date.now() };
    saveIdentityRef.current = identity;
    setSaveGuid(identity.guid);
    return identity;
  };

  /** Write the internal autosave document; shared by autosave and Save. */
  const writeInternalSave = useCallback(
    (
      state: CivilizationState,
      identity: { guid: SaveGuid; createdAtMs: number },
    ): SaveData => {
      const data = createSaveData(state, identity.guid, identity.createdAtMs, {
        actionMultiplier: multiplier,
        largeMultiplier,
        dismissedAchievements,
        // Read through the ref so the writer never has to re-subscribe.
        devLog: devLogRef.current ?? undefined,
      });
      writeStoredSave(serializeSave(data, "json"));
      setLastSavedAtMs(data.savedAtMs);
      return data;
    },
    [multiplier, largeMultiplier, dismissedAchievements],
  );

  /**
   * Adopt a save document: repair renamed ids through the static GUIDs, install
   * the state, and route the elapsed time either into the offline-gain panel or
   * straight into play.
   */
  const adoptSave = (
    data: SaveData,
    options: { offlineGain: boolean; source: string },
  ): void => {
    const repaired = remapSaveIds(
      data,
      (id) =>
        knownContentIds.has(id) || findAchievementDefinition(id) !== undefined,
      resolveEntryId,
    );
    const identity = {
      guid: data.guid,
      createdAtMs: data.createdAtMs ?? data.savedAtMs,
    };
    saveIdentityRef.current = identity;
    setSaveGuid(identity.guid);
    setMultiplier(data.actionMultiplier ?? 1);
    setLargeMultiplier(data.largeMultiplier ?? 100);
    setDismissedAchievements([
      ...new Set([
        ...(data.dismissedAchievements ?? []),
        ...(data.earnedAchievements ?? []),
      ]),
    ]);

    const loadedState = loadSaveData(repaired.data);
    const elapsedMs = Date.now() - data.savedAtMs;
    const nextState = options.offlineGain
      ? loadedState.recordOfflineTime(elapsedMs).checkAchievements()
      : loadedState;
    const gains = options.offlineGain
      ? calculateOfflineGain(
          nextState.getProductionRates(),
          elapsedMs,
          nextState.getOfflineEfficiency(),
        )
      : {};
    const hasGains = Object.keys(gains).length > 0;

    let source = options.source;
    const renamed = Object.keys(repaired.renamed).length;
    if (renamed > 0) source += ` (${renamed} renamed id(s) resolved by GUID)`;
    if (repaired.unknown.length > 0) {
      source += ` — dropped unknown content: ${repaired.unknown.join(", ")}`;
    }

    // Continue the run log from the save so it spans reloads, and record the
    // reload itself — with the offline gain it is about to be credited.
    //
    // The identity is restored whether or not dev mode is currently on, so that
    // turning it on later appends to the save's file instead of opening a new
    // one beside it. Only writing to disk waits for dev mode.
    const restored = devLogFromSave(data.devLog);
    if (restored) {
      devRunIdRef.current = restored.runId;
      const offlineDetail = hasGains
        ? `offline ${formatDuration(cappedOfflineMs(elapsedMs))}; gained ${Object.keys(
            gains,
          )
            .map((key) => `${key} ${fmt(gains[key])}`)
            .join(", ")}`
        : `offline ${formatDuration(cappedOfflineMs(elapsedMs))}; no offline gain`;
      const loaded = appendDevLogEvent(
        restored,
        buildDevLogEvent(
          nextState,
          "load",
          source,
          devLogGameSeconds(nextState),
          offlineDetail,
        ),
      );
      devLogRef.current = loaded;
      setDevLog(loaded);
      previousLoggedStateRef.current = nextState;
      if (devMode) flushDevLogToDisk(loaded);
    }

    // Re-stamp the document so a reload does not re-apply the same gap.
    const reinstalled = createSaveData(
      nextState,
      identity.guid,
      identity.createdAtMs,
      {
        actionMultiplier: data.actionMultiplier ?? 1,
        largeMultiplier: data.largeMultiplier ?? 100,
        dismissedAchievements: data.dismissedAchievements ?? [],
        // Keep the (possibly just appended) log across the re-stamp.
        devLog: devLogRef.current ?? undefined,
      },
    );
    writeStoredSave(serializeSave(reinstalled, "json"));
    setLastSavedAtMs(reinstalled.savedAtMs);

    if (!hasGains || elapsedMs <= 0) {
      setGameState(nextState);
      setPendingLoad(null);
      setNotice(`Save loaded from ${source}.`);
      return;
    }

    setPendingLoad({ state: nextState, gains, elapsedMs, source });
  };

  // Autosave: write the internal document every N seconds (0 turns it off).
  useEffect(() => {
    if (autosaveIntervalSeconds <= 0) return;
    const timer = window.setInterval(() => {
      writeInternalSave(gameStateRef.current, ensureSaveIdentity());
    }, autosaveIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [autosaveIntervalSeconds, writeInternalSave]);

  // Relaunch: pick the internal save up and let the offline panel size the gap.
  useEffect(() => {
    const stored = readStoredSave();
    if (!stored) {
      // No save to continue: this is a fresh run, so the log may start now.
      setDevLogReady(true);
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        adoptSave(saveFromJson(stored), {
          offlineGain: true,
          source: "this browser",
        });
      } catch {
        // A stored save we cannot read at all: start fresh, and say so.
        clearStoredSave();
        setNotice(
          "The stored save could not be read, so a new settlement was founded.",
        );
      }
      // Either way the load decision is now made, so the run log may start: it
      // continues the save's log when there was one, and opens a new file when
      // there was not.
      setDevLogReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
    // Adopting the stored save is a mount-only side effect: re-running it on any
    // later change would re-apply the same offline gap.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Hand one already-built document to the player: the clipboard for Base64, the
   * file API otherwise. Shared by Save and Fork so both land the file the same
   * way. Returns the file name it aimed at, or `null` if the dialog was
   * cancelled; the caller sets the final notice, since the two callers word it
   * differently.
   */
  const exportSaveDocument = async (
    data: SaveData,
  ): Promise<string | null> => {
    const fileName = saveFileName(data, saveFormat);

    if (saveFormat === "base64") {
      const text = serializeSave(data, "base64");
      if (await copyTextToClipboard(text)) {
        setNotice("Save written and copied to the clipboard as Base64.");
        return fileName;
      }
      downloadTextFile(fileName.replace(/\.json$/, ".txt"), text, "text/plain");
      setNotice(
        "Save written; the clipboard was unavailable, so it downloaded instead.",
      );
      return fileName;
    }

    const result = await saveTextToFile(
      fileName,
      serializeSave(data, saveFormat),
      mimeForSaveFormat(saveFormat),
      acceptForSaveFormat(saveFormat),
    );
    if (result === "cancelled") {
      setNotice("Save written internally; the file dialog was cancelled.");
      return null;
    }
    setNotice(
      result === "saved"
        ? `Save written to ${fileName}.`
        : `Save downloaded as ${fileName}.`,
    );
    return fileName;
  };

  /** Settings / Dev Tools: save now. Always writes internally first. */
  const handleSaveNow = async (): Promise<void> => {
    await exportSaveDocument(
      writeInternalSave(gameState, ensureSaveIdentity()),
    );
  };

  /** Dev Tools: export JSON and XML from one timestamped document. */
  const handleSaveBothFormats = async (): Promise<void> => {
    const data = writeInternalSave(gameState, ensureSaveIdentity());
    const results: string[] = [];
    for (const format of ["json", "xml"] as const) {
      const result = await saveTextToFile(
        saveFileName(data, format),
        serializeSave(data, format),
        mimeForSaveFormat(format),
        acceptForSaveFormat(format),
      );
      results.push(result);
    }
    const cancelled = results.filter((result) => result === "cancelled").length;
    if (cancelled > 0) {
      setNotice(
        cancelled === 2
          ? "Save written internally; both file dialogs were cancelled."
          : "Save written internally; one file dialog was cancelled.",
      );
      return;
    }
    setNotice("Matching JSON and XML saves written with the same timestamp.");
  };

  /**
   * Dev Tools: fork the run.
   *
   * Keeps the settlement exactly as it stands — resources, buildings, unlocks,
   * statistics — but gives it a new save identity and a new run log, so this
   * branch writes to its own files and the ones already on disk are left alone.
   * That is the "try another line without losing the run I already did" move:
   * the current state is the branch point.
   */
  const forkRun = async (): Promise<void> => {
    const parent = devLog?.runId ?? saveGuid;
    // A fresh guid is what gives the fork its own save file name; every other
    // field of the document is carried over untouched.
    const identity = { guid: generateSaveGuid(), createdAtMs: Date.now() };
    saveIdentityRef.current = identity;
    setSaveGuid(identity.guid);

    // The log only exists while dev mode is on, so only fork it then — minting
    // one here would put a dev section into a save made outside dev mode.
    if (devMode) {
      const runId = generateSaveGuid();
      devRunIdRef.current = runId;
      const forked = appendDevLogEvent(
        createDevLog(runId),
        buildDevLogEvent(
          gameState,
          "load",
          "forked",
          devLogGameSeconds(gameState),
          parent
            ? `forked from run ${parent.slice(0, 8)}`
            : "forked with no parent run",
        ),
      );
      devLogRef.current = forked;
      setDevLog(forked);
      // Diff the next tick against this state, or the fork point itself would be
      // logged as a burst of events that happened the moment of forking.
      previousLoggedStateRef.current = gameState;
      flushDevLogToDisk(forked);
    }

    const fileName = await exportSaveDocument(
      writeInternalSave(gameState, identity),
    );
    const fork = identity.guid.slice(0, 8);
    setNotice(
      fileName
        ? `Forked into run ${fork} and written to ${fileName}; the previous save and log files are untouched.`
        : `Forked into run ${fork}; the previous save and log files are untouched.`,
    );
  };

  /** Parse imported text and adopt it, reporting anything unreadable. */
  const importText = (
    text: string,
    source: string,
    options: { offlineGain: boolean },
  ): void => {
    const format = detectSaveFormat(text) ?? saveFormat;
    try {
      adoptSave(parseSave(text, format), { ...options, source });
    } catch (error) {
      const reason =
        error instanceof SaveFormatError
          ? error.message
          : "That text is not a readable save.";
      setNotice(`Import failed: ${reason}`);
    }
  };

  /** Settings: import. Base64 reads the clipboard first, then falls back. */
  const handleImport = async (): Promise<void> => {
    if (saveFormat === "base64") {
      const clipboard = await readTextFromClipboard();
      if (clipboard && detectSaveFormat(clipboard)) {
        importText(clipboard, "the clipboard", { offlineGain: true });
        return;
      }
    }
    const accept =
      saveFormat === "json" || saveFormat === "xml"
        ? acceptForSaveFormat(saveFormat)
        : anySaveAccept;
    const file = await openTextFile(accept);
    if (!file) return;
    importText(file.text, file.name, { offlineGain: true });
  };

  /** Dev Tools: import a save and ignore the offline gain entirely. */
  const handleDevImport = async (): Promise<void> => {
    const file = await openTextFile(anySaveAccept);
    if (!file) return;
    importText(file.text, file.name, { offlineGain: false });
  };

  /** Dev Tools: discard everything and start the first loop over. */
  const resetToStart = (): void => {
    clearStoredSave();
    saveIdentityRef.current = null;
    setSaveGuid("");
    setLastSavedAtMs(null);
    setPendingLoad(null);
    setMultiplier(1);
    setLargeMultiplier(100);
    setGameState(new CivilizationState());
    setDismissedAchievements([]);
    // A new run means a new log id, and therefore a new file under saves/auto.
    devLogRef.current = null;
    setDevLog(null);
    devRunIdRef.current = null;
    previousLoggedStateRef.current = null;
    setNotice("New settlement founded; the previous run was discarded.");
  };

  /** Offline panel: credit the gains and start playing. */
  const collectOfflineGain = (): void => {
    if (!pendingLoad) return;
    setGameState(pendingLoad.state.applyOfflineGain(pendingLoad.gains));
    const credited = Object.keys(pendingLoad.gains)
      .map((key) => fmt(pendingLoad.gains[key]))
      .join(", ");
    setNotice(
      `Welcome back after ${formatDuration(
        cappedOfflineMs(pendingLoad.elapsedMs),
      )} — credited ${credited}.`,
    );
    setPendingLoad(null);
  };

  /** Offline panel: keep the save but skip the offline production. */
  const skipOfflineGain = (): void => {
    if (!pendingLoad) return;
    setGameState(pendingLoad.state);
    setNotice(`Save loaded from ${pendingLoad.source}, offline gain skipped.`);
    setPendingLoad(null);
  };

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

  /**
   * Sets a resource's assigned worker count to an absolute target (the
   * production card's count input). The delta is routed through the existing
   * assign/unassign commands, which clamp it to the available population and
   * the workers already on that resource.
   */
  const setWorkerCount = (
    resourceKey: ProductionResourceKey,
    target: number,
  ) => {
    const next = Math.max(0, Math.floor(target));
    setGameState((current) => {
      const assigned = Math.round(
        (current.workers[resourceKey] ?? ExpNumber.ZERO).toNumber(),
      );
      const delta = next - assigned;
      if (delta > 0) return current.assignWorker(resourceKey, delta);
      if (delta < 0) return current.unassignWorker(resourceKey, -delta);
      return current;
    });
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
    // Dev Tools only exist while dev mode is on.
    if (label === "Dev Tools") return devMode;
    if (label === "Army") return gameState.isBuildingAvailable("barracks");
    if (label === "Research")
      return gameState.isBuildingAvailable("university");
    if (label === "Trade") return gameState.isBuildingAvailable("market");
    return true;
  });

  const unlockedUpgrades = upgradeDefinitions.filter(
    (upgrade) =>
      gameState.isUpgradeUnlocked(upgrade.key) &&
      !gameState.isUpgradeBought(upgrade.key),
  );
  const boughtUpgrades = upgradeDefinitions.filter((upgrade) =>
    gameState.isUpgradeBought(upgrade.key),
  );
  const hasAffordableUpgrade = unlockedUpgrades.some((upgrade) =>
    gameState.hasResourcesForUpgrade(upgrade.key),
  );
  const hasAffordableResearch =
    researchDefinitions.some(
      (research) =>
        gameState.isResearchUnlocked(research.key) &&
        !gameState.isResearchBought(research.key),
    ) && gameState.hasResourcesForResearch();
  const hasReadyBattle = gameState.getNextBattle() !== undefined;
  const earnedAchievementCount = gameState.earnedAchievements.length;
  const builtByKeyRows = buildingDefinitions.flatMap((building) => {
    const count = statistics.buildingsBuiltByKey[building.key];
    return count === undefined || count.isZero
      ? []
      : [{ key: building.key, name: building.name, count }];
  });

  const describeUpgradeBonus = (bonus: Bonus): string => {
    if (bonus.type === "attributeFlat") {
      const attribute = derivedAttributeDefinitions.find(
        ({ key }) => key === bonus.destination,
      );
      if (attribute) return `${attribute.label} +${fmt(bonus.value)}`;
    }
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
      const isAllBuildings = bonus.destination === "allBuildings";
      const building = isAllBuildings
        ? undefined
        : buildingDefinitions.find(({ key }) => key === bonus.destination);
      const target = building
        ? building.name
        : isAllBuildings
          ? "all buildings"
          : String(bonus.destination);
      if (bonus.type === "costReductionPercent") {
        const percent =
          Math.round(
            bonus.value.mul(ExpNumber.fromNumber(100)).toNumber() * 10,
          ) / 10;
        return `${target} cost −${percent}%`;
      }
      if (bonus.type === "costReductionFactor") {
        return `${target} cost growth ^${fmt(bonus.value)}`;
      }
      if (bonus.type === "costReductionFlat") {
        return `${target} cost −${fmt(bonus.value)}`;
      }
      if (bonus.type === "costReductionBase") {
        return `${target} base cost ×${fmt(bonus.value)}`;
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
    const unitTarget = parseUnitStatTarget(String(bonus.destination));
    const target = unitTarget
      ? unitStatTargetLabel(unitTarget)
      : definition
        ? (definition.name ?? definition.label ?? definition.id)
        : String(bonus.destination);
    if (bonus.type === "attributeMultiplier") {
      if (
        bonus.destination === "buildingCostMultiplier" &&
        bonus.value.gt(ExpNumber.ZERO) &&
        bonus.value.lte(ExpNumber.ONE)
      ) {
        return `Building base costs: ÷${fmt(ExpNumber.ONE.div(bonus.value))}`;
      }
      return `${target} ×${fmt(bonus.value)}`;
    }
    if (bonus.type === "costReductionBase") {
      return `${target} base cost ×${fmt(bonus.value)}`;
    }
    if (bonus.type === "costReductionFactor") {
      return `${target} cost growth ^${fmt(bonus.value)}`;
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
      const value = !previous
        ? bonus.value
        : bonus.type === "attributeMultiplier" ||
            bonus.type === "costReductionBase" ||
            bonus.type === "costReductionFactor"
          ? previous.value.mul(bonus.value)
          : bonus.type === "costReductionPercent"
            ? ExpNumber.ONE.sub(
                ExpNumber.ONE.sub(previous.value).mul(
                  ExpNumber.ONE.sub(bonus.value),
                ),
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
                <div
                  className="era-progress era-progress-battles"
                  title="Battle progress"
                >
                  <i
                    style={{
                      width: `${(battleProgress[0] / Math.max(1, battleProgress[1])) * 100}%`,
                    }}
                  />
                </div>
                <div
                  className="era-progress era-progress-buildings"
                  title="Building progress"
                >
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
              {label === "Upgrades" && unlockedUpgrades.length > 0 && (
                <span
                  className={`tab-notification${
                    hasAffordableUpgrade ? "" : " pending"
                  }`}
                  title={
                    hasAffordableUpgrade
                      ? "Upgrade available to buy"
                      : "Upgrade unlocked, but not enough resources"
                  }
                >
                  <span className="visually-hidden">
                    {hasAffordableUpgrade
                      ? "Upgrade available to buy"
                      : "Upgrade unlocked, but not enough resources"}
                  </span>
                </span>
              )}
              {label === "Research" && hasAffordableResearch && (
                <span className="tab-notification" title="Research available">
                  <span className="visually-hidden">Research available</span>
                </span>
              )}
              {label === "Army" && hasReadyBattle && (
                <span className="tab-notification" title="Battle available">
                  <span className="visually-hidden">Battle available</span>
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
                <div
                  className={`resource-copy${
                    key === "population" ? " stacked" : ""
                  }`}
                >
                  <span>{label}</span>
                  <strong>
                    {key === "population"
                      ? `${fmtCount(availableWorkers)}/${fmtCount(population)}`
                      : fmtSummary(resourceAmounts[key])}
                  </strong>
                  {key === "population" ? (
                    <small className="resource-note">
                      capacity {fmtCount(maximumPopulation)}
                    </small>
                  ) : (
                    <small className={`resource-rate ${resourceRateTone(key)}`}>
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
                  <div className="dev-tools-control">
                    <span>Last tick compute</span>
                    <strong>{lastTickMs.toFixed(2)} ms</strong>
                  </div>
                  <DevNumberField
                    label="Clicks / second"
                    value={String(gameState.autoClicksPerSecond)}
                    ariaLabel="Auto clicks per second (accepts 1e6, 1.5K, 2M, 1A)"
                    placeholder="e.g. 10, 1e6, 2M"
                    onCommit={(parsed) => {
                      const clicks = Math.max(0, Math.floor(parsed.toNumber()));
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
                    onClick={() => setAutoAssignWorkers((current) => !current)}
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
                    <button
                      type="button"
                      className={`dev-tools-toggle ${paused ? "on" : ""}`}
                      aria-pressed={paused}
                      onClick={() => setPaused((current) => !current)}
                    >
                      <span>{paused ? "Resume" : "Pause"}</span>
                      <strong>{paused ? "ON" : "OFF"}</strong>
                    </button>
                  </div>
                  <div className="dev-tools-control">
                    <span>Last tick compute</span>
                    <strong>{lastTickMs.toFixed(2)} ms</strong>
                  </div>
                </div>
              </section>
              <section className="dev-tools-panel" aria-label="Free purchases">
                <div className="dev-tools-heading">
                  <p className="eyebrow">Free purchases</p>
                  <h3>Build &amp; adopt for free</h3>
                  <p className="dev-tools-copy">
                    Skip cost checks and deduction for buildings, units and
                    upgrades; capacity and unlock gates stay unchanged.
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
                  <button
                    type="button"
                    className={`dev-tools-toggle ${gameState.freeUpgrades ? "on" : ""}`}
                    aria-pressed={gameState.freeUpgrades}
                    onClick={() =>
                      setGameState((current) =>
                        current.setFreeUpgrades(!current.freeUpgrades),
                      )
                    }
                  >
                    <span>Free upgrades</span>
                    <strong>{gameState.freeUpgrades ? "ON" : "OFF"}</strong>
                  </button>
                </div>
              </section>
              <section className="dev-tools-panel" aria-label="Save state">
                <div className="dev-tools-heading">
                  <p className="eyebrow">Save system</p>
                  <h3>Save state</h3>
                  <p className="dev-tools-copy">
                    Reset discards the run and clears the stored save. Fork
                    keeps the settlement exactly as it is but starts a new save
                    and run log, so you can try another line without touching the
                    files you already have. Import loads a save file directly and
                    ignores the offline-gain pass that a normal import would show.
                  </p>
                </div>
                <div className="dev-tools-controls">
                  <div className="dev-tools-control">
                    <span>Save file</span>
                    <strong>
                      {saveGuid ? saveGuid.slice(0, 8) : "unsaved"}
                    </strong>
                  </div>
                  <button
                    type="button"
                    className="dev-tools-toggle danger"
                    onClick={resetToStart}
                  >
                    <span>Reset to start</span>
                    <strong>RESET</strong>
                  </button>
                  <button
                    type="button"
                    className="dev-tools-toggle"
                    onClick={() => void handleDevImport()}
                  >
                    <span>Import (no offline gain)</span>
                    <strong>IMPORT</strong>
                  </button>
                  <button
                    type="button"
                    className="dev-tools-toggle"
                    onClick={() => void handleSaveBothFormats()}
                  >
                    <span>Save JSON + XML together</span>
                    <strong>EXPORT</strong>
                  </button>
                </div>
                <div className="dev-tools-controls">
                  <div className="dev-tools-control">
                    <span>Run log</span>
                    <strong>
                      {devLog
                        ? `${devLog.events.length}e / ${devLog.snapshots.length}s`
                        : "not started"}
                    </strong>
                  </div>
                  <div className="dev-tools-control">
                    <span>Log file</span>
                    <strong>
                      {devLog ? devLog.fileName : "saves/auto/…"}
                    </strong>
                  </div>
                  <button
                    type="button"
                    className="dev-tools-toggle"
                    onClick={() => {
                      if (devLog) flushDevLogToDisk(devLog);
                      setNotice(
                        devLog
                          ? `Run log pushed to saves/auto/${devLog.fileName}.`
                          : "No run log yet — play a few seconds first.",
                      );
                    }}
                  >
                    <span>Write log to saves/auto</span>
                    <strong>WRITE</strong>
                  </button>
                  <button
                    type="button"
                    className="dev-tools-toggle"
                    onClick={() => {
                      if (!devLog) {
                        setNotice("No run log yet — play a few seconds first.");
                        return;
                      }
                      downloadTextFile(
                        devLog.fileName,
                        serializeDevLog(devLog),
                        "application/json",
                      );
                      setNotice(`Run log downloaded as ${devLog.fileName}.`);
                    }}
                  >
                    <span>Download log</span>
                    <strong>DOWNLOAD</strong>
                  </button>
                  <button
                    type="button"
                    className="dev-tools-toggle"
                    onClick={() => void forkRun()}
                  >
                    <span>Fork run (new save + log file)</span>
                    <strong>FORK</strong>
                  </button>
                </div>
              </section>

              <BattleSimulatorPanel gameState={gameState} fmt={fmt} />
            </>
          )}

          {activeTab === "Research" && (
            <ResearchPanel
              gameState={gameState}
              setGameState={setGameState}
              fmt={fmt}
              onOpenGamepedia={openGamepediaAt}
            />
          )}

          {activeTab === "Army" && (
            <ArmyPanel
              gameState={gameState}
              setGameState={setGameState}
              multiplier={multiplier}
              fmt={fmt}
              onOpenGamepedia={openGamepediaAt}
              activeBattle={activeBattle}
              setActiveBattle={setActiveBattle}
              battleRoundIndex={battleRoundIndex}
              setBattleRoundIndex={setBattleRoundIndex}
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
                  <Users size={14} /> {fmtCount(availableWorkers)} workers
                  available
                </span>
              </div>
              <div className="gather-grid">
                {resources
                  .filter(({ key }) => {
                    if (key === "military")
                      return gameState.getBuildingCount("barracks") > 0;
                    if (key === "science")
                      return gameState.getBuildingCount("university") > 0;
                    if (key === "metalwork")
                      return gameState.getBuildingCount("smithy") > 0;
                    if (key === "trade")
                      return gameState.getBuildingCount("market") > 0;
                    return true;
                  })
                  .map(({ key, label, icon: Icon, tone }) => {
                    const canGather = key in workers;
                    return (
                      <div className="gather-card" key={key}>
                        {canGather ? (
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
                        ) : (
                          <div className={`gather-button ${tone}`}>
                            <span className="gather-card-icon">
                              <Icon size={18} strokeWidth={1.8} />
                            </span>
                            <span>
                              <strong>{label}</strong>
                              <small>{fmt(resourceAmounts[key])} stored</small>
                            </span>
                            <span className="gather-action">
                              {formatResourceRate(key)}
                            </span>
                          </div>
                        )}
                        {canGather && (
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
                            <WorkerCountInput
                              label={label}
                              count={workers[key]}
                              format={numberFormat}
                              onCommit={(target) => setWorkerCount(key, target)}
                            />
                            <button
                              onClick={() => changeWorkers(key, 1)}
                              disabled={availableWorkers === 0}
                              aria-label={`Assign ${label} worker`}
                            >
                              +
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
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
                boughtUpgrades.length === 0 && (
                  <p className="tab-placeholder-copy">
                    Building upgrades and capacity expansions will unlock as
                    your settlement advances.
                  </p>
                )
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
                        {upgrade.costs.map(({ resource, base }) => {
                          const lacking =
                            !gameState.freeUpgrades &&
                            resourceAmounts[resource].lt(base);
                          return (
                            <span
                              key={resource}
                              className={
                                lacking ? "building-cost-lacking" : undefined
                              }
                            >
                              {fmt(base)} {resource}
                            </span>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        className={`upgrade-buy ${
                          gameState.hasResourcesForUpgrade(upgrade.key)
                            ? "affordable"
                            : "unaffordable"
                        }`}
                        onClick={() => buyUpgrade(upgrade)}
                      >
                        {gameState.hasResourcesForUpgrade(upgrade.key)
                          ? "Adopt upgrade"
                          : "Not enough resources"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {boughtUpgrades.length > 0 && (
                <>
                  <div className="workbench-heading upgrade-history-heading">
                    <div>
                      <p className="eyebrow">Permanent improvements</p>
                      <h4>Adopted upgrades</h4>
                    </div>
                    <span>{boughtUpgrades.length} bought</span>
                  </div>
                  <div className="upgrade-grid">
                    {boughtUpgrades.map((upgrade) => (
                      <div
                        className="upgrade-card upgrade-card-bought"
                        key={upgrade.key}
                      >
                        <div className="upgrade-heading">
                          <strong>{upgrade.name}</strong>
                          <small>{upgrade.description}</small>
                        </div>
                        <ul className="upgrade-effects">
                          {upgrade.bonuses.map((bonus, index) => (
                            <li key={index}>{describeUpgradeBonus(bonus)}</li>
                          ))}
                        </ul>
                        <span className="upgrade-status">Adopted</span>
                      </div>
                    ))}
                  </div>
                </>
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
                    .filter(
                      (tier): tier is AchievementDefinition =>
                        tier !== undefined && tier.family === family,
                    )
                    .sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
                  const goal = gameState.getNextAchievementGoal(family);
                  const complete = goal === undefined;
                  const progress = gameState.getRequirementValue(
                    tiers[0].requirement,
                  );
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
                        <small>
                          {focus.description.replaceAll("/sec", "/s")}
                        </small>
                        {!complete && goal && progress && (
                          <small className="achievement-goal">
                            {fmt(progress)} / {fmt(goal.threshold)} — next:{" "}
                            {describeRewardList([
                              ...earnedTiers
                                .flatMap((tier) => tier.bonuses)
                                .filter(
                                  (bonus) =>
                                    bonus.destination ===
                                    "buildingCostMultiplier",
                                ),
                              ...goal.bonuses,
                            ])}
                            {goal.bonuses.some(
                              (bonus) =>
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
            <TradePanel
              gameState={gameState}
              setGameState={setGameState}
              fmt={fmt}
              onNotice={setNotice}
            />
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
                  {formatDuration(totalTimeMs)} total
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
                  <span>Total time</span>
                  <strong>{formatDuration(totalTimeMs)}</strong>
                </div>
                <div className="stat-card">
                  <span>Offline time</span>
                  <strong>{formatDuration(statistics.offlineTimeMs)}</strong>
                </div>
                <div className="stat-card">
                  <span>Online time</span>
                  <strong>{formatDuration(statistics.onlineTimeMs)}</strong>
                </div>
                <div className="stat-card">
                  <span>Longest offline streak</span>
                  <strong>{formatDuration(statistics.longestOfflineMs)}</strong>
                </div>
                <div className="stat-card">
                  <span>Longest active streak</span>
                  <strong>{formatDuration(statistics.longestActiveMs)}</strong>
                </div>
              </div>

              <p className="gamepedia-category">Construction</p>
              <div className="stat-grid">
                <div className="stat-card">
                  <span>Buildings built (all time)</span>
                  <strong>{fmtCount(statistics.buildingsBuilt)}</strong>
                </div>
                <div className="stat-card">
                  <span>Buildings standing</span>
                  <strong>
                    {fmtCount(
                      Object.values(gameState.builtBuildings).reduce(
                        (sum, count) => sum + count,
                        0,
                      ),
                    )}
                  </strong>
                </div>
              </div>
              {builtByKeyRows.length > 0 && (
                <div className="stat-row-list">
                  {builtByKeyRows.map(({ key, name, count }) => (
                    <div className="stat-row" key={key}>
                      <span>{name}</span>
                      <strong>{fmtCount(count)}</strong>
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

              <div className="workbench-heading settings-section-heading">
                <div>
                  <p className="eyebrow">Developer</p>
                  <h3>Dev mode</h3>
                </div>
                <span>{devMode ? "on" : "off"}</span>
              </div>
              <p className="dev-tools-copy">
                Dev mode shows the Dev Tools tab and records a run log: every
                remarkable event plus a snapshot every{" "}
                {DEFAULT_DEV_LOG_SNAPSHOT_SECONDS} seconds, written to{" "}
                <strong>saves/auto</strong> so a real session can be compared with
                a simulation. It defaults to{" "}
                {devBuildDefault ? "on for this dev build" : "off for this build"},
                and the choice is remembered.
              </p>
              <div className="dev-tools-controls">
                <button
                  type="button"
                  className={`dev-tools-toggle ${devMode ? "on" : ""}`}
                  aria-pressed={devMode}
                  onClick={toggleDevMode}
                >
                  <span>Dev mode</span>
                  <strong>{devMode ? "ON" : "OFF"}</strong>
                </button>
              </div>

              <div className="workbench-heading settings-section-heading">
                <div>
                  <p className="eyebrow">Save</p>
                  <h3>Autosave &amp; backup</h3>
                </div>
                <span>
                  {lastSavedAtMs === null
                    ? "not saved yet"
                    : `saved at ${new Date(lastSavedAtMs).toLocaleTimeString()}`}
                </span>
              </div>
              <p className="dev-tools-copy">
                The game always writes an internal JSON save every{" "}
                {autosaveIntervalSeconds}s (0 turns autosave off). The radio
                below picks how Save exports a copy, and how Import reads one:{" "}
                <strong>Base64</strong> goes through the clipboard, and{" "}
                <strong>JSON</strong>/<strong>XML</strong> open a file dialog.
                Save file id: {saveGuid ? saveGuid.slice(0, 8) : "unsaved"}.
              </p>
              <div className="dev-tools-controls">
                <DevNumberField
                  label="Autosave (seconds)"
                  value={String(autosaveIntervalSeconds)}
                  ariaLabel="Autosave interval in seconds (0 turns autosave off)"
                  placeholder="e.g. 10"
                  onCommit={(parsed) => {
                    const seconds = Math.max(0, Math.floor(parsed.toNumber()));
                    if (!Number.isFinite(seconds)) return false;
                    setAutosaveIntervalSeconds(seconds);
                    return true;
                  }}
                />
              </div>
              <div
                className="format-picker"
                role="radiogroup"
                aria-label="Save format"
              >
                {saveFormatOptions.map(({ value, label, hint }) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={saveFormat === value}
                    className={`format-option ${
                      saveFormat === value ? "active" : ""
                    }`}
                    onClick={() => setSaveFormat(value)}
                  >
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </button>
                ))}
              </div>
              <div className="save-actions">
                <button
                  type="button"
                  className="save-button primary"
                  onClick={() => void handleSaveNow()}
                >
                  Save &amp; export
                </button>
                <button
                  type="button"
                  className="save-button"
                  onClick={() => void handleImport()}
                >
                  Import
                </button>
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
          <span className="buildingCount">
            {Object.values(gameState.builtBuildings).reduce(
              (sum, count) => sum + count,
              0,
            )}{" "}
            built
          </span>
        </div>
        <div className="building-grid">
          {buildings.map((building) => {
            const Icon = building.icon;
            const buildingCount =
              gameState.builtBuildings[building.key as BuildingKey] ?? 0;
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
                        {fmtCount(buildingCount)}/
                        {fmtCount(gameState.getBuildingMax(building.key))}
                      </span>
                    </span>
                    <em>
                      {(() => {
                        const isMax = multiplier === "Max";
                        const maxAffordable =
                          gameState.getMaxAffordableBuildings(building.key);
                        const purchaseCount = isMax
                          ? Math.max(1, maxAffordable)
                          : multiplier;
                        const costs = gameState.getBuildingCost(
                          building.key,
                          buildingCount,
                          purchaseCount,
                        );
                        return (
                          <>
                            {isMax && maxAffordable > 0 && (
                              <span className="building-cost-count">
                                &times;{fmtCount(maxAffordable)}{" "}
                              </span>
                            )}
                            {costs.map(({ resource, base }, index) => {
                              const lacking =
                                !gameState.freeBuildings &&
                                resourceAmounts[resource].lt(base);
                              return (
                                <span key={resource}>
                                  {index > 0 && " + "}
                                  <span
                                    className={
                                      lacking
                                        ? "building-cost-lacking"
                                        : undefined
                                    }
                                  >
                                    {fmt(base)} {resource}
                                  </span>
                                </span>
                              );
                            })}
                          </>
                        );
                      })()}
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

      <section
        className="achievement-notifications"
        aria-label="Achievement notifications"
      >
        <div role="status" aria-live="polite" aria-atomic="true">
          {pendingAchievements.length > 0 && (
            <strong>
              <Trophy size={18} strokeWidth={1.8} /> Achievements earned:{" "}
              {fmt(pendingAchievements.length)}
              <span className="visually-hidden">
                {pendingAchievements
                  .map(
                    ({ name, description }) =>
                      `${name}: ${description.replaceAll("/sec", "/s")}`,
                  )
                  .join(". ")}
              </span>
            </strong>
          )}
        </div>
        {pendingAchievements.length > 0 && (
          <>
            <button
              type="button"
              className="notice-link"
              onClick={() =>
                setDismissedAchievements((current) => [
                  ...current,
                  ...pendingAchievements.map(({ key }) => key),
                ])
              }
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
                  <p>
                    Reward:{" "}
                    {describeRewardList(achievement.bonuses) ||
                      "Achievement recorded"}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {pendingLoad && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="offline-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="offline-gain-title"
          >
            <div className="offline-heading">
              <p className="eyebrow">While you were away</p>
              <h3 id="offline-gain-title">Offline production</h3>
            </div>
            <p className="offline-copy">
              The save from <strong>{pendingLoad.source}</strong> is{" "}
              {formatDuration(pendingLoad.elapsedMs)} old. Settlers kept working
              for {formatDuration(cappedOfflineMs(pendingLoad.elapsedMs))} at
              25% of live output
              {pendingLoad.elapsedMs > MAX_OFFLINE_MS
                ? " (capped at 12 hours)"
                : ""}
              . Collect to credit it, or Skip to load the save as it was.
            </p>
            <ul className="offline-gain-list">
              {Object.entries(pendingLoad.gains).map(([key, amount]) => {
                const presentation =
                  resourcePresentation[key as ProductionResourceKey];
                const Icon = presentation?.icon ?? Sparkles;
                return (
                  <li key={key}>
                    <span
                      className={`resource-icon ${presentation?.tone ?? ""}`}
                    >
                      <Icon size={16} strokeWidth={1.8} />
                    </span>
                    <span>
                      {productionDefinitions.find(({ key: k }) => k === key)
                        ?.label ?? key}
                    </span>
                    <strong>+{fmt(amount)}</strong>
                  </li>
                );
              })}
            </ul>
            <div className="offline-actions">
              <button
                type="button"
                className="save-button primary"
                onClick={collectOfflineGain}
              >
                Collect
              </button>
              <button
                type="button"
                className="save-button"
                onClick={skipOfflineGain}
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}

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
