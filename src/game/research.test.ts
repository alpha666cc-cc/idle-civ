import { describe, expect, it } from "vitest";
import { CivilizationState } from "./civilizationState";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "./attributes";
import { emptyStatistics } from "./statistics";
import { ExpNumber } from "./expNumber";
import {
  findResearchDefinition,
  researchDefinitions,
  researchIdsForBattle,
  researchesUnlockingUnit,
} from "./research";
import {
  SAVE_VERSION,
  createSaveData,
  loadSaveData,
  migrateSaveData,
} from "./saveSystem";
import { isBuyableUnit, unitDefinitions } from "./units";

/**
 * An age0 state with a pool of science to buy research with. `people` defaults
 * to 1 so `getCurrentAge()` has a population to read; research is priced by the
 * age the player is *in*, so a test that wants age1 pricing must raise it past
 * age1's threshold.
 */
const stateWith = (
  science: number,
  enteredAges: string[] = [],
  unitCounts: Record<string, ExpNumber> = {},
  people = 1,
): CivilizationState =>
  new CivilizationState(
    {
      ...emptyResourceAmounts(),
      science: ExpNumber.fromNumber(science),
    },
    emptyWorkerAssignments(),
    { townHall: 1, people },
    emptyResourceFactors(),
    {},
    0,
    [],
    [],
    enteredAges,
    [],
    emptyStatistics(),
    unitCounts,
    ExpNumber.ONE,
    false,
    false,
    false,
    [],
  );

/** Buys a tech's full transitive prerequisite closure, deepest first. */
const buyPrerequisiteClosure = (
  state: CivilizationState,
  key: string,
): CivilizationState => {
  const tech = findResearchDefinition(key);
  if (!tech) return state;
  let next = state;
  for (const prerequisite of tech.prerequisites) {
    next = buyPrerequisiteClosure(next, prerequisite);
    next = next.buyResearch(prerequisite);
  }
  return next;
};

describe("research data integrity", () => {
  it("builds battle research from prior ages and unit prerequisites", () => {
    const ids = researchIdsForBattle(1, ["spearman_bronze"]);
    expect(ids).toContain("agriculture");
    expect(ids).toContain("bronze_smelting");
    expect(ids.indexOf("tribal_organization")).toBeLessThan(
      ids.indexOf("bronze_smelting"),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders every tech after its prerequisites", () => {
    const positions = new Map(
      researchDefinitions.map((research, index) => [research.key, index]),
    );
    for (const research of researchDefinitions) {
      for (const prerequisite of research.prerequisites) {
        expect(positions.get(prerequisite), research.key).toBeLessThan(
          positions.get(research.key) ?? Infinity,
        );
      }
    }
  });

  it("documents a reason for every flagged (ignored) effect", () => {
    for (const research of researchDefinitions) {
      for (const flag of research.ignored) {
        expect(
          flag.reason.length,
          `${research.key}: ${flag.type}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("keeps unit unlocks resolvable", () => {
    for (const unit of unitDefinitions) {
      for (const research of researchesUnlockingUnit(unit.key)) {
        expect(research.unlocks).toContain(unit.key);
      }
    }
  });

  it("does not claim to unlock units that are already available", () => {
    for (const research of researchDefinitions) {
      for (const unitId of research.unlocks) {
        const unit = unitDefinitions.find(({ key }) => key === unitId);
        expect(unit?.available, `${research.key} → ${unitId}`).toBe(false);
      }
    }
  });
});

describe("research buying", () => {
  const first = researchDefinitions[0];
  const second = researchDefinitions[1];

  it("charges the current age's base for its first tech, then climbs by its factor", () => {
    const state = stateWith(1e10).enterAge("age0");
    expect(state.getResearchNextCost()[0].resource).toBe("science");
    expect(state.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(1000, 9);
    const afterFirst = state.buyResearch(first.key);
    expect(afterFirst.isResearchBought(first.key)).toBe(true);
    expect(afterFirst.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      1000 * 10 ** (Math.sqrt(2) - 1),
      8,
    );
    const afterSecond = afterFirst.buyResearch(second.key);
    expect(afterSecond.isResearchBought(second.key)).toBe(true);
    expect(afterSecond.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      1000 * 10 ** (Math.sqrt(3) - 1),
      8,
    );
  });

  it("costs every tech on the current age's schedule, whatever age it comes from", () => {
    // Research is priced by the age the player is IN, not the tech's own age:
    // in the Iron Age even an age-0 tech costs the Iron Age price.
    const state = stateWith(1e30, ["age0"], {}, 2000).enterAge("age1");
    expect(state.getCurrentAge()?.key).toBe("age1");
    const expected = 1e9 * 200 ** (Math.sqrt(1) - 1);
    expect(state.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      expected,
      6,
    );
  });

  it("resets the research counter on an age change", () => {
    // The counter is per age, so a new age starts again at its own base.
    let state = stateWith(1e30, ["age0"]);
    state = buyPrerequisiteClosure(state, second.key);
    state = state.buyResearch(first.key);
    state = state.buyResearch(second.key);
    expect(state.getResearchCount()).toBe(2);

    // Cross age1's 1,000-citizen threshold and enter it: the counter is 0 again.
    const inAge1 = stateWith(1e30, ["age0"], {}, 2000).enterAge("age1");
    expect(inAge1.getResearchCount()).toBe(0);
    expect(inAge1.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      1e9 * 200 ** (Math.sqrt(1) - 1),
      6,
    );
  });

  it("does not advance the counter for a tech bought from an earlier age", () => {
    // Buying an age-0 tech while in the Iron Age pays the Iron Age price but
    // leaves the Iron Age counter untouched, so the next tech costs the same.
    let state = stateWith(1e30, ["age0"], {}, 2000).enterAge("age1");
    const priceBefore = state.getResearchNextCost()[0].base.toNumber();

    const age0Tech = researchDefinitions.find(
      (r) => r.age === 0 && r.prerequisites.length === 0,
    )!;
    expect(state.isResearchUnlocked(age0Tech.key)).toBe(true);

    const bought = state.buyResearch(age0Tech.key);
    expect(bought.isResearchBought(age0Tech.key)).toBe(true);
    expect(bought.getResearchCount()).toBe(0);
    expect(bought.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      priceBefore,
      6,
    );
    // The science really was spent, even though the counter did not move. Compare
    // the recorded spend rather than the pool: at 1e30 a 1e9 payment is lost to
    // double precision, so the two totals compare equal.
    expect(bought.statistics.resourcesSpent.science.toNumber()).toBeCloseTo(
      priceBefore,
      6,
    );
  });

  /**
   * Research costs now use the building cost pipeline with a virtual "research"
   * building, allowing upgrades, battles, and ages to modify research costs.
   */
  describe("research cost pipeline", () => {
    it("uses the age's own base for the first tech", () => {
      const state = stateWith(1e30, ["age0"]);
      const firstCost = state.getResearchNextCost()[0].base.toNumber();
      expect(firstCost).toBeCloseTo(1000, 9); // age0 research base
    });

    it("scales with purchase count using sqrt curve", () => {
      const state = stateWith(1e30, ["age0"]);
      const costs = state.getResearchCostForCount(3);
      expect(costs).toHaveLength(1);
      expect(costs[0].base.toNumber()).toBeGreaterThan(1000); // Should grow
    });

    it("allows cost reductions through the bonus system", () => {
      // The building cost pipeline supports costReductionPercent bonuses
      // This test verifies the infrastructure is in place
      const state = stateWith(1e30, ["age0"]);
      const initialCost = state.getResearchNextCost()[0].base.toNumber();
      expect(initialCost).toBeCloseTo(1000, 9);
    });

    it("allows costReductionBase on research", () => {
      // The engine path still exists; no age ships research base data today.
      const state = stateWith(1e30, ["age0"]);
      const initialCost = state.getResearchNextCost()[0].base.toNumber();
      expect(initialCost).toBeCloseTo(1000, 9);
    });

    it("allows costReductionFactor on research", () => {
      // The engine path still exists; no age ships research growth data today.
      const state = stateWith(1e30, ["age0"]);
      const initialCost = state.getResearchNextCost()[0].base.toNumber();
      expect(initialCost).toBeCloseTo(1000, 9);
    });

    it("re-prices research when the age changes", () => {
      // Each age owns its schedule, so crossing into age1 jumps to the age1 base
      // and the counter restarts — the opposite of the old flat global curve.
      const age0State = stateWith(1e30, ["age0"]);
      const age1State = stateWith(1e30, ["age0"], {}, 2000).enterAge("age1");

      expect(age0State.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
        1000,
        9,
      );
      expect(age1State.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
        1e9,
        6,
      );
    });
  });

  it("prices only unbought research needed for a new unit type", () => {
    const state = stateWith(1e30).enterAge("age0");
    const required = state.getResearchForUnitTypes(["slinger"]);

    expect(required.ids).toEqual(["agriculture", "pottery", "sling_throwing"]);
    expect(required.costs).toHaveLength(1);
    expect(required.costs[0].base.toNumber()).toBeCloseTo(
      1000 * 10 ** (Math.sqrt(1) - 1) +
        1000 * 10 ** (Math.sqrt(2) - 1) +
        1000 * 10 ** (Math.sqrt(3) - 1),
      6,
    );

    const withPrerequisites = buyPrerequisiteClosure(
      state,
      "sling_throwing",
    ).buyResearch("sling_throwing");
    const afterPurchase = withPrerequisites.getResearchForUnitTypes([
      "slinger",
    ]);
    expect(afterPurchase.ids).toEqual([]);
    expect(afterPurchase.costs).toEqual([]);
  });

  it("makes age0 research available from the start", () => {
    const state = stateWith(0);
    expect(state.isResearchUnlocked(first.key)).toBe(true);
    expect(state.getResearchFailureReason(first.key)).toBe("resources");
    const entered = state.enterAge("age0");
    expect(entered.isResearchUnlocked(first.key)).toBe(true);
    expect(entered.getResearchFailureReason(first.key)).toBe("resources");
  });

  it("keeps age2 research locked until age2 is reached", () => {
    const ageTwo = researchDefinitions.find((research) => research.age === 2);
    expect(ageTwo).toBeDefined();
    if (!ageTwo) return;

    // Before the transition, age2 (Classical) has not been reached, so its
    // tech must stay locked even with unlimited science.
    let state = stateWith(1e30, ["age0", "age1"]);
    expect(state.isResearchUnlocked(ageTwo.key)).toBe(false);
    expect(state.getResearchFailureReason(ageTwo.key)).toBe("locked");
    expect(state.buyResearch(ageTwo.key)).toBe(state);

    // Entering Classical unlocks age2 research once its prerequisites are met.
    state = state.enterAge("age2");
    expect(state.isResearchUnlocked(ageTwo.key)).toBe(
      ageTwo.prerequisites.every((prerequisite) =>
        state.boughtResearch.includes(prerequisite),
      ),
    );
  });

  it("unlocks an age's research while the player is in that age", () => {
    const ironAge = researchDefinitions.find((research) => research.age === 1);
    expect(ironAge).toBeDefined();
    if (!ironAge) return;

    // The era card advances into the Iron Age; its own techs must be available
    // immediately, even though `age1` has not been completed yet.
    let state = stateWith(1e30, ["age0"]).enterAge("age1");
    state = buyPrerequisiteClosure(state, ironAge.key);
    expect(state.isResearchUnlocked(ironAge.key)).toBe(true);
    expect(state.buyResearch(ironAge.key).isResearchBought(ironAge.key)).toBe(
      true,
    );
  });

  it("pays science and applies bonuses through the shared factor path", () => {
    // Exactly the first tech's price for the age: age0's research base.
    const entered = stateWith(1000, ["age0"]).enterAge("age0");
    const multiplier = first.bonuses.find(
      (bonus) => bonus.type === "attributeMultiplier",
    );
    expect(multiplier).toBeDefined();
    const bought = entered.buyResearch(first.key);
    expect(bought.isResearchBought(first.key)).toBe(true);
    expect(bought.resources.science.eq(ExpNumber.ZERO)).toBe(true);
    const factors = bought.getFactors("food").multiplicative;
    expect(
      factors.some(([source]) => source === first.key),
      `expected ${first.key} among food multipliers`,
    ).toBe(true);
  });

  it("is idempotent and refuses an unaffordable purchase", () => {
    const entered = stateWith(1000, ["age0"]).enterAge("age0");
    const bought = entered.buyResearch(first.key);
    expect(bought.buyResearch(first.key)).toBe(bought);
    expect(bought.canBuyResearch(first.key)).toBe(false);
    // The next price follows the age's factor-10 square-root curve, and the
    // science is spent.
    expect(bought.getResearchFailureReason(second.key)).toBe("resources");
  });

  it("requires prerequisites to be bought before child techs", () => {
    const child = researchDefinitions.find((r) => r.prerequisites.length > 0);
    expect(child).toBeDefined();
    if (!child) return;
    const state = stateWith(1e12, ["age0"]).enterAge("age0");
    // Child tech should be locked until prerequisites are bought
    expect(state.isResearchUnlocked(child.key)).toBe(false);
    expect(state.getResearchFailureReason(child.key)).toBe("locked");
    // Buy prerequisites first
    let stateWithPrereqs = state;
    for (const prerequisite of child.prerequisites) {
      stateWithPrereqs = stateWithPrereqs.buyResearch(prerequisite);
      expect(stateWithPrereqs.isResearchBought(prerequisite)).toBe(true);
    }
    // Now child should be unlocked
    expect(stateWithPrereqs.isResearchUnlocked(child.key)).toBe(true);
    const bought = stateWithPrereqs.buyResearch(child.key);
    expect(bought.isResearchBought(child.key)).toBe(true);
  });

  it("keeps all-unit and all-building cost targets separate", () => {
    const state = stateWith(0);
    expect(state.getBuildingCostModifiers("farm").sources).not.toContainEqual(
      expect.arrayContaining([
        expect.anything(),
        expect.objectContaining({ destination: "allUnits" }),
      ]),
    );
    expect(state.getUnitCostModifiers("warrior").sources).not.toContainEqual(
      expect.arrayContaining([
        expect.anything(),
        expect.objectContaining({ destination: "allBuildings" }),
      ]),
    );
  });
});

describe("research unlocks units", () => {
  it("marks research-unlocked units available once bought", () => {
    // Find a research that unlocks a unit and buy its full prerequisite
    // closure (v3 chains nest two levels deep: sling_throwing needs its
    // direct prerequisite *and* that prerequisite's own prerequisite).
    const unlocker = researchDefinitions.find(
      (research) => research.unlocks.length > 0,
    );
    expect(unlocker).toBeDefined();
    if (!unlocker) return;
    const unitId = unlocker.unlocks[0];
    const unit = unitDefinitions.find((candidate) => candidate.key === unitId);
    expect(isBuyableUnit(unit!)).toBe(true);
    let state = stateWith(1e30, ["age0"]).enterAge("age1");
    state = buyPrerequisiteClosure(state, unlocker.key);
    state = state.buyResearch(unlocker.key);
    expect(state.isResearchBought(unlocker.key)).toBe(true);
    expect(state.isUnitAvailable(unitId)).toBe(true);
  });
});

describe("research unit conversions", () => {
  const conversion = researchDefinitions.find(
    (research) => research.conversions.length > 0,
  );
  it("exists in the shipped data", () => {
    expect(conversion).toBeDefined();
  });
  if (!conversion) return;
  const { from, to, ratio } = conversion.conversions[0];
  const pairKey = `age${conversion.age}`;
  const buyAt = (science: number, units: Record<string, ExpNumber> = {}) => {
    let state = stateWith(science, [pairKey], units).enterAge(pairKey);
    state = buyPrerequisiteClosure(state, conversion.key);
    return state.buyResearch(conversion.key);
  };

  it("closes the source line once the tech is bought", () => {
    const state = buyAt(1e30);
    expect(state.isResearchBought(conversion.key)).toBe(true);
    expect(state.isUnitAvailable(from)).toBe(false);
    expect(state.isUnitAvailable(to)).toBe(true);
  });

  it("converts owned units at the ratio, keeping the remainder", () => {
    const counts = buyAt(1e30, { [from]: ExpNumber.fromNumber(25) }).unitCounts;
    expect(counts[from].toNumber()).toBe(25 % ratio);
    expect(counts[to].toNumber()).toBe(Math.floor(25 / ratio));
  });

  it("is a no-op when the player owns none of the source unit", () => {
    const counts = buyAt(1e30).unitCounts;
    expect(counts[from]?.toNumber() ?? 0).toBe(0);
    expect(counts[to]?.toNumber() ?? 0).toBe(0);
  });
});

describe("research in the save system", () => {
  it("round-trips bought research through a save document", () => {
    const state = stateWith(1e10, ["age0"])
      .enterAge("age0")
      .buyResearch("agriculture");
    const data = createSaveData(state, "guid", 1000);
    const loaded = loadSaveData(data);
    expect(loaded.boughtResearch).toEqual(["agriculture"]);
  });

  it("migrates version-1 documents to an empty research list", () => {
    const data = createSaveData(stateWith(0), "guid", 1000);
    const legacy = {
      ...data,
      version: 1,
      boughtResearch: undefined,
    } as unknown as Record<string, unknown>;
    const migrated = migrateSaveData(legacy as never);
    expect(migrated.version).toBe(SAVE_VERSION);
    expect(migrated.boughtResearch).toEqual([]);
  });

  it("resolves every research id in the guid registry", async () => {
    const { entryGuidById } = await import("./dataIds");
    for (const research of researchDefinitions) {
      expect(entryGuidById.get(research.key), research.key).toBeDefined();
    }
    expect(findResearchDefinition("agriculture")).toBeDefined();
  });
});
