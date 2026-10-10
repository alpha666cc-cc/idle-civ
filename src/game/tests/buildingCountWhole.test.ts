import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "../attributes";
import { buildingDefinitions } from "../buildings";
import { CivilizationState } from "../civilizationState";
import { ExpNumber } from "../expNumber";
import { emptyStatistics } from "../statistics";

/** A settlement that can afford anything, with the given buildings standing. */
const stateWith = (built: Record<string, number> = {}): CivilizationState =>
  new CivilizationState(
    {
      ...emptyResourceAmounts(),
      food: ExpNumber.fromNumber(1e12),
      wood: ExpNumber.fromNumber(1e12),
      stone: ExpNumber.fromNumber(1e12),
      gold: ExpNumber.fromNumber(1e12),
    },
    emptyWorkerAssignments(),
    built,
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
  );

/**
 * A building count is a whole number, always.
 *
 * The bug: a capacity is stored as an `ExpNumber`, and re-reading one through
 * `toNumber()` re-rounds the mantissa, landing a few ULP above the integer
 * (4.4e2 -> 440.00000000000006). That residue became the "headroom" against an
 * equally-full count, so buy-MAX answered `5.68e-14` markets and the build card
 * offered a fraction of a building. `autoBuyBuildings()` then fed that fraction
 * straight into `build()`, which wrote it into the count and persisted it.
 */
describe("building counts stay whole numbers", () => {
  it("reports no headroom when a building is exactly at capacity", () => {
    // 440 is the residue case: capacity 4.4e2 re-reads as 440.00000000000006.
    for (const count of [440, 100, 110]) {
      // Raise the base capacity by exactly the shortfall, so count == capacity.
      const state = stateWith({ farm: count }).upgradeBuildingLimit(
        "farm",
        count - 10,
      );
      expect(state.getMaxAffordableBuildings("farm")).toBe(0);
      expect(state.isBuildingAtCapacity("farm")).toBe(true);
    }
  });

  it("never returns a fractional MAX for any building", () => {
    const state = stateWith({ farm: 440 }).upgradeBuildingLimit("farm", 430);
    for (const building of buildingDefinitions) {
      expect(
        Number.isInteger(state.getMaxAffordableBuildings(building.key)),
      ).toBe(true);
    }
  });

  it("refuses a fractional purchase instead of writing it to the count", () => {
    const state = stateWith({ farm: 5 });
    // The shape the bug produced: 440.00000000000006 - 440, the float residue
    // between a full count and a full capacity. It must not be written into the
    // count as 5.0000000000000001.
    const residue = ExpNumber.fromNumber(440).toNumber() - 440;
    const after = state.build("farm", residue);
    expect(after).toBe(state);
    expect(after.getBuildingCount("farm")).toBe(5);
  });

  it("floors a fractional purchase to the whole units asked for", () => {
    const state = stateWith({ farm: 5 });
    const after = state.build("farm", 3.9);
    expect(after.getBuildingCount("farm")).toBe(8);
  });

  it("keeps the count whole through an auto-buy pass", () => {
    // autoBuyBuildings() feeds getMaxAffordableBuildings() straight into build(),
    // which is how the original residue reached the saved count.
    const state = stateWith({ farm: 440 }).upgradeBuildingLimit("farm", 430);
    const after = state.autoBuyBuildings();
    expect(after.getBuildingCount("farm")).toBe(440);
    expect(Number.isInteger(after.getBuildingCount("farm"))).toBe(true);
  });

  it("gates on whole slots when a purchase would exceed capacity", () => {
    const state = stateWith({ farm: 440 }).upgradeBuildingLimit("farm", 430);
    expect(state.getBuildFailureReason("farm", 1)).toBe("capacity");
    expect(state.getBuildFailureReason("farm", 0)).toBeNull();
  });
});

/**
 * A unit count is a whole number, always — the unit-side twin of the suite above.
 *
 * The same bug existed on units and was not caught: `build()` floored its count
 * but `buyUnit()` did not, so a fractional count could be written straight into
 * `unitCounts`. Nothing downstream rounds it back: `getUnitCount` would report
 * 4.7 warriors, `getArmyPower` would charge a fraction of a soldier's strength,
 * and a battle plan's shortfall could never be fully recruited.
 */
describe("unit counts stay whole numbers", () => {
  const richState = (): CivilizationState =>
    new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e12),
        military: ExpNumber.fromNumber(1e12),
      },
      emptyWorkerAssignments(),
      { townHall: 1 },
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
    );

  it("floors a fractional purchase to the whole recruits asked for", () => {
    const after = richState().buyUnit("warrior", 3.9);
    expect(after.getUnitCount("warrior").toNumber()).toBe(3);
  });

  it("refuses a float residue instead of recruiting out of dust", () => {
    // The shape the building bug produced: a capacity re-read a few ULP high, and
    // the headroom between it and the count arrived here as 5.68e-14. It must buy
    // nothing rather than round up to a single warrior.
    const residue = ExpNumber.fromNumber(440).toNumber() - 440;
    const state = richState();
    const after = state.buyUnit("warrior", residue);
    expect(after).toBe(state);
    expect(after.getUnitCount("warrior").toNumber()).toBe(0);
  });

  it("never writes a non-integer into the owned count", () => {
    let state = richState();
    for (const count of [1, 2.5, 0.4, 7, 3.999999]) {
      state = state.buyUnit("warrior", count);
      expect(Number.isInteger(state.getUnitCount("warrior").toNumber())).toBe(true);
    }
  });

  it("treats a fractional purchase exactly as its floor", () => {
    const state = richState();
    // 1.6 floors to 1, so it must be indistinguishable from asking for one: the
    // same count, and the same half-dozen-odd points of power for that soldier.
    const fractional = state.buyUnit("warrior", 1.6);
    const whole = state.buyUnit("warrior", 1);
    expect(fractional.getUnitCount("warrior").toNumber()).toBe(1);
    expect(fractional.getUnitCount("warrior").toNumber()).toBe(
      whole.getUnitCount("warrior").toNumber(),
    );
    expect(fractional.getArmyPower().toString()).toBe(
      whole.getArmyPower().toString(),
    );
  });

  it("gates buy-MAX and affordability on whole recruits", () => {
    const state = richState();
    expect(Number.isInteger(state.getMaxAffordableUnits("warrior"))).toBe(true);
    // A cost check for a fraction must agree with the check for its floor, since
    // the fraction is never purchasable as written.
    for (const count of [0, 0.5, 1.5]) {
      const whole = Math.floor(count);
      expect(state.hasResourcesForUnit("warrior", count)).toBe(
        state.hasResourcesForUnit("warrior", whole),
      );
    }
  });

  /** Same settlement, but recruiting is free — lets a test reach a large count. */
  const freeRecruitState = (): CivilizationState =>
    new CivilizationState(
      {
        ...emptyResourceAmounts(),
        food: ExpNumber.fromNumber(1e12),
        military: ExpNumber.fromNumber(1e12),
      },
      emptyWorkerAssignments(),
      { townHall: 1 },
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
      true,
      false,
      [],
    );

  it("snaps the accumulated count back onto the integer lattice", () => {
    // `ExpNumber.add` drifts: adding one recruit to 1219 is evaluated as
    // `1.219 + 1/1000`, which is 1.2199999999999998 rather than 1.22, so a count
    // built up one recruit at a time arrives just under its true value. Real
    // measured example: 1219 slingers stored as 1218.999999999962.
    let state = freeRecruitState();
    for (let i = 0; i < 1300; i += 1) state = state.buyUnit("warrior", 1);
    const stored = state.getUnitCount("warrior").toNumber();
    expect(Number.isInteger(stored)).toBe(true);
    expect(stored).toBe(1300);
  });

  it("keeps a large accumulated count integral too", () => {
    // The tolerance is relative, so drift at a large magnitude is still caught —
    // a fixed absolute epsilon would be meaningless at 1e9.
    let state = freeRecruitState();
    for (let i = 0; i < 200; i += 1) state = state.buyUnit("warrior", 5000);
    const stored = state.getUnitCount("warrior").toNumber();
    expect(Number.isInteger(stored)).toBe(true);
    expect(stored).toBe(1_000_000);
  });
});
