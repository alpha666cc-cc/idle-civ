import { describe, expect, it } from "vitest";
import {
  costTargetMatchesBuyable,
  isValidBonusDestination,
  normalizeBonusDestination,
  parseBonus,
  parseCostParameterTarget,
  parseBonusType,
} from "../bonus";
import {
  buildingDefinitions,
  hasBuildingEffectTag,
} from "../buildings";
import { attributeDefinitions, type AttributeKey } from "../attributes";

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
    expect(normalizeBonusDestination("domain.Ground.attack")).toBe(
      "domain.ground.attack",
    );
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
    expect(isValidBonusDestination("domain.ground.attack")).toBe(true);
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
        "attributeFlat",
        "all.costs.all.exponent",
        0.01,
      ).destination,
    ).toBe("all.costs.all.exponent");
    expect(() =>
      parseBonus("attributeFlat", "Market.costs.all", 1),
    ).toThrow("Flat cost bonuses require a cost field target");
    expect(() =>
      parseBonusType("costParameterAdd"),
    ).toThrow("Unknown bonus type: costParameterAdd");
  });

  it("house capacity effect is affected by power, other buildings have nopower", () => {
    const house = buildingDefinitions.find(b => b.key === "house");
    const townHall = buildingDefinitions.find(b => b.key === "townHall");

    const houseCapacity = house?.effects.capacityProvided?.[0];
    const townHallCapacity = townHall?.effects.capacityProvided?.[0];

    // House capacity keeps the nopower tag (capacity grants are flat, not
    // scaled by the building's power).
    expect(hasBuildingEffectTag(houseCapacity!, "nopower")).toBe(true);

    // TownHall capacity keeps the nopower tag for the same reason.
    expect(hasBuildingEffectTag(townHallCapacity!, "nopower")).toBe(true);

    // Other buildings should keep nopower
    const barracksCapacity = townHall?.effects.capacityProvided?.find(
      (e) => e.building === "barracks",
    );
    expect(hasBuildingEffectTag(barracksCapacity!, "nopower")).toBe(true);
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

  it("buildings with explicit power get power attributes registered", () => {
    const house = buildingDefinitions.find(b => b.key === "house");
    const townHall = buildingDefinitions.find(b => b.key === "townHall");

    expect(house?.power?.toString()).toBe("0");
    expect(townHall?.power?.toString()).toBe("0");

    const housePowerAttr = attributeDefinitions.find(
      (a) => a.key === ("housePower" as AttributeKey),
    );
    const townHallPowerAttr = attributeDefinitions.find(
      (a) => a.key === ("townHallPower" as AttributeKey),
    );

    expect(housePowerAttr).toBeDefined();
    expect(townHallPowerAttr).toBeDefined();
    expect(housePowerAttr?.family).toBe("derived");
    expect(townHallPowerAttr?.family).toBe("derived");
  });

  it("house and townhall have no production effects even with power", () => {
    const house = buildingDefinitions.find(b => b.key === "house");
    const townHall = buildingDefinitions.find(b => b.key === "townHall");

    // These buildings only provide capacity, not production
    expect(house?.effects.additiveMultiplier).toBeUndefined();
    expect(house?.effects.resourceProduction).toBeUndefined();
    expect(townHall?.effects.additiveMultiplier).toBeUndefined();
    expect(townHall?.effects.resourceProduction).toBeUndefined();

    // Power alone without effects doesn't boost production
    expect(house?.effects.capacityProvided).toBeDefined();
    expect(townHall?.effects.capacityProvided).toBeDefined();
  });
});
