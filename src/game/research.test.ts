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
  researchesUnlockingUnit,
} from "./research";
import {
  SAVE_VERSION,
  createSaveData,
  loadSaveData,
  migrateSaveData,
} from "./saveSystem";
import { isBuyableUnit, unitDefinitions } from "./units";

/** An age-0 state with a pool of science to buy research with. */
const stateWith = (
  science: number,
  enteredAges: string[] = [],
): CivilizationState =>
  new CivilizationState(
    { ...emptyResourceAmounts(), science: ExpNumber.fromNumber(science) },
    emptyWorkerAssignments(),
    ["town-hall"],
    emptyResourceFactors(),
    {},
    0,
    [],
    [],
    enteredAges,
    [],
    emptyStatistics(),
    {},
    ExpNumber.ONE,
    false,
    false,
    false,
    [],
  );

describe("research data integrity", () => {
  it("costs every tech 1K science multiplied by ten per position", () => {
    researchDefinitions.forEach((research, index) => {
      const cost = research.costs[0];
      expect(cost, research.key).toBeDefined();
      expect(cost.resource).toBe("science");
      // `base` is exactly 1 × 10^(index+3); compare on the canonical string,
      // since 1000 × 10^index rounds as a double past 1e22.
      expect(cost.base.toString(), research.key).toBe(`1e${index + 3}`);
    });
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
});

describe("research buying", () => {
  const first = researchDefinitions[0];

  it("makes age-0 research available from the start", () => {
    const state = stateWith(0);
    expect(state.isResearchUnlocked(first.key)).toBe(true);
    expect(state.getResearchFailureReason(first.key)).toBe("resources");
    const entered = state.enterAge(`age-${first.age}`);
    expect(entered.isResearchUnlocked(first.key)).toBe(true);
    expect(entered.getResearchFailureReason(first.key)).toBe("resources");
  });

  it("pays science and applies bonuses through the shared factor path", () => {
    const entered = stateWith(1e3, [`age-${first.age}`]).enterAge(
      `age-${first.age}`,
    );
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
    const entered = stateWith(1e3, [`age-${first.age}`]).enterAge(
      `age-${first.age}`,
    );
    const bought = entered.buyResearch(first.key);
    expect(bought.buyResearch(first.key)).toBe(bought);
    expect(bought.canBuyResearch(first.key)).toBe(false);
  });

  it("gates follow-up techs behind their prerequisites", () => {
    const child = researchDefinitions.find((r) => r.prerequisites.length > 0);
    expect(child).toBeDefined();
    if (!child) return;
    const state = stateWith(1e12, [`age-${child.age}`]).enterAge(
      `age-${child.age}`,
    );
    expect(state.isResearchUnlocked(child.key)).toBe(false);
    const withParents = child.prerequisites.reduce(
      (current, prerequisite) => current.buyResearch(prerequisite),
      state,
    );
    expect(withParents.isResearchUnlocked(child.key)).toBe(true);
  });
});

describe("research unlocks units", () => {
  it("marks research-unlocked units available once bought", () => {
    const unlocker = researchDefinitions.find(
      (research) => research.unlocks.length > 0,
    );
    expect(unlocker).toBeDefined();
    if (!unlocker) return;
    const unitId = unlocker.unlocks[0];
    const unit = unitDefinitions.find((candidate) => candidate.key === unitId);
    expect(isBuyableUnit(unit!)).toBe(true);
    const state = stateWith(1e30, [`age-${unlocker.age}`]).enterAge(
      `age-${unlocker.age}`,
    );
    if (!state.isUnitAvailable(unitId)) {
      // Buy every transitive prerequisite (in topological order) first.
      const ancestors = new Set<string>([unlocker.key]);
      const collect = (id: string): void => {
        for (const prerequisite of findResearchDefinition(id)?.prerequisites ??
          []) {
          if (!ancestors.has(prerequisite)) {
            ancestors.add(prerequisite);
            collect(prerequisite);
          }
        }
      };
      collect(unlocker.key);
      const entered = researchDefinitions
        .filter((research) => ancestors.has(research.key))
        .reduce(
          (current, research) => current.buyResearch(research.key),
          state,
        );
      expect(entered.isResearchBought(unlocker.key)).toBe(true);
      expect(entered.isUnitAvailable(unitId)).toBe(true);
    }
  });
});

describe("research in the save system", () => {
  it("round-trips bought research through a save document", () => {
    const state = stateWith(1e3, ["age-0"])
      .enterAge("age-0")
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
