import { describe, expect, it } from "vitest";
import { CivilizationState } from "../civilizationState";
import { ExpNumber } from "../expNumber";
import { encounterDefinitions } from "../encounters";
import { researchDefinitions } from "../research";
import {
  findUnitDefinition,
  parseUnitStatTarget,
  unitMatchesStatTarget,
} from "../units";

describe("unit stat modifier sources", () => {
  it("applies domain-scoped research bonuses to matching units only", () => {
    const target = parseUnitStatTarget("domain.ground.attack");
    const groundUnit = findUnitDefinition("berserker");
    const navalUnit = findUnitDefinition("canoe");
    const research = researchDefinitions.find(
      ({ key }) => key === "subterfuge",
    );
    if (!target || !groundUnit || !navalUnit || !research) {
      throw new Error("Missing domain target test definitions");
    }

    expect(target).toEqual({
      scope: "domain",
      domain: "ground",
      stat: "attack",
    });
    expect(unitMatchesStatTarget(groundUnit, target)).toBe(true);
    expect(unitMatchesStatTarget(navalUnit, target)).toBe(false);

    const state = new CivilizationState(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [research.key],
    );
    expect(
      state.getUnitStatsWithResearch(groundUnit.key, [])?.attack.eq(
        groundUnit.stats.attack.mul(ExpNumber.fromNumber(1.5)),
      ),
    ).toBe(true);
    expect(
      state.getUnitStatsWithResearch(navalUnit.key, [])?.attack.eq(
        navalUnit.stats.attack,
      ),
    ).toBe(true);
  });

  it("returns active research and battle bonuses for the selected unit", () => {
    const unit = findUnitDefinition("berserker");
    if (!unit) throw new Error("Missing Berserker definition");

    const matchesUnit = (destination: string): boolean => {
      const target = parseUnitStatTarget(destination);
      return target !== undefined && unitMatchesStatTarget(unit, target);
    };
    const research = researchDefinitions.find(({ bonuses }) =>
      bonuses.some(
        ({ destination }) =>
          typeof destination === "string" && matchesUnit(destination),
      ),
    );
    const encounter = encounterDefinitions.find(({ bonuses }) =>
      bonuses.some(({ destination }) => matchesUnit(String(destination))),
    );
    if (!research || !encounter) {
      throw new Error("Expected research and battle unit-stat bonuses");
    }

    const state = new CivilizationState(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [encounter.key],
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [research.key],
    );
    const modifiers = state.getUnitStatModifiers(unit.key);
    const sourceIds = modifiers.map(([sourceId]) => sourceId);

    expect(sourceIds).toContain(research.key);
    expect(sourceIds).toContain(encounter.key);
    expect(
      modifiers.every(([, bonus]) => {
        const target = parseUnitStatTarget(bonus.destination);
        return target !== undefined && unitMatchesStatTarget(unit, target);
      }),
    ).toBe(true);
  });
});
