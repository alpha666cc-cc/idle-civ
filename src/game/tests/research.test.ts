import { describe, expect, it } from "vitest";
import { CivilizationState } from "../civilizationState";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "../attributes";
import { emptyStatistics } from "../statistics";
import { ExpNumber } from "../expNumber";
import { findAgeDefinition, ageDefinitions } from "../ages";
import { encounterDefinitions } from "../encounters";
import type { BuildingKey } from "../buildings";
import {
  findResearchDefinition,
  researchDefinitions,
  researchIdsForBattle,
  researchesUnlockingUnit,
} from "../research";
import {
  SAVE_VERSION,
  createSaveData,
  loadSaveData,
  migrateSaveData,
} from "../saveSystem";
import { isBuyableUnit, unitDefinitions } from "../units";
import { UpgradeDefinition, upgradeDefinitions } from "../upgrades";
import { parseBonus } from "../bonus";
import { formationDefinitions, type FormationId } from "../formations";

/**
 * An age0 state with a pool of science to buy research with. Research is priced
 * by the first age not yet completed, so age1 pricing needs age0 in enteredAges.
 */
const stateWith = (
  science: number,
  enteredAges: string[] = [],
  unitCounts: Record<string, ExpNumber> = {},
  people = 1,
  boughtUpgrades: string[] = [],
  defeatedEncounters: string[] = [],
  builtBuildings: Partial<Record<BuildingKey, number>> = {
    townHall: 1,
    people,
  },
): CivilizationState =>
  new CivilizationState(
    {
      ...emptyResourceAmounts(),
      science: ExpNumber.fromNumber(science),
    },
    emptyWorkerAssignments(),
    builtBuildings,
    emptyResourceFactors(),
    {},
    0,
    boughtUpgrades,
    defeatedEncounters,
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

describe("age progression", () => {
  const ageZeroBattles = encounterDefinitions
    .filter(({ age }) => age === 0)
    .map(({ key }) => key);

  it("keeps the current age ordered regardless of population", () => {
    expect(stateWith(0, [], {}, 1e12).getCurrentAge()?.key).toBe("age0");
    expect(stateWith(0, ["age0"], {}, 1).getCurrentAge()?.key).toBe("age1");
  });

  it("uses the age building threshold to gate completion", () => {
    const belowTarget = stateWith(0, [], {}, 1, [], ageZeroBattles, {
      townHall: 1499,
    });
    const atTarget = stateWith(0, [], {}, 1, [], ageZeroBattles, {
      townHall: 1500,
    });

    expect(belowTarget.getAgeBuildingProgress()).toEqual([1499, 1500]);
    expect(belowTarget.canEnterAge("age0")).toBe(false);
    expect(atTarget.canEnterAge("age0")).toBe(true);
  });

  it("zeros age-0 units when entering age 2 so they leave later armies", () => {
    const state = stateWith(
      0,
      ["age0"],
      { warrior: ExpNumber.fromNumber(8) },
    );

    const entered = state.enterAge("age1");

    expect(entered.unitCounts.warrior?.eq(ExpNumber.ZERO)).toBe(true);
    expect(entered.getArmyStacks().some(({ unitId }) => unitId === "warrior"))
      .toBe(false);
  });
});

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
  it("keeps every age's research exponent finite and positive", () => {
    for (const age of ageDefinitions) {
      expect(Number.isFinite(age.research.exponent), age.key).toBe(true);
      expect(age.research.exponent, `${age.key} research exponent`).toBeGreaterThan(
        0,
      );
    }
  });

  it("builds battle research from prior ages and unit prerequisites", () => {
    const ids = researchIdsForBattle(1, ["spearman_bronze"]);
    expect(ids).toContain("agriculture");
    expect(ids).toContain("bronze_smelting");
    expect(ids.indexOf("tribal_organization")).toBeLessThan(
      ids.indexOf("bronze_smelting"),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives boss enemies every current-age technology in addition to earlier techs and unlocks", () => {
    const ids = researchIdsForBattle(1, ["spearman_bronze"], true);
    expect(ids).toContain("agriculture");
    expect(ids).toContain("bronze_smelting");
    expect(ids).toContain("iron_working");
    expect(ids).toContain("iron_forging");
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

/** age0's live schedule, read from `ages.json` so a data rebalance of the factor
 *  cannot stale these expectations — the assertions are about the curve, not one
 *  particular factor value. */
const age0Schedule = findAgeDefinition("age0")!.research;
const age0Price = (n: number): number =>
  age0Schedule.base.toNumber() *
  age0Schedule.factor ** (n ** age0Schedule.exponent - 1);

/** The age1 first-tech price, also read from data. */
const age1FirstPrice = (): number => {
  const schedule = findAgeDefinition("age1")!.research;
  return (
    schedule.base.toNumber() * schedule.factor ** (1 ** schedule.exponent - 1)
  );
};

/**
 * An age0 state carrying one extra bought upgrade whose only bonus is the given
 * cost reduction, so a test can check which buyables it reaches. Registered on the
 * upgrade registry because `activeBonuses()` derives bonuses from bought upgrade
 * ids, so no state field can inject one directly. The definition is deliberately
 * NOT removed: `activeBonuses()` resolves ids lazily on every read, so popping it
 * would make the returned state inert.
 */
const buildCostState = (bonus: {
  type: string;
  destination: string;
  value: number;
}): CivilizationState => {
  // Unique per (type, destination, value): two calls with the same type but
  // different magnitudes must register distinct definitions, or the second would
  // silently reuse the first's bonus and the reduction would look inert.
  const key = `test-research-cost-${bonus.type}-${bonus.destination}-${bonus.value}`;
  if (!upgradeDefinitions.some((u) => u.id === key)) {
    upgradeDefinitions.push(
      new UpgradeDefinition(
        key,
        "Test research cost bonus",
        "",
        [],
        [parseBonus(bonus.type, bonus.destination, bonus.value)],
        { source: "buildingCount", building: "farm", threshold: 0 },
      ),
    );
  }
  return stateWith(1e30, [], {}, 1, [key]);
};

describe("research buying", () => {
  const first = researchDefinitions[0];
  const second = researchDefinitions[1];

  it("charges the current age's base for its first tech, then climbs by its factor", () => {
    const state = stateWith(1e10);
    expect(state.getResearchNextCost()[0].resource).toBe("science");
    expect(state.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      age0Schedule.base.toNumber(),
      9,
    );
    const afterFirst = state.buyResearch(first.key);
    expect(afterFirst.isResearchBought(first.key)).toBe(true);
    expect(afterFirst.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      age0Price(2),
      8,
    );
    const afterSecond = afterFirst.buyResearch(second.key);
    expect(afterSecond.isResearchBought(second.key)).toBe(true);
    expect(afterSecond.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      age0Price(3),
      8,
    );
  });

  it("costs every tech on the current age's schedule, whatever age it comes from", () => {
    // Research is priced by the age the player is IN, not the tech's own age:
    // in the Iron Age even an age-0 tech costs the Iron Age price.
    const state = stateWith(1e30, ["age0"]);
    expect(state.getCurrentAge()?.key).toBe("age1");
    expect(state.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      age1FirstPrice(),
      6,
    );
  });

  it("resets the research counter on an age change", () => {
    // The counter is per age, so a new age starts again at its own base.
    let state = stateWith(1e30);
    state = buyPrerequisiteClosure(state, second.key);
    state = state.buyResearch(first.key);
    state = state.buyResearch(second.key);
    expect(state.getResearchCount()).toBe(2);

    // Complete age0 and enter age1: the counter is 0 again.
    const inAge1 = stateWith(1e30, ["age0"]);
    expect(inAge1.getResearchCount()).toBe(0);
    expect(inAge1.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
      age1FirstPrice(),
      6,
    );
  });

  it("does not advance the counter for a tech bought from an earlier age", () => {
    // Buying an age-0 tech while in the Iron Age pays the Iron Age price but
    // leaves the Iron Age counter untouched, so the next tech costs the same.
    let state = stateWith(1e30, ["age0"]);
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
   * Research is a buyable like buildings and units, priced on the current age's own
   * `base × factor^((n^exponent) − 1)` schedule. Only a bonus naming `"research"` may discount
   * it — never the blanket `allBuildings` reductions nor `buildingCostMultiplier`.
   */
  describe("research cost pipeline", () => {
    it("uses the age's own base for the first tech", () => {
      const state = stateWith(1e30);
      const firstCost = state.getResearchNextCost()[0].base.toNumber();
      expect(firstCost).toBeCloseTo(age0Schedule.base.toNumber(), 9);
    });

    it("scales with purchase count using the age's exponent curve", () => {
      const state = stateWith(1e30);
      const costs = state.getResearchCostForCount(3);
      expect(costs).toHaveLength(1);
      // Read the base from ages.json: a rebalance of the schedule must not stale
      // the assertion that the curve grows.
      expect(costs[0].base.toNumber()).toBeGreaterThan(
        age0Schedule.base.toNumber(),
      );
    });

    it("does not apply building discounts to research", () => {
      // Research is not a building. `writing` grants a 50% `allBuildings` cost
      // discount, and the Master Builder chain drives the global
      // `buildingCostMultiplier` stat: neither may reach a research price.
      let state = stateWith(1e30);
      expect(
        state.getResearchCostModifiers().reductions.percent.toNumber(),
      ).toBe(1);

      state = buyPrerequisiteClosure(state, "writing").buyResearch("writing");

      // The building really is discounted...
      expect(
        state.getBuildingCostModifiers("farm").reductions.percent.toNumber(),
      ).toBeLessThan(1);
      // ...while research keeps the plain age schedule.
      expect(
        state.getResearchCostModifiers().reductions.percent.toNumber(),
      ).toBe(1);
      expect(state.getResearchCostModifiers().reductions.base.toNumber()).toBe(
        1,
      );
      expect(state.getResearchCostModifiers().globalMultiplier.toNumber()).toBe(
        1,
      );
    });

    it("applies a costReductionBase naming research to the base term", () => {
      // base reduction multiplies the base (the value IS the multiplier), so the
      // whole curve scales. This path was previously dropped: the old code read
      // only `percent` and `base` and never `factor` or `flat`.
      const state = buildCostState({
        type: "costReductionBase",
        destination: "research",
        value: 0.5,
      });
      expect(state.getResearchCostModifiers().reductions.base.toNumber()).toBe(
        0.5,
      );
      expect(state.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
        age0Schedule.base.toNumber() * 0.5,
        9,
      );
      // It scales the curve, not just the first unit: n=2 halves too.
      const n2 = state
        .buyResearch(first.key)
        .getResearchNextCost()[0]
        .base.toNumber();
      expect(n2).toBeCloseTo(age0Price(2) * 0.5, 6);
    });

    it("applies a costReductionFlat naming research per unit, clamped at zero", () => {
      // flat subtracts from every unit and clamps at 0 — a cost may become free,
      // never negative (§13.1).
      const small = buildCostState({
        type: "costReductionFlat",
        destination: "research",
        value: 100,
      });
      expect(small.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
        age0Schedule.base.toNumber() - 100,
        9,
      );

      const huge = buildCostState({
        type: "costReductionFlat",
        destination: "research",
        value: 1e9,
      });
      expect(huge.getResearchNextCost()[0].base.toNumber()).toBe(0);
    });

    it("adds a cost reduction to only the named resource on a building", () => {
      const state = buildCostState({
        type: "costReductionPercent",
        destination: "Farm.costs.wood",
        value: 0.5,
      });
      const costs = state.getBuildingCost("farm", 0);
      expect(costs.find(({ resource }) => resource === "food")?.base.toNumber())
        .toBe(10);
      expect(costs.find(({ resource }) => resource === "wood")?.base.toNumber())
        .toBe(5);
    });

    it("applies a factor-only cost addition to every matching unit resource", () => {
      const state = buildCostState({
        type: "attributeFlat",
        destination: "allunits.costs.food.factor",
        value: 12,
      });
      const costs = state.getUnitCostParameters("warrior");
      expect(
        costs.find(({ cost }) => cost.resource === "food")?.cost.factor,
      ).toBeCloseTo(15.5, 12);
      expect(
        costs.find(({ cost }) => cost.resource === "military")?.cost.factor,
      ).toBe(3.5);
    });

    it("applies global exponent additions to buildings, units, upgrades, and research", () => {
      const state = buildCostState({
        type: "attributeFlat",
        destination: "all.costs.all.exponent",
        value: 0.01,
      });
      expect(
        state.getBuildingCostParameters("farm")[0].cost.exponent,
      ).toBeCloseTo(0.51);
      expect(
        state.getUnitCostParameters("warrior")[0].cost.exponent,
      ).toBeCloseTo(0.51);
      expect(state.getUpgradeCost("farmEnhancer9")[0].exponent).toBeCloseTo(
        0.51,
      );
      expect(state.getResearchNextCost()[0].exponent).toBeCloseTo(0.51);
    });

    it("sums the per-unit price across a multi-tech purchase", () => {
      // getResearchCostForCount(n) must be the sum of n consecutive unit prices,
      // not one price scaled by n — each unit walks the age's exponent curve.
      const state = stateWith(1e30);
      expect(state.getResearchCostForCount(3)[0].base.toNumber()).toBeCloseTo(
        age0Price(1) + age0Price(2) + age0Price(3),
        6,
      );
      expect(state.getResearchCostForCount(0)).toEqual([]);
    });

    it("resets cost and count to the new age's base on every age change", () => {
      // The reported bug class: research must re-anchor at each age, so the first
      // tech of an age costs exactly that age's base and the counter reads 0.
      for (const [ageKey, people] of [
        ["age1", 2000],
        ["age2", 20000],
        ["age3", 2000000],
      ] as const) {
        // Every earlier age is completed, so `getCurrentAge()` lands on ageKey.
        const target = ageDefinitions.findIndex((a) => a.key === ageKey);
        const entered = ageDefinitions.slice(0, target).map(({ key }) => key);
        const state = stateWith(1e30, entered, {}, people);
        expect(state.getCurrentAge()?.key).toBe(ageKey);
        expect(state.getResearchCount()).toBe(0);
        const schedule = findAgeDefinition(ageKey)!.research;
        expect(state.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
          schedule.base.toNumber(),
          6,
        );
      }
    });

    it("keeps the first research of age1 at exactly 1e9", () => {
      // Guards the specific number: with no "research"-targeted discount the
      // first Iron Age tech must equal the age1 base to the last bit, i.e. the
      // curve term factor^((1^exponent) - 1) resolves to exactly 1.
      const state = stateWith(1e30, ["age0"]);
      const cost = state.getResearchNextCost()[0].base;
      expect(cost.eq(ExpNumber.fromNumber(1e9))).toBe(true);
      expect(cost.sub(ExpNumber.fromNumber(1e9)).toString()).toBe("0");
    });

    it("applies a bonus that targets research explicitly", () => {
      // Research is a buyable: a `costReductionPercent` naming "research" must
      // reach it, and `costReductionFactor` must slow its growth curve rather than
      // being silently dropped.
      const withPercent = buildCostState({
        type: "costReductionPercent",
        destination: "research",
        value: 0.5,
      });
      expect(
        withPercent.getResearchCostModifiers().reductions.percent.toNumber(),
      ).toBe(0.5);
      expect(withPercent.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
        age0Schedule.base.toNumber() * 0.5,
        9,
      );

      const withFactor = buildCostState({
        type: "costReductionFactor",
        destination: "research",
        value: 0.99,
      });
      const plain = stateWith(1e30);
      const curved = plain.buyResearch(first.key).buyResearch(second.key);
      const discounted = withFactor
        .buyResearch(first.key)
        .buyResearch(second.key);
      expect(discounted.getResearchNextCost()[0].base.toNumber()).toBeLessThan(
        curved.getResearchNextCost()[0].base.toNumber(),
      );
    });

    it("re-prices research when the age changes", () => {
      // Each age owns its schedule, so crossing into age1 jumps to the age1 base
      // and the counter restarts — the opposite of the old flat global curve.
      const age0State = stateWith(1e30);
      const age1State = stateWith(1e30, ["age0"]);

      expect(age0State.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
        age0Schedule.base.toNumber(),
        9,
      );
      expect(age1State.getResearchNextCost()[0].base.toNumber()).toBeCloseTo(
        age1FirstPrice(),
        6,
      );
    });
  });

  it("prices only unbought research needed for a new unit type", () => {
    const state = stateWith(1e30);
    const required = state.getResearchForUnitTypes(["slinger"]);

    expect(required.ids).toEqual(["agriculture", "pottery", "sling_throwing"]);
    expect(required.costs).toHaveLength(1);
    expect(required.costs[0].base.toNumber()).toBeCloseTo(
      age0Price(1) + age0Price(2) + age0Price(3),
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
    let state = stateWith(1e30, ["age0"]);
    expect(state.isResearchUnlocked(ageTwo.key)).toBe(false);
    expect(state.getResearchFailureReason(ageTwo.key)).toBe("locked");
    expect(state.buyResearch(ageTwo.key)).toBe(state);

    // Entering Classical unlocks age2 research once its prerequisites are met.
    state = state.enterAge("age1");
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
    let state = stateWith(1e30, ["age0"]);
    state = buyPrerequisiteClosure(state, ironAge.key);
    expect(state.isResearchUnlocked(ironAge.key)).toBe(true);
    expect(state.buyResearch(ironAge.key).isResearchBought(ironAge.key)).toBe(
      true,
    );
  });

  it("pays science and applies bonuses through the shared factor path", () => {
    // Fund exactly the first tech's price for the age, read from ages.json so a
    // rebalance of the schedule does not turn this into a partial-payment test.
    const entered = stateWith(age0Schedule.base.toNumber());
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
    const entered = stateWith(age0Schedule.base.toNumber());
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
    const state = stateWith(1e12);
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
    // The fixture MUST carry active bonuses on both sides: with a fresh state
    // the sources list is empty and both assertions below pass vacuously —
    // that blindness let an allUnits→buildings leak through once already.
    // wonder0 carries both destinations (allBuildings 0.9, allUnits 0.8).
    const state = stateWith(0, [], {}, 1, ["wonder0"]);
    const farmSources = state.getBuildingCostModifiers("farm").sources;
    const warriorSources = state.getUnitCostModifiers("warrior").sources;
    expect(farmSources.length).toBeGreaterThan(0);
    expect(warriorSources.length).toBeGreaterThan(0);
    expect(farmSources).not.toContainEqual(
      expect.arrayContaining([
        expect.anything(),
        expect.objectContaining({ destination: "allUnits" }),
      ]),
    );
    expect(warriorSources).not.toContainEqual(
      expect.arrayContaining([
        expect.anything(),
        expect.objectContaining({ destination: "allBuildings" }),
      ]),
    );
  });

  it("does not leak the Great Monument's allUnits factor onto buildings", () => {
    // wonder0 carries costReductionFactor 0.9 → allBuildings and 0.8 → allUnits.
    // A building must take only the 0.9; the 0.8 belongs to units alone.
    const monument = new CivilizationState(
      { ...emptyResourceAmounts() },
      emptyWorkerAssignments(),
      {},
      emptyResourceFactors(),
      {},
      0,
      ["wonder0"],
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
    const { reductions, sources } =
      monument.getBuildingCostModifiers("farm");
    expect(sources.some(([, bonus]) => bonus.destination === "allUnits")).toBe(
      false,
    );
    expect(reductions.factor.toNumber()).toBeCloseTo(0.9, 10);
    expect(
      monument.getUnitCostModifiers("warrior").reductions.factor.toNumber(),
    ).toBeCloseTo(0.8, 10);
  });

  it("scopes iron_shielding's cost factor to ground units only", () => {
    // `domain.ground` is a scope, not a unit id: it must reach every ground unit
    // and leave naval and air units untouched. The other allUnits percent cuts
    // in the tree (trapping, masonry, ...) never target domain.ground, so a
    // single bought tech isolates the factor.
    const shielding = findResearchDefinition("iron_shielding");
    expect(
      shielding?.bonuses.some(
        (bonus) =>
          bonus.type === "costReductionFactor" &&
          String(bonus.destination) === "domain.ground.costs.all.factor" &&
          bonus.value.eq(ExpNumber.fromNumber(0.9)),
      ),
      "iron_shielding should carry a costReductionFactor of 0.9 on ground unit costs",
    ).toBe(true);

    const state = buyPrerequisiteClosure(
      stateWith(1e30, ["age0"]),
      "iron_shielding",
    ).buyResearch("iron_shielding");
    expect(state.isResearchBought("iron_shielding")).toBe(true);

    const factorOf = (unitId: string) =>
      state.getUnitCostModifiers(unitId).reductions.factor.toNumber();
    // warrior is ground, canoe naval, zeppelin air.
    expect(factorOf("warrior")).toBeCloseTo(0.9, 6);
    expect(factorOf("canoe")).toBe(1);
    expect(factorOf("zeppelin")).toBe(1);
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
    let state = stateWith(1e30);
    state = buyPrerequisiteClosure(state, unlocker.key);
    state = state.buyResearch(unlocker.key);
    expect(state.isResearchBought(unlocker.key)).toBe(true);
    expect(state.isUnitAvailable(unitId)).toBe(true);
  });
});

describe("research formation unlocks", () => {
  it("mirrors each research formation unlock in the formation definition", () => {
    for (const research of researchDefinitions) {
      for (const formationId of research.unlocksFormations) {
        expect(
          formationDefinitions.find(({ id }) => id === formationId)?.researchId,
        ).toBe(research.key);
      }
    }
    for (const formation of formationDefinitions) {
      if (formation.unlockType === "research") {
        expect(
          researchDefinitions.find(({ key }) => key === formation.researchId)
            ?.unlocksFormations,
        ).toContain(formation.id);
      }
    }
  });

  it("makes a research-gated formation selectable only after purchase", () => {
    const formation = formationDefinitions.find(
      ({ unlockType }) => unlockType === "research",
    );
    expect(formation).toBeDefined();
    if (!formation || !formation.researchId) return;

    const ageIndex = formation.unlockAge;
    const enteredAges = ageDefinitions
      .slice(0, ageIndex + 1)
      .map(({ key }) => key);
    const state = stateWith(1e30, enteredAges);
    const formationId = formation.id as FormationId;
    expect(state.isFormationUnlocked(formationId)).toBe(false);

    const bought = buyPrerequisiteClosure(state, formation.researchId).buyResearch(
      formation.researchId,
    );
    expect(bought.isFormationUnlocked(formationId)).toBe(true);
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
  const buyAt = (science: number, units: Record<string, ExpNumber> = {}) => {
    const enteredAges = ageDefinitions
      .slice(0, conversion.age)
      .map(({ key }) => key);
    let state = stateWith(science, enteredAges, units);
    state = buyPrerequisiteClosure(state, conversion.key);
    return state.buyResearch(conversion.key);
  };

  it("closes the source line once the tech is bought", () => {
    const state = buyAt(1e30);
    expect(state.isResearchBought(conversion.key)).toBe(true);
    expect(state.isUnitAvailable(from)).toBe(false);
    expect(state.isUnitAvailable(to)).toBe(true);
  });

  it("converts owned units at the ratio and zeros the source unit count", () => {
    const counts = buyAt(1e30, { [from]: ExpNumber.fromNumber(25) }).unitCounts;
    expect(counts[from].toNumber()).toBe(0);
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
    const state = stateWith(1e10).buyResearch("agriculture");
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
    const { entryGuidById } = await import("../dataIds");
    for (const research of researchDefinitions) {
      expect(entryGuidById.get(research.key), research.key).toBeDefined();
    }
    expect(findResearchDefinition("agriculture")).toBeDefined();
  });
});
