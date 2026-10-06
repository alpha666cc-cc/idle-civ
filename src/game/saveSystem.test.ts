import { describe, expect, it } from "vitest";
import {
  MAX_OFFLINE_MS,
  OFFLINE_EFFICIENCY,
  SAVE_VERSION,
  SaveFormatError,
  calculateOfflineGain,
  cappedOfflineMs,
  createSaveData,
  detectSaveFormat,
  fileExtensionFor,
  findUnknownContentIds,
  fromBase64,
  generateSaveGuid,
  loadSaveData,
  migrateSaveData,
  parseSave,
  remapSaveIds,
  saveFileName,
  saveFromBase64,
  saveFromJson,
  saveFromXml,
  saveToBase64,
  saveToJson,
  saveToXml,
  serializeSave,
  toBase64,
  type SaveData,
} from "./saveSystem";
import { CivilizationState } from "./civilizationState";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "./attributes";
import { type BuildingKey } from "./buildings";
import { entryGuidById, entryIdByGuid } from "./dataIds";
import { ExpNumber } from "./expNumber";
import { emptyStatistics } from "./statistics";
import { isTradeRouteSource, type TradeMode } from "./trade";
import {
  achievementDefinitions,
  findAchievementDefinition,
} from "./achievements";
import { ageDefinitions } from "./ages";
import { buildingDefinitions } from "./buildings";
import { encounterDefinitions } from "./encounters";
import { researchDefinitions } from "./research";
import { unitDefinitions } from "./units";
import { upgradeDefinitions } from "./upgrades";
import offlineGainVectors from "./data/offlineGainVectors.json";

/** A state that exercises every field the save has to carry. */
const sampleState = (): CivilizationState =>
  new CivilizationState(
    { ...emptyResourceAmounts(), food: ExpNumber.fromNumber(1e30) },
    { ...emptyWorkerAssignments(), food: ExpNumber.fromNumber(3) },
    { townHall: 1, house: 1, farm: 2, people: 2 },
    emptyResourceFactors(),
    {},
    5,
    ["farmEnhancer9"],
    ["age0_1_first_fire"],
    ["age0"],
    ["growingHamlet"],
    emptyStatistics(),
    { warrior: ExpNumber.fromNumber(12) },
    ExpNumber.fromNumber(3),
    true,
    false,
    true,
    ["tribal_organization"],
  );

const sampleSave = (): SaveData =>
  createSaveData(sampleState(), "11111111-2222-4333-8444-555555555555", 1000);

describe("save document identity", () => {
  it("keeps the guid and creation time, and stamps a fresh write time", () => {
    const before = Date.now();
    const data = createSaveData(sampleState(), "abc-guid", 4242);
    expect(data.guid).toBe("abc-guid");
    expect(data.createdAtMs).toBe(4242);
    expect(data.version).toBe(SAVE_VERSION);
    expect(data.savedAtMs).toBeGreaterThanOrEqual(before);
  });

  describe("save round-trips", () => {
    it("survives JSON unchanged", () => {
      const data = sampleSave();
      expect(saveFromJson(saveToJson(data))).toEqual(data);
    });

    it("survives Base64 unchanged", () => {
      const data = sampleSave();
      expect(saveFromBase64(saveToBase64(data))).toEqual(data);
    });

    it("survives XML unchanged", () => {
      const data = sampleSave();
      const xml = saveToXml(data);
      expect(xml).not.toContain("CDATA");
      expect(xml).not.toContain("<data>");
      expect(saveFromXml(xml)).toEqual(data);
    });

    it("survives a payload containing the CDATA terminator", () => {
      const data: SaveData = {
        ...sampleSave(),
        referencedGuids: { "]]>": "tricky", "a]]>b": "trickier" },
      };
      expect(saveFromXml(saveToXml(data)).referencedGuids).toEqual(
        data.referencedGuids,
      );
    });

    it("keeps every value exactly on a re-encode in each format", () => {
      const data = sampleSave();
      for (const format of ["json", "base64", "xml"] as const) {
        expect(parseSave(serializeSave(data, format), format)).toEqual(data);
      }
    });

    it("keeps unknown extra keys, so a newer field survives an older build", () => {
      const json = JSON.stringify({
        ...JSON.parse(saveToJson(sampleSave())),
        somethingFromTheFuture: { nested: [1, 2, 3] },
      });
      const restored = saveFromJson(json) as SaveData & Record<string, unknown>;
      expect(restored.somethingFromTheFuture).toEqual({ nested: [1, 2, 3] });
    });

    it("keeps 1e300 exact through every format", () => {
      const data = createSaveData(
        new CivilizationState({
          ...emptyResourceAmounts(),
          food: ExpNumber.fromNumber(1e300),
        }),
        "big-value",
        1,
      );
      for (const format of ["json", "base64", "xml"] as const) {
        const restored = loadSaveData(
          parseSave(serializeSave(data, format), format),
        );
        expect(restored.resources.food.toString()).toBe("1e300");
      }
    });
  });

  it("persists action controls and dismissed achievement notifications", () => {
    const data = createSaveData(sampleState(), "ui-state", 1, {
      actionMultiplier: "Max",
      largeMultiplier: 1000000,
      dismissedAchievements: ["click100"],
    });
    const restored = saveFromJson(saveToJson(data));
    expect(restored.actionMultiplier).toBe("Max");
    expect(restored.largeMultiplier).toBe(1000000);
    expect(restored.dismissedAchievements).toEqual(["click100"]);
  });

  it("stores repeated buildings as counts instead of an entry per building", () => {
    const state = new CivilizationState(
      emptyResourceAmounts(),
      emptyWorkerAssignments(),
      { farm: 1_000_000 },
    );
    const data = createSaveData(state, "compact-buildings", 1);
    expect(data.buildingCounts).toEqual({ farm: "1000000" });
    expect(saveToJson(data)).not.toContain('"builtBuildings"');
  });

  describe("save validation", () => {
    it("rejects text that is not JSON", () => {
      expect(() => saveFromJson("not json at all")).toThrow(SaveFormatError);
    });

    it("rejects a document with no version", () => {
      expect(() => saveFromJson("{}")).toThrow(/version/);
    });

    it("rejects a document from a newer build", () => {
      const data = { ...sampleSave(), version: SAVE_VERSION + 1 };
      expect(() => saveFromJson(JSON.stringify(data))).toThrow(/newer build/);
    });

    it("rejects a document with no guid", () => {
      const data = { ...sampleSave(), guid: "" };
      expect(() => saveFromJson(JSON.stringify(data))).toThrow(/GUID/);
    });

    it("rejects a document with no timestamp", () => {
      const data = { ...sampleSave() } as Record<string, unknown>;
      delete data.savedAtMs;
      expect(() => saveFromJson(JSON.stringify(data))).toThrow(/timestamp/);
    });

    it("rejects a document with no resources", () => {
      const data = { ...sampleSave() } as Record<string, unknown>;
      delete data.resources;
      expect(() => saveFromJson(JSON.stringify(data))).toThrow(/resources/);
    });

    it("rejects Base64 that is not Base64", () => {
      expect(() => saveFromBase64("!!! definitely not base64 !!!")).toThrow(
        SaveFormatError,
      );
    });

    it("rejects XML with no typed save data", () => {
      expect(() => saveFromXml("<save><data>nope</data></save>")).toThrow(
        /save data/,
      );
    });

    it("accepts non-ASCII text through Base64", () => {
      expect(fromBase64(toBase64("café — 文明"))).toBe("café — 文明");
    });
  });

  it("generates a distinct guid per call", () => {
    const guids = new Set(Array.from({ length: 50 }, () => generateSaveGuid()));
    expect(guids.size).toBe(50);
    for (const guid of guids) expect(guid.length).toBeGreaterThan(8);
  });
});
describe("migration", () => {
  it("bumps an older version without touching anything else", () => {
    const old = { ...sampleSave(), version: 0 } as SaveData;
    const migrated = migrateSaveData(old);
    expect(migrated.version).toBe(SAVE_VERSION);
    expect({ ...migrated, version: 0 }).toEqual(old);
  });

  it("is a no-op at the current version", () => {
    const data = sampleSave();
    expect(migrateSaveData(data)).toBe(data);
  });

  it("refuses to down-convert a newer document", () => {
    const future = { ...sampleSave(), version: SAVE_VERSION + 5 };
    expect(() => migrateSaveData(future)).toThrow(/newer build/);
  });

  it("converts kebab-case achievement IDs to camelCase in v3 → v4", () => {
    const v3Save: SaveData = {
      ...sampleSave(),
      version: 3,
      earnedAchievements: ["food-hoarder-5", "stone-hoarder-5"],
      dismissedAchievements: ["another-old-achievement"],
    };
    const migrated = migrateSaveData(v3Save);
    expect(migrated.version).toBe(SAVE_VERSION);
    expect(migrated.earnedAchievements).toEqual([
      "foodHoarder5",
      "stoneHoarder5",
    ]);
    expect(migrated.dismissedAchievements).toEqual(["anotherOldAchievement"]);
  });
});

describe("format detection and file names", () => {
  it("detects JSON, XML and Base64", () => {
    const data = sampleSave();
    expect(detectSaveFormat(saveToJson(data))).toBe("json");
    expect(detectSaveFormat(saveToXml(data))).toBe("xml");
    expect(detectSaveFormat(saveToBase64(data))).toBe("base64");
  });

  it("returns null for empty or unrecognisable text", () => {
    expect(detectSaveFormat("")).toBeNull();
    expect(detectSaveFormat("hello there")).toBeNull();
  });

  it("extends the suggested file name per format", () => {
    const data = sampleSave();
    expect(fileExtensionFor("xml")).toBe("xml");
    expect(saveFileName(data, "xml").endsWith(".xml")).toBe(true);
    expect(saveFileName(data, "json").endsWith(".json")).toBe(true);
    expect(saveFileName(data, "base64")).toContain(data.guid.slice(0, 8));
  });
});

describe("loading a state", () => {
  it("restores every field it was built from", () => {
    const source = sampleState();
    const restored = loadSaveData(createSaveData(source, "round-trip", 1));
    expect(restored.resources.food.toString()).toBe(
      source.resources.food.toString(),
    );
    expect(restored.workers.food.toString()).toBe(
      source.workers.food.toString(),
    );
    expect(restored.builtBuildings).toEqual(source.builtBuildings);
    expect(restored.boughtUpgrades).toEqual(source.boughtUpgrades);
    expect(restored.defeatedEncounters).toEqual(source.defeatedEncounters);
    expect(restored.enteredAges).toEqual(source.enteredAges);
    expect(restored.earnedAchievements).toEqual(source.earnedAchievements);
    expect(restored.unitCounts.warrior.eq(ExpNumber.fromNumber(12))).toBe(true);
    expect(restored.autoClicksPerSecond).toBe(5);
    expect(restored.devProductionMultiplier.eq(ExpNumber.fromNumber(3))).toBe(
      true,
    );
    expect(restored.freeBuildings).toBe(true);
    expect(restored.freeUnits).toBe(false);
    expect(restored.freeUpgrades).toBe(true);
  });

  it("keeps the free-upgrade dev flag across a worker change", () => {
    // Regression guard: the state-copy helpers used to drop `freeUpgrades`.
    const restored = loadSaveData(createSaveData(sampleState(), "flags", 1));
    expect(restored.assignWorker("food", 1).freeUpgrades).toBe(true);
  });

  it("ignores resource keys the engine does not define", () => {
    const data = sampleSave();
    const poisoned: SaveData = {
      ...data,
      resources: { ...data.resources, notAResource: "1e9" },
    };
    expect("notAResource" in loadSaveData(poisoned).resources).toBe(false);
  });

  it("drops non-positive unit counts", () => {
    const data: SaveData = {
      ...sampleSave(),
      unitCounts: { warrior: "5", slinger: "0", archer_prehist: "-3" },
    };
    expect(Object.keys(loadSaveData(data).unitCounts)).toEqual(["warrior"]);
  });

  it("does not mutate the parsed document's arrays", () => {
    const data = sampleSave();
    // Try to mutate the loaded state's building counts
    const loaded = loadSaveData(data);
    loaded.builtBuildings["mutant" as BuildingKey] = 1;
    expect(data.buildingCounts).not.toHaveProperty("mutant");
  });
});

describe("trade routes in the save", () => {
  it("round-trips an enabled route", () => {
    const data: SaveData = {
      ...sampleSave(),
      tradeRoutes: { food: { enabled: true, mode: "buy", intensity: 0.5 } },
    };

    expect(loadSaveData(data).tradeRoutes.food).toEqual({
      enabled: true,
      mode: "buy",
      intensity: 0.5,
    });
  });

  it("writes only the routes that are actually running", () => {
    const idle = sampleState().setTradeRoute("food", {
      enabled: true,
      intensity: 0.4,
    });

    expect(createSaveData(idle, "routes", 1).tradeRoutes).toEqual({
      food: { enabled: true, mode: "sell", intensity: 0.4 },
    });
    // Turning the route back off leaves no trace in the document.
    const off = idle.setTradeRoute("food", { enabled: false });
    expect(createSaveData(off, "routes", 1).tradeRoutes).toEqual({});
  });

  it("drops routes the market no longer trades and repairs the rest", () => {
    const data: SaveData = {
      ...sampleSave(),
      tradeRoutes: {
        gold: { enabled: true, mode: "sell", intensity: 1 },
        wood: { enabled: true, mode: "barter" as TradeMode, intensity: 7 },
        stone: { enabled: false, mode: "sell", intensity: 1 },
      },
    };
    const routes = loadSaveData(data).tradeRoutes;

    // `in`, not a property read: gold is not a tradeable resource, so the key
    // cannot even be named on `TradeRouteMap` — that is the point of the test.
    expect("gold" in routes).toBe(false);
    expect("stone" in routes).toBe(false);
    expect(routes.wood).toEqual({ enabled: true, mode: "sell", intensity: 1 });
  });

  it("never writes a route's drain rows, and the first tick restores them", () => {
    // A routed settlement with a banked reserve, so the live rows are real.
    const routed = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        trade: ExpNumber.fromNumber(100),
        food: ExpNumber.fromNumber(1e6),
      },
      emptyWorkerAssignments(),
      {},
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
      {},
      { food: { enabled: true, mode: "sell", intensity: 1 } },
    );
    const data = createSaveData(routed, "route-rows", 1);
    const written = Object.values(data.resourceFactors).flatMap((group) => [
      ...group.drain,
      ...group.additional,
    ]);

    // The rows are derived from `tradeRoutes` on every read, so the document
    // carries none of them: a stale drain cannot survive a reload.
    expect(written.some(([source]) => isTradeRouteSource(source))).toBe(false);

    // The first tick after a reload puts the live rows back.
    const restored = loadSaveData(data);
    const drains = restored
      .getProductionFactors("food")
      .drain.map(([source]) => String(source));
    expect(drains.some((source) => isTradeRouteSource(source))).toBe(true);
  });

  it("strips a route row a hand-edited document carries", () => {
    const poisoned: SaveData = {
      ...sampleSave(),
      resourceFactors: {
        food: {
          additional: [],
          multiplicative: [],
          additiveMultiplier: [],
          drain: [["food route", "9.99e99"]],
        },
      },
    };
    const restored = loadSaveData(poisoned);
    // The injected row is gone: only the engine's own rows remain, never a second
    // route drain stacked on the live one.
    const drains = restored
      .getProductionFactors("food")
      .drain.map(([source]) => String(source));
    expect(drains.some((source) => isTradeRouteSource(source))).toBe(false);
  });

  it("carries no routes at all in a version-5 document", () => {
    const { tradeRoutes: _ignored, ...legacy } = sampleSave();
    const migrated = migrateSaveData({
      ...legacy,
      version: 5,
    } as SaveData);

    expect(migrated.version).toBe(SAVE_VERSION);
    expect(loadSaveData(migrated).tradeRoutes).toEqual({});
  });
});
describe("renamed content repair", () => {
  it("re-points an id through the static guid snapshot", () => {
    const oldId = "farmEnhancer9";
    const guid = entryGuidById.get(oldId);
    expect(guid).toBeDefined();
    const renamedTo = "farm-enhancer-renamed-for-the-test";
    // Only content this save actually names is in scope for repair; the state's
    // buildings/ages/achievements stay in the data, exactly as in a real load.
    const known = new Set([
      ...buildingDefinitions.map(({ key }) => key),
      ...ageDefinitions.map(({ key }) => key),
      ...achievementDefinitions.map(({ key }) => key),
      ...encounterDefinitions.map(({ key }) => key),
      ...unitDefinitions.map(({ key }) => key),
      ...upgradeDefinitions.map(({ key }) => key),
      ...researchDefinitions.map(({ key }) => key),
    ]);
    known.delete(oldId);

    const data: SaveData = {
      ...sampleSave(),
      boughtUpgrades: [oldId],
      referencedGuids: { ...sampleSave().referencedGuids, [oldId]: guid! },
    };
    const result = remapSaveIds(
      data,
      (id) => known.has(id) || id === renamedTo,
      (lookedUp) => (lookedUp === guid ? renamedTo : undefined),
    );
    expect(result.data.boughtUpgrades).toEqual([renamedTo]);
    expect(result.renamed).toEqual({ [oldId]: renamedTo });
    expect(result.unknown).toEqual([]);
  });

  it("reports an id whose guid resolves to nothing", () => {
    const data: SaveData = {
      ...sampleSave(),
      boughtUpgrades: ["gone-forever"],
      referencedGuids: {
        "gone-forever": "00000000-0000-5000-8000-000000000000",
      },
    };
    const result = remapSaveIds(
      data,
      (id) => id !== "gone-forever",
      () => undefined,
    );
    expect(result.unknown).toEqual(["gone-forever"]);
    expect(result.renamed).toEqual({});
  });

  it("leaves known ids alone, including id-keyed records", () => {
    const data: SaveData = {
      ...sampleSave(),
      unitCounts: { warrior: "3" },
      statistics: {
        ...sampleSave().statistics,
        buildingsBuiltByKey: { farm: "4" },
      },
    };
    // Everything is known except nothing: no id in this save needs repair.
    const result = remapSaveIds(
      data,
      () => true,
      () => undefined,
    );
    expect(result.unknown).toEqual([]);
    expect(result.renamed).toEqual({});
    expect(result.data.unitCounts).toEqual({ warrior: "3" });
    expect(result.data.statistics.buildingsBuiltByKey).toEqual({ farm: "4" });
  });
});

describe("unknown content detection", () => {
  it("reports ids the data files no longer define", () => {
    const data: SaveData = {
      ...sampleSave(),
      boughtUpgrades: ["farmEnhancer9", "removed-upgrade"],
      unitCounts: { warrior: "1", removed_unit: "2" },
    };
    expect(findUnknownContentIds(data, (id) => entryGuidById.has(id))).toEqual([
      "removed-upgrade",
      "removed_unit",
    ]);
  });

  it("finds nothing unknown in a save taken from a real state", () => {
    expect(
      findUnknownContentIds(sampleSave(), (id) => entryGuidById.has(id)),
    ).toEqual([]);
  });

  it("keeps materialized open-ended achievement tiers during repair", () => {
    const data: SaveData = {
      ...sampleSave(),
      earnedAchievements: ["foodHoarder5", "stoneHoarder5"],
    };
    const repaired = remapSaveIds(
      data,
      (id) =>
        entryGuidById.has(id) || findAchievementDefinition(id) !== undefined,
      () => undefined,
    );
    expect(repaired.unknown).toEqual([]);
    expect(repaired.data.earnedAchievements).toEqual(data.earnedAchievements);
  });
});

describe("offline production", () => {
  const rates = {
    food: ExpNumber.fromNumber(10),
    wood: ExpNumber.fromNumber(4),
    stone: ExpNumber.ZERO,
    gold: ExpNumber.fromNumber(-2),
  };

  it("pays 25% of the live rate for the elapsed time", () => {
    expect(OFFLINE_EFFICIENCY).toBe(0.25);
    const gain = calculateOfflineGain(rates, 3_600_000);
    // ExpNumber arithmetic is float-based, so compare within tolerance.
    expect(gain.food.toNumber()).toBeCloseTo(10 * 3600 * 0.25, 6);
    expect(gain.wood.toNumber()).toBeCloseTo(4 * 3600 * 0.25, 6);
    expect(gain.food.div(ExpNumber.fromNumber(10)).toNumber()).toBeCloseTo(
      3600 * 0.25,
      6,
    );
  });

  it("skips idle and negative rates", () => {
    const gain = calculateOfflineGain(rates, 3_600_000);
    expect("stone" in gain).toBe(false);
    expect("gold" in gain).toBe(false);
  });

  it("returns nothing for a zero, negative or infinite gap", () => {
    expect(calculateOfflineGain(rates, 0)).toEqual({});
    expect(calculateOfflineGain(rates, -5000)).toEqual({});
    expect(calculateOfflineGain(rates, Number.POSITIVE_INFINITY)).toEqual({});
  });

  it("caps the gap at 12 hours", () => {
    expect(MAX_OFFLINE_MS).toBe(43_200_000);
    expect(cappedOfflineMs(MAX_OFFLINE_MS * 10)).toBe(MAX_OFFLINE_MS);
    expect(cappedOfflineMs(-1)).toBe(0);
    const day = calculateOfflineGain(rates, 24 * 3600_000);
    const half = calculateOfflineGain(rates, MAX_OFFLINE_MS);
    expect(day.food.toString()).toBe(half.food.toString());
  });

  it("scales a huge rate without overflowing", () => {
    const gain = calculateOfflineGain(
      { food: ExpNumber.fromNumber(1e300) },
      3_600_000,
    );
    expect(gain.food.isFinite).toBe(true);
    expect(gain.food.exponent).toBeGreaterThan(300);
  });

  it("credits a state and leaves its play time alone", () => {
    // Start from zero so the credit is exactly representable at full precision.
    const state = new CivilizationState(
      emptyResourceAmounts(),
      emptyWorkerAssignments(),
    );
    const credited = state.applyOfflineGain({
      food: ExpNumber.fromNumber(1000),
    });
    expect(credited.resources.food.toNumber()).toBe(1000);
    expect(credited.statistics.playTimeMs).toBe(state.statistics.playTimeMs);
    expect(credited.resources.wood.isZero).toBe(true);
  });

  it("checks achievements after offline credit", () => {
    const state = new CivilizationState({
      ...emptyResourceAmounts(),
      food: ExpNumber.fromNumber(99),
    });
    const credited = state.applyOfflineGain({ food: ExpNumber.ONE });
    expect(credited.resources.food.toNumber()).toBe(100);
    expect(credited.isAchievementEarned("foodHoarder1")).toBe(true);
  });

  it("uses already-earned achievement bonuses in offline rates", () => {
    const state = new CivilizationState(
      emptyResourceAmounts(),
      { ...emptyWorkerAssignments(), food: ExpNumber.ONE },
      {},
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      [],
      ["growingHamlet"],
    );
    const rate = state.getProductionRates().food!;
    const gain = calculateOfflineGain({ food: rate }, 1000);
    expect(gain.food.toNumber()).toBeCloseTo(
      rate.toNumber() * OFFLINE_EFFICIENCY,
      10,
    );
  });

  it("records consecutive online and offline durations", () => {
    const active = new CivilizationState().advanceTime(86_400);
    expect(active.statistics.onlineTimeMs).toBe(86_400_000);
    expect(active.statistics.offlineTimeMs).toBe(0);
    expect(active.statistics.longestActiveMs).toBe(86_400_000);
    expect(active.isAchievementEarned("active24h")).toBe(true);

    const resumed = active.recordOfflineTime(86_400_000).checkAchievements();
    expect(resumed.statistics.offlineTimeMs).toBe(86_400_000);
    expect(resumed.statistics.longestOfflineMs).toBe(86_400_000);
    expect(resumed.statistics.activeStreakMs).toBe(0);
    expect(resumed.isAchievementEarned("offline24h")).toBe(true);
    expect(resumed.getOfflineEfficiency()).toBeCloseTo(0.5, 12);
  });

  it("applies the active streak reward to every production resource", () => {
    const before = new CivilizationState(emptyResourceAmounts(), {
      ...emptyWorkerAssignments(),
      food: ExpNumber.ONE,
    });
    const after = new CivilizationState(
      emptyResourceAmounts(),
      { ...emptyWorkerAssignments(), food: ExpNumber.ONE },
      { townHall: 1 },
      emptyResourceFactors(),
      {},
      0,
      [],
      [],
      [],
      ["active24h"],
      { ...emptyStatistics(), longestActiveMs: 86_400_000 },
    );
    const baseRate = before.getProductionRates().food!;
    const boostedRate = after.getProductionRates().food!;
    expect(after.isAchievementEarned("active24h")).toBe(true);
    expect(boostedRate.toNumber()).toBeCloseTo(baseRate.toNumber() * 1.1, 10);
  });

  it("adds to an existing amount instead of replacing it", () => {
    const state = new CivilizationState({
      ...emptyResourceAmounts(),
      food: ExpNumber.fromNumber(250),
    });
    const credited = state.applyOfflineGain({
      food: ExpNumber.fromNumber(750),
    });
    expect(credited.resources.food.toNumber()).toBe(1000);
  });

  it("returns the same state when there is nothing to credit", () => {
    const state = sampleState();
    expect(state.applyOfflineGain({})).toBe(state);
    expect(state.applyOfflineGain({ food: ExpNumber.ZERO })).toBe(state);
  });

  it("reports the live rates it pays against", () => {
    const state = sampleState().assignWorker("wood", 2);
    const liveRates = state.getProductionRates();
    expect(liveRates.wood?.gt(ExpNumber.ZERO)).toBe(true);
    expect(Object.keys(liveRates)).toContain("food");
  });

  it("matches the shared cross-language test vectors", () => {
    for (const testCase of offlineGainVectors.cases) {
      const gain = calculateOfflineGain(
        Object.fromEntries(
          Object.entries(testCase.rates).map(([key, value]) => [
            key,
            ExpNumber.from(value),
          ]),
        ),
        testCase.elapsedMs,
        Number(offlineGainVectors.efficiency),
      );
      expect(Object.keys(gain)).toEqual(Object.keys(testCase.expected));
      for (const [key, expected] of Object.entries(testCase.expected)) {
        const actualNumber = gain[key].toNumber();
        const expectedNumber = ExpNumber.from(expected).toNumber();
        const scale = Math.max(1, Math.abs(expectedNumber));
        expect(Math.abs(actualNumber - expectedNumber) / scale).toBeLessThan(
          1e-12,
        );
      }
    }
  });
});

describe("content guid coverage", () => {
  it("resolves every id a save can name, in both directions", () => {
    const data = createSaveData(sampleState(), "coverage", 1);
    const named = [
      ...data.boughtUpgrades,
      ...data.defeatedEncounters,
      ...data.enteredAges,
      ...data.earnedAchievements,
      ...Object.keys(data.unitCounts),
    ];
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) {
      const guid = entryGuidById.get(id);
      expect(guid, `${id} has no static guid`).toBeDefined();
      expect(entryIdByGuid.get(guid!)).toBe(id);
    }
    expect(Object.keys(data.referencedGuids).length).toBeGreaterThanOrEqual(
      named.length,
    );
  });
});
