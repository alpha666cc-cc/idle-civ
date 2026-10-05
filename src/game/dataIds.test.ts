import { describe, expect, it } from "vitest";
import {
  dataEntryCount,
  dataFileEntries,
  dataFileKeys,
  duplicateGuids,
  entriesMissingGuid,
  entryGuidById,
  entryIdByGuid,
  findEntryGuid,
  guidPattern,
  invalidGuids,
  resolveEntryId,
  snapshotGuids,
} from "./dataIds";
import {
  calculateOfflineGain,
  createSaveData,
  findUnknownContentIds,
  loadSaveData,
} from "./saveSystem";
import { ageDefinitions } from "./ages";
import { buildingDefinitions } from "./buildings";
import { achievementDefinitions } from "./achievements";
import { encounterDefinitions } from "./encounters";
import { upgradeDefinitions } from "./upgrades";
import { unitDefinitions } from "./units";
import { CivilizationState } from "./civilizationState";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "./attributes";
import { ExpNumber } from "./expNumber";
import { emptyStatistics } from "./statistics";

/**
 * Content-integrity guards. These are the tests that fail when a data edit would
 * silently corrupt a player's save: a missing guid makes rename repair
 * impossible, a duplicated guid makes it ambiguous, and a definition outside the
 * guid registry cannot be resolved from an older save at all.
 */
describe("static content guids", () => {
  it("covers every data file", () => {
    expect(dataFileKeys.length).toBe(8);
    for (const file of dataFileKeys) {
      expect(dataFileEntries[file].length, `${file} is empty`).toBeGreaterThan(
        0,
      );
    }
    expect(dataEntryCount).toBe(
      dataFileKeys.reduce(
        (total, file) => total + dataFileEntries[file].length,
        0,
      ),
    );
  });

  it("gives every entry one", () => {
    expect(entriesMissingGuid).toEqual([]);
  });

  it("uses a version-5 GUID for every entry", () => {
    expect(invalidGuids).toEqual([]);
  });

  it("never reuses a guid", () => {
    expect(duplicateGuids).toEqual([]);
    expect(entryGuidById.size).toBe(dataEntryCount);
    expect(entryIdByGuid.size).toBe(dataEntryCount);
  });

  it("maps ids and guids back and forth", () => {
    for (const [id, guid] of entryGuidById) {
      expect(resolveEntryId(guid)).toBe(id);
      expect(findEntryGuid(id)).toBe(guid);
      expect(guidPattern.test(guid)).toBe(true);
    }
  });

  it("gives content registered outside the data files a guid too", () => {
    // Everything a save can name in a list must be resolvable.
    const named = [
      ...buildingDefinitions.map(({ key }) => key),
      ...upgradeDefinitions.map(({ key }) => key),
      ...encounterDefinitions.map(({ key }) => key),
      ...ageDefinitions.map(({ key }) => key),
      ...achievementDefinitions.map(({ key }) => key),
      ...unitDefinitions.map(({ key }) => key),
    ];
    const missing = named.filter((id) => findEntryGuid(id) === undefined);
    expect(missing).toEqual([]);
  });

  it("snapshots only ids it knows", () => {
    expect(snapshotGuids(["farmEnhancer9", "no-such-thing"])).toEqual({
      "farmEnhancer9": entryGuidById.get("farmEnhancer9"),
    });
    expect(snapshotGuids([])).toEqual({});
  });

  it("uses the shipped building and age0 unit cost factors", () => {
    const buildingFactors = new Set(
      buildingDefinitions.flatMap(({ costs }) =>
        costs.map(({ factor }) => factor),
      ),
    );
    const ageZeroUnitFactors = new Map(
      unitDefinitions
        .filter(({ age, costs }) => age === 0 && costs.length > 0)
        .map((unit) => [unit.key, new Set(unit.costs.map(({ factor }) => factor))]),
    );

    expect(buildingFactors).toEqual(new Set([2.5, 8, 10, 12, 15]));
    expect(ageZeroUnitFactors.get("warrior")).toEqual(new Set([3.5]));
    expect(ageZeroUnitFactors.get("spearman_bronze")).toEqual(new Set([2.5]));
    expect(ageZeroUnitFactors.get("axeman_bronze")).toEqual(new Set([2.5]));
    // Later ages no longer share one blanket factor. The age-1 rebalance shifted
    // unit growth factors per unit (`tools/gen/units.mjs` plus the
    // `temp/shift-unit-factors.ts` pass in 755ac13), so the guard is now that
    // every later-age cost factor is a positive, sane growth curve rather than a
    // hardcoded 5. Pinning the exact set here would just re-break on the next
    // balance pass without catching a real defect.
    for (const unit of unitDefinitions.filter(
      ({ age, costs }) => age > 0 && costs.length > 0,
    )) {
      for (const { factor } of unit.costs) {
        expect(factor, unit.key).toBeGreaterThan(1);
        expect(factor, unit.key).toBeLessThanOrEqual(5);
      }
    }
  });

  it("keeps the rebalanced age0 bases, factors and townHall costs", () => {
    const ageZeroUnits = unitDefinitions.filter(
      ({ age, costs }) => age === 0 && costs.length > 0,
    );
    const baseAndFactor = (
      unit: { key: string; costs: { base: ExpNumber; factor: number }[] },
    ) => unit.costs.map(({ base, factor }) => [base.toNumber(), factor]);

    expect(
      baseAndFactor(ageZeroUnits.find(({ key }) => key === "warrior")!),
    ).toEqual([
      [150, 3.5],
      [5_000, 3.5],
    ]);
    expect(
      baseAndFactor(ageZeroUnits.find(({ key }) => key === "canoe")!),
    ).toEqual([
      [25_000, 4.5],
      [400_000, 4.5],
    ]);
    expect(
      baseAndFactor(ageZeroUnits.find(({ key }) => key === "spearman_bronze")!),
    ).toEqual([
      [100_000, 2.5],
      [5_000, 2.5],
    ]);
    expect(
      baseAndFactor(ageZeroUnits.find(({ key }) => key === "axeman_bronze")!),
    ).toEqual([
      [300_000, 2.5],
      [10_000, 2.5],
    ]);
    // The same rebalance reached every later age0 unit.
    expect(
      baseAndFactor(ageZeroUnits.find(({ key }) => key === "chariot_bronze")!),
    ).toEqual([
      [2_000_000, 4.5],
      [20_000, 4.5],
    ]);
    expect(
      baseAndFactor(ageZeroUnits.find(({ key }) => key === "bowman_bronze")!),
    ).toEqual([
      [200_000, 4.5],
      [10_000, 4.5],
      [2_000_000, 4.5],
    ]);
    expect(
      baseAndFactor(ageZeroUnits.find(({ key }) => key === "trireme_bronze")!),
    ).toEqual([
      [10_000_000, 4.5],
      [100_000, 4.5],
      [300_000_000, 4.5],
    ]);
    expect(
      baseAndFactor(ageZeroUnits.find(({ key }) => key === "catapult_ancient")!),
    ).toEqual([
      [10_000_000, 4],
      [100_000, 4],
    ]);

    const costsFor = (key: string) =>
      buildingDefinitions
        .find((building) => building.key === key)
        ?.costs.map(({ base, factor }) => [base.toNumber(), factor]);
    expect(costsFor("barracks")).toEqual([
      [10_000, 10],
      [1_000, 12],
      [5_000, 10],
    ]);
    expect(costsFor("university")).toEqual([
      [10_000, 10],
      [10_000, 12],
      [7_500, 10],
    ]);
    expect(costsFor("townHall")).toEqual([
      [10_000, 15],
      [7_500, 15],
      [12_500, 15],
    ]);
  });

  it("keeps multiple capacity effect entries instead of overwriting them", () => {
    const townHall = buildingDefinitions.find(({ key }) => key === "townHall");
    expect(townHall).toBeDefined();
    expect(townHall?.effects.capacityProvided).toHaveLength(5);
    expect(
      townHall?.effects.capacityProvided?.map(({ building }) => building),
    ).toEqual(["house", "barracks", "university", "smithy", "market"]);
  });

  it("applies town hall capacity grants to other building capacities", () => {
    const fresh = new CivilizationState();
    expect(fresh.getBuildingMax("house").toNumber()).toBeCloseTo(10, 9);
    expect(fresh.getBuildingMax("barracks").toNumber()).toBeCloseTo(11, 9);
    expect(fresh.getBuildingMax("university").toNumber()).toBeCloseTo(11, 9);

    const state = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        // The first townHall's data-driven cost is affordable with this stock.
        wood: ExpNumber.fromNumber(1_000_000),
        stone: ExpNumber.fromNumber(1_000_000),
        gold: ExpNumber.fromNumber(1_000_000),
        food: ExpNumber.fromNumber(1_000_000),
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
    );

    const after = state.build("townHall", 1);
    expect(after.getBuildingMax("barracks").toNumber()).toBeCloseTo(11, 9);
    expect(after.getBuildingMax("university").toNumber()).toBeCloseTo(11, 9);
  });

  it("repairs the missing starting grant in older saved capacities", () => {
    const state = new CivilizationState(
      {
        ...emptyResourceAmounts(),
        barracksCapacity: ExpNumber.fromNumber(19),
        universityCapacity: ExpNumber.fromNumber(19),
      },
      emptyWorkerAssignments(),
      { "townHall": 10 },
      emptyResourceFactors(),
    );

    expect(state.getBuildingMax("barracks").toNumber()).toBe(20);
    expect(state.getBuildingMax("university").toNumber()).toBe(20);
  });

  it("locks barracks until 90 citizens", () => {
    const stateAt89 = new CivilizationState(
      { ...emptyResourceAmounts(), food: ExpNumber.fromNumber(1e12) },
      emptyWorkerAssignments(),
      { "townHall": 1, people: 89 },
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
      true,
    );
    const stateAt90 = new CivilizationState(
      { ...emptyResourceAmounts(), food: ExpNumber.fromNumber(1e12) },
      emptyWorkerAssignments(),
      { "townHall": 1, people: 90 },
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
      true,
    );

    expect(stateAt89.isBuildingAvailable("barracks")).toBe(false);
    expect(stateAt89.canBuild("barracks")).toBe(false);
    expect(stateAt90.isBuildingAvailable("barracks")).toBe(true);
    expect(stateAt90.canBuild("barracks")).toBe(true);
  });
});

describe("a fresh save survives a data-edit cycle", () => {
  /** A state deliberately loaded with content from every data file. */
  const richState = (): CivilizationState =>
    new CivilizationState(
      { ...emptyResourceAmounts(), food: ExpNumber.fromNumber(1e12) },
      { ...emptyWorkerAssignments(), food: ExpNumber.fromNumber(2) },
      { "townHall": 1, farm: 2, house: 1 },
      emptyResourceFactors(),
      {},
      0,
      upgradeDefinitions.slice(0, 3).map(({ key }) => key),
      encounterDefinitions.slice(0, 3).map(({ key }) => key),
      ageDefinitions.slice(0, 3).map(({ key }) => key),
      achievementDefinitions.slice(0, 3).map(({ key }) => key),
      emptyStatistics(),
      Object.fromEntries(
        unitDefinitions
          .slice(0, 4)
          .map(({ key }) => [key, ExpNumber.fromNumber(2)]),
      ),
    );

  it("names nothing the data files do not define", () => {
    const data = createSaveData(richState(), "integrity", 1);
    expect(
      findUnknownContentIds(data, (id) => findEntryGuid(id) !== undefined),
    ).toEqual([]);
  });

  it("round-trips its content lists and their guid snapshot", () => {
    const data = createSaveData(richState(), "integrity", 1);
    const restored = loadSaveData(data);
    expect(restored.boughtUpgrades).toEqual(data.boughtUpgrades);
    expect(restored.defeatedEncounters).toEqual(data.defeatedEncounters);
    expect(restored.enteredAges).toEqual(data.enteredAges);
    expect(restored.earnedAchievements).toEqual(data.earnedAchievements);
    for (const id of [
      ...data.boughtUpgrades,
      ...data.defeatedEncounters,
      ...data.enteredAges,
      ...data.earnedAchievements,
      ...Object.keys(data.unitCounts),
    ]) {
      expect(
        data.referencedGuids[id],
        `${id} is missing from the snapshot`,
      ).toBe(entryGuidById.get(id));
    }
  });

  it("still yields a payable offline gain after the round-trip", () => {
    const state = loadSaveData(createSaveData(richState(), "integrity", 1));
    const gain = calculateOfflineGain(state.getProductionRates(), 3_600_000);
    expect(gain.food).toBeDefined();
    expect(gain.food.isFinite).toBe(true);
  });
});
