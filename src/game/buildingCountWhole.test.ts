import { describe, expect, it } from "vitest";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "./attributes";
import { buildingDefinitions } from "./buildings";
import { CivilizationState } from "./civilizationState";
import { ExpNumber } from "./expNumber";
import { emptyStatistics } from "./statistics";

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
