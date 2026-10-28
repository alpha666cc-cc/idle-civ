import { describe, expect, it } from "vitest";
import { parseBonus } from "../game/bonus";
import {
  bonusEffectLabel,
  bonusValueText,
} from "./gamepediaBonusDescription";

describe("Gamepedia bonus descriptions", () => {
  it.each([
    [
      "costReductionFactor",
      "allBuildings.costs.all.factor",
      0.8,
      "Every building costs growth factor",
      "^0.8",
    ],
    [
      "costReductionPercent",
      "quarry.costs.all",
      0.95,
      "Quarry cost",
      "−95%",
    ],
    [
      "attributeMultiplier",
      "Farm.capacity",
      10,
      "Farm Capacity",
      "×10",
    ],
    [
      "attributeMultiplier",
      "unitAll.attack",
      1.5,
      "Unit attack",
      "+50%",
    ],
  ])(
    "describes %s on %s with its target and magnitude",
    (type, destination, value, expectedLabel, expectedValue) => {
      const bonus = parseBonus(type, destination, value);

      expect(bonusEffectLabel(bonus)).toBe(expectedLabel);
      expect(bonusValueText(bonus, "named")).toBe(expectedValue);
    },
  );
});
