import { describe, expect, it } from "vitest";
import { CivilizationState } from "../civilizationState";
import { encounterDefinitions } from "../encounters";
import { researchDefinitions } from "../research";
import {
  findUnitDefinition,
  parseUnitStatTarget,
  unitMatchesStatTarget,
} from "../units";

describe("unit stat modifier sources", () => {
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
