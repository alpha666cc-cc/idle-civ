import { describe, expect, it } from "vitest";
import { describeBonus } from "./researchBonusDescription";
import { researchDefinitions } from "../game/research";
import { parseBonus } from "../game/bonus";
import { ExpNumber } from "../game/expNumber";

const fmt = (value: ExpNumber | number): string =>
  value instanceof ExpNumber ? String(value.toNumber()) : String(value);

describe("research bonus descriptions", () => {
  it("describes every research bonus without exposing internal target IDs", () => {
    for (const research of researchDefinitions) {
      for (const bonus of research.bonuses) {
        const description = describeBonus(bonus, fmt);

        expect(description, research.key).not.toBe("");
        expect(description, research.key).not.toMatch(
          /\b(?:attributeMultiplier|attributeFlat|costReduction|unitAll|tag\.|domain\.|[a-z]+_[a-z]+)/,
        );
      }
    }
  });

  it.each([
    [
      "attributeMultiplier",
      "food",
      2,
      "×2 food",
    ],
    [
      "attributeMultiplier",
      "tag.infantry.attack",
      2,
      "×2 infantry attack",
    ],
    [
      "attributeMultiplier",
      "tag.infantry.attack",
      1.25,
      "+25% infantry attack",
    ],
    [
      "attributeMultiplier",
      "unitAll.hp",
      1.5,
      "+50% units health",
    ],
    [
      "attributeMultiplier",
      "unitAll.attack",
      1.5,
      "+50% unit attack",
    ],
    [
      "attributeMultiplier",
      "advancedProductionPerWorker",
      3,
      "×3 advanced production worker efficiency",
    ],
    [
      "attributeFlat",
      "clickPower",
      2,
      "+2 click power",
    ],
    [
      "attributeDrain",
      "food",
      3,
      "Adds 3 food drain per second",
    ],
    [
      "removeDrain",
      "food",
      0.5,
      "Reduces food drains by 50%",
    ],
    [
      "costReductionPercent",
      "farm.costs.all",
      0.5,
      "50% cheaper farm",
    ],
    [
      "costReductionPercent",
      "allBuildings.costs.all",
      0.5,
      "50% cheaper buildings",
    ],
    [
      "costReductionPercent",
      "allUnits.costs.all",
      0.5,
      "50% cheaper units",
    ],
    [
      "costReductionFlat",
      "house.costs.wood",
      10,
      "10 less per cost item for house wood",
    ],
    [
      "costReductionBase",
      "townHall.costs.all",
      0.5,
      "50% cheaper base costs for town hall",
    ],
    [
      "costReductionFactor",
      "people.costs.all.factor",
      0.9,
      "citizen cost ^0.9",
    ],
    [
      "costReductionFactor",
      "domain.ground.costs.all.factor",
      0.8,
      "ground units cost ^0.8",
    ],
  ])("explains %s bonuses in player-facing language", (
    type,
    destination,
    value,
    expected,
  ) => {
    const bonus = parseBonus(type, destination, value);
    expect(describeBonus(bonus, fmt)).toBe(expected);
  });
});
