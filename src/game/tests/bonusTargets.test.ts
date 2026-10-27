import { describe, expect, it } from "vitest";
import {
  costTargetMatchesBuyable,
  isValidBonusDestination,
  normalizeBonusDestination,
  parseBonus,
  parseCostParameterTarget,
} from "../bonus";

describe("bonus destination paths", () => {
  it("normalizes the requested target families to stable ids", () => {
    expect(normalizeBonusDestination("Market.costs.all")).toBe(
      "market.costs.all",
    );
    expect(normalizeBonusDestination("Farm.costs.wood")).toBe(
      "farm.costs.wood",
    );
    expect(normalizeBonusDestination("Market.power")).toBe("marketPower");
    expect(normalizeBonusDestination("TownHall.capacity")).toBe(
      "townHallCapacity",
    );
    expect(
      parseBonus("attributeMultiplier", "Market.power", 2).destination,
    ).toBe("marketPower");
    expect(
      normalizeBonusDestination("allProduction.worker.efficiency"),
    ).toBe("allProductionPerWorker");
    expect(
      normalizeBonusDestination("advancedProduction.worker.efficiency"),
    ).toBe("advancedProductionPerWorker");
    expect(
      normalizeBonusDestination("domain.Ground.costs.all.factor"),
    ).toBe("domain.ground.costs.all.factor");
    expect(normalizeBonusDestination("tag.Cavalry.costs.all")).toBe(
      "tag.cavalry.costs.all",
    );
    expect(
      normalizeBonusDestination("tag.AntiArmor.costs.all.factor"),
    ).toBe("tag.antiArmor.costs.all.factor");
    expect(normalizeBonusDestination("Wood.worker")).toBe(
      "woodProductionPerWorker",
    );
    expect(normalizeBonusDestination("Wood.worker.efficiency")).toBe(
      "woodProductionPerWorker",
    );
    expect(
      normalizeBonusDestination("allunits.costs.wood.factor"),
    ).toBe("allUnits.costs.wood.factor");
    expect(
      normalizeBonusDestination("productionBuilding.power"),
    ).toBe("buildingPower");
  });

  it("validates cost targets, groups, and field-scoped additions", () => {
    expect(isValidBonusDestination("Civilbuildings")).toBe(true);
    expect(isValidBonusDestination("house.costs.stone.factor")).toBe(true);
    expect(isValidBonusDestination("all.costs.all.exponent")).toBe(true);
    expect(
      isValidBonusDestination("advancedProductionBuildings.costs.all.factor"),
    ).toBe(true);
    expect(isValidBonusDestination("domain.ground.costs.all.factor")).toBe(
      true,
    );
    expect(isValidBonusDestination("tag.cavalry.costs.all")).toBe(true);
    expect(isValidBonusDestination("tag.antiArmor.costs.all.factor")).toBe(
      true,
    );
    expect(isValidBonusDestination("Market.factor")).toBe(false);
    expect(isValidBonusDestination("Market.exponent")).toBe(false);
    expect(isValidBonusDestination("farm.costs.notAResource.factor")).toBe(
      false,
    );
    expect(
      parseBonus(
        "costParameterAdd",
        "all.costs.all.exponent",
        0.01,
      ).destination,
    ).toBe("all.costs.all.exponent");
    expect(() =>
      parseBonus("costParameterAdd", "Market.costs.all", 1),
    ).toThrow("Cost parameter bonuses require a cost field target");
  });

  it("matches the cost resource and buyable scope", () => {
    const target = parseCostParameterTarget(
      "allUnits.costs.wood.factor",
    );
    expect(target).toEqual({
      buyable: "allUnits",
      resource: "wood",
      field: "factor",
    });
    expect(costTargetMatchesBuyable(target!, "warrior")).toBe(true);
    expect(costTargetMatchesBuyable(target!, "farm")).toBe(false);

    const groundTarget = parseCostParameterTarget(
      "domain.ground.costs.all.factor",
    );
    const infantryTarget = parseCostParameterTarget(
      "tag.infantry.costs.all",
    );
    const antiArmorTarget = parseCostParameterTarget(
      "tag.antiArmor.costs.all.factor",
    );
    expect(costTargetMatchesBuyable(groundTarget!, "warrior")).toBe(true);
    expect(costTargetMatchesBuyable(infantryTarget!, "warrior")).toBe(true);
    expect(costTargetMatchesBuyable(infantryTarget!, "slinger")).toBe(false);
    expect(costTargetMatchesBuyable(antiArmorTarget!, "spearman_bronze")).toBe(
      true,
    );
    expect(costTargetMatchesBuyable(antiArmorTarget!, "warrior")).toBe(false);
  });
});
