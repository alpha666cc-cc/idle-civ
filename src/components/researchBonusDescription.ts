import { buildingDefinitions, type BuildingKey } from "../game/buildings";
import type { Bonus } from "../game/bonus";
import { ExpNumber } from "../game/expNumber";
import { unitDefinitions } from "../game/units";

type NumberFormatter = (value: ExpNumber | number) => string;

const buildingNames = new Map(
  buildingDefinitions.map((building) => [building.key, building.name]),
);
const unitNames = new Map(unitDefinitions.map((unit) => [unit.id, unit.name]));

const unitStatLabels: Record<string, string> = {
  "tag.infantry.hp": "infantry health",
  "tag.ranged.attack": "ranged attack",
  "tag.armored.attack": "cavalry attack",
  "tag.armored.speed": "cavalry speed",
  "tag.naval.attack": "ship attack",
  "tag.naval.hp": "ship hulls",
  "unitAll.hp": "units health",
  "unitAll.attack": "units attack",
};

const resourceLabels: Record<string, string> = {
  food: "food",
  wood: "wood",
  stone: "stone",
  gold: "gold",
  population: "population",
  science: "science",
  military: "military",
  metalwork: "metalwork",
  trade: "trade",
};

const derivedStatLabels: Record<string, string> = {
  clickPower: "click power",
  autoClickRate: "auto-click rate",
  tradeRoutes: "trade routes",
  advancedProductionPerWorker: "advanced production worker efficiency",
};

const costScopeLabels: Record<string, string> = {
  allBuildings: "buildings",
  allUnits: "units",
  civilBuildings: "civil buildings",
  basicProductionBuildings: "basic production buildings",
  advancedProductionBuildings: "advanced production buildings",
};

const tagLabels: Record<string, string> = {
  infantry: "infantry",
  cavalry: "cavalry",
  ranged: "ranged",
  armored: "armored",
  naval: "naval",
  siege: "siege",
};

const domainLabels: Record<string, string> = {
  ground: "ground units",
  air: "air units",
  naval: "naval units",
};

const humanizeIdentifier = (identifier: string): string =>
  identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

const costTargetLabel = (destination: string): string => {
  const parts = destination.split(".");
  const scope =
    parts[0] === "tag" || parts[0] === "domain"
      ? `${parts[0]}.${parts[1]}`
      : parts[0];
  const resourceIndex = scope.startsWith("tag.") || scope.startsWith("domain.")
    ? 3
    : 2;
  const resource = parts[resourceIndex];
  const field = parts[resourceIndex + 1];
  let label: string;
  if (scope.startsWith("tag.")) {
    const tag = scope.slice("tag.".length);
    label = `${tagLabels[tag] ?? humanizeIdentifier(tag)} units`;
  } else if (scope.startsWith("domain.")) {
    const domain = scope.slice("domain.".length);
    label = domainLabels[domain] ?? `${humanizeIdentifier(domain)} units`;
  } else {
    label =
      costScopeLabels[scope] ??
      (scope === "all"
        ? "buyables"
        : buildingNames.get(scope as BuildingKey)?.toLowerCase() ??
          unitNames.get(scope)?.toLowerCase() ??
          humanizeIdentifier(scope));
  }
  if (field === "factor") {
    return resource === "all"
      ? `cost growth for ${label}`
      : `cost growth for ${label} ${resource}`;
  }
  if (resource !== "all") return `${label} ${resource}`;
  return label;
};

const destinationLabel = (destination: string): string => {
  if (destination.includes(".costs.")) return costTargetLabel(destination);
  if (destination === "allProduction") return "all production";
  if (destination === "advancedProductionPerWorker")
    return "advanced production worker efficiency";
  if (unitStatLabels[destination]) return unitStatLabels[destination];

  const unitStatMatch =
    /^(unitAll|tag|domain)\.([^.]+)(?:\.([^.]+))?$/i.exec(destination);
  if (unitStatMatch) {
    const [, scope, target, stat] = unitStatMatch;
    const scopeLabel =
      scope.toLowerCase() === "unitall"
        ? "units"
        : scope.toLowerCase() === "tag"
          ? tagLabels[target] ?? humanizeIdentifier(target)
          : domainLabels[target] ?? `${humanizeIdentifier(target)} units`;
    if (!stat) return scopeLabel;
    const statLabels: Record<string, string> = {
      hp: "health",
      attack: "attack",
      armor: "armour",
      range: "range",
      speed: "speed",
      accuracy: "accuracy",
    };
    return `${scopeLabel} ${statLabels[stat.toLowerCase()] ?? humanizeIdentifier(stat)}`;
  }

  const capacityMatch = destination.match(/^([A-Z][a-zA-Z]+)\.capacity$/);
  if (capacityMatch) {
    const name =
      [...buildingNames.entries()].find(
        ([key]) => key.toLowerCase() === capacityMatch[1].toLowerCase(),
      )?.[1] ?? humanizeIdentifier(capacityMatch[1]);
    return `${name} capacity`;
  }
  if (destination.endsWith("Capacity")) {
    const owner = destination.slice(0, -8);
    const name =
      [...buildingNames.entries()].find(
        ([key]) => key.toLowerCase() === owner.toLowerCase(),
      )?.[1] ?? humanizeIdentifier(owner);
    return `${name} capacity`;
  }

  const named =
    buildingNames.get(destination as BuildingKey) ?? unitNames.get(destination);
  if (named) return named;
  return resourceLabels[destination] ?? derivedStatLabels[destination] ??
    humanizeIdentifier(destination);
};

export const describeBonus = (
  bonus: Bonus,
  fmt: NumberFormatter,
): string => {
  const destination = String(bonus.destination);
  const label = destinationLabel(destination);
  const percentText = (fraction: ExpNumber): string => {
    const numeric = fraction.toNumber() * 100;
    return Number.isFinite(numeric) && Math.abs(numeric) < 1e21
      ? `${Number(numeric.toFixed(2))}%`
      : `${fmt(fraction.mul(ExpNumber.fromNumber(100)))}%`;
  };
  const costTarget = label;
  const signedAmount = (value: ExpNumber): string =>
    `${value.isNegative ? "−" : "+"}${fmt(value.abs())}`;

  switch (bonus.type) {
    case "attributeMultiplier": {
      const numeric = bonus.value.toNumber();
      if (Number.isFinite(numeric) && numeric > 0 && numeric < 2) {
        return `${numeric > 1 ? "+" : "−"}${percentText(
          bonus.value.sub(ExpNumber.ONE).abs(),
        )} ${label}`;
      }
      return `×${fmt(bonus.value)} ${label}`;
    }
    case "attributeFlat":
      return `${signedAmount(bonus.value)} ${label}`;
    case "attributeDrain":
      return bonus.value.isNegative
        ? `Reduces ${label} drain by ${fmt(bonus.value.abs())} per second`
        : `Adds ${fmt(bonus.value)} ${label} drain per second`;
    case "removeDrain":
      return `Reduces ${label} drains by ${percentText(bonus.value)}`;
    case "costReductionPercent": {
      return `${percentText(bonus.value)} cheaper ${costTarget}`;
    }
    case "costReductionFlat": {
      return `${fmt(bonus.value)} less per cost item for ${costTarget}`;
    }
    case "costReductionBase": {
      const numeric = bonus.value.toNumber();
      if (Number.isFinite(numeric) && numeric <= 1) {
        return `${percentText(
          ExpNumber.ONE.sub(bonus.value),
        )} cheaper base costs for ${costTarget}`;
      }
      return `Base costs for ${costTarget} ×${fmt(bonus.value)}`;
    }
    case "costReductionFactor": {
      const target = label.includes("growth")
        ? label.slice("cost growth for ".length)
        : label;
      const costLabel = target.endsWith("cost") ? target : `${target} cost`;
      return `${costLabel} ^${fmt(bonus.value)}`;
    }
  }
  return label;
};
