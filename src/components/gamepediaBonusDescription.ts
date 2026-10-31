import {
  normalizeBonusDestination,
  parseCostParameterTarget,
  type Bonus,
} from "../game/bonus";
import { attributeDefinitions } from "../game/attributes";
import { ExpNumber } from "../game/expNumber";
import { gamepedia } from "../game/gamepedia";
import {
  parseUnitStatTarget,
  unitDomainLabels,
  unitStatLabels,
  type UnitDomain,
} from "../game/units";
import {
  formatNumber,
  type NumberFormat,
} from "../game/numberFormat";

const displayName = (object: { id: string }): string => {
  const definition = object as { id: string; name?: string; label?: string };
  return definition.name ?? definition.label ?? definition.id;
};

const costOwnerName = (buyable: string): string => {
  switch (buyable) {
    case "all":
      return "Every buyable";
    case "allBuildings":
      return "Every building";
    case "allUnits":
      return "Every unit";
    case "civilBuildings":
      return "Civil buildings";
    case "basicProductionBuildings":
      return "Basic production buildings";
    case "advancedProductionBuildings":
      return "Advanced production buildings";
    default: {
      if (buyable.startsWith("tag.")) {
        const tag = buyable.slice("tag.".length);
        return `${tag[0].toUpperCase()}${tag.slice(1)} units`;
      }
      if (buyable.startsWith("domain.")) {
        const domain = buyable.slice("domain.".length) as UnitDomain;
        return `${unitDomainLabels[domain] ?? domain} units`;
      }
      const owner = gamepedia.get(buyable);
      return owner ? displayName(owner.object) : buyable;
    }
  }
};

const costResourceName = (resource: string): string => {
  if (resource === "all") return "";
  const entry = gamepedia.get(resource);
  return entry ? displayName(entry.object) : resource;
};

const costEffectLabel = (bonus: Bonus, destination: string): string => {
  const target = parseCostParameterTarget(destination);
  const owner = target
    ? costOwnerName(target.buyable)
    : destinationName(destination);
  const resource = target ? costResourceName(target.resource) : "";
  const costName = resource ? `${owner} ${resource} cost` : `${owner} cost`;

  switch (bonus.type) {
    case "costReductionFactor":
      return resource
        ? `${owner} ${resource} costs growth factor`
        : `${owner} costs growth factor`;
    case "costReductionBase":
      return resource
        ? `Base ${costName}`
        : `Base cost for ${owner}`;
    case "costReductionFlat":
    case "costReductionPercent":
      return costName;
    default:
      return costName;
  }
};

const groupDestinationLabel = (destination: string): string | undefined => {
  if (destination === "allUnits") return "Units";
  if (destination === "allBuildings") return "Buildings";
  if (destination === "civilBuildings") return "Civil buildings";
  if (destination === "basicProductionBuildings")
    return "Basic production buildings";
  if (destination === "advancedProductionBuildings")
    return "Advanced production buildings";
  if (destination === "productionBuilding.power")
    return "Production building power";
  if (destination === "basicProductionPerWorker")
    return "Basic production worker efficiency";
  if (destination === "advancedProductionPerWorker")
    return "Advanced production worker efficiency";
  if (destination === "allProductionPerWorker")
    return "All production worker efficiency";
  const tag = /^tag\.([a-zA-Z-]+)$/.exec(destination);
  if (tag) return `${tag[1]} units`;
  const domain = /^domain\.([a-z]+)$/.exec(destination);
  if (domain && domain[1] in unitDomainLabels)
    return `${unitDomainLabels[domain[1] as UnitDomain]} units`;
  return undefined;
};

const destinationName = (destination: string): string => {
  const normalized = normalizeBonusDestination(destination);
  const unitStat = parseUnitStatTarget(normalized);
  if (unitStat) {
    const stat = unitStatLabels[unitStat.stat];
    if (unitStat.scope === "all") {
      return `Unit ${stat.toLowerCase()}`;
    }
    if (unitStat.scope === "tag") {
      const tag = unitStat.tag;
      return `${tag[0].toUpperCase()}${tag.slice(1)} ${stat.toLowerCase()}`;
    }
    if (unitStat.scope === "domain") {
      return `${unitDomainLabels[unitStat.domain]} ${stat.toLowerCase()}`;
    }
    const entry = gamepedia.get(unitStat.unitId);
    return `${entry ? displayName(entry.object) : unitStat.unitId} ${stat.toLowerCase()}`;
  }

  const entry = gamepedia.get(normalized);
  if (entry) return displayName(entry.object);
  return groupDestinationLabel(normalized) ?? normalized;
};

/** Describes what the bonus changes, with its scope and cost field explicit. */
export const bonusEffectLabel = (bonus: Bonus): string => {
  const destination = String(bonus.destination);
  const normalized = normalizeBonusDestination(destination);
  const costTarget = parseCostParameterTarget(normalized);
  if (bonus.type.startsWith("costReduction")) {
    return costEffectLabel(bonus, normalized);
  }
  if (costTarget?.field) {
    const owner = costOwnerName(costTarget.buyable);
    const resource =
      costTarget.resource === "all"
        ? ""
        : ` ${costResourceName(costTarget.resource)}`;
    return `${owner}${resource} cost ${costTarget.field}`;
  }

  const target = destinationName(normalized);
  const definition = attributeDefinitions.find(({ key }) => key === normalized);

  switch (bonus.type) {
    case "attributeMultiplier":
      if (definition?.family === "amount") return `${target} production`;
      return target;
    case "attributeFlat":
      return `${target} gain`;
    case "attributeDrain":
      return `${target} drain`;
    case "removeDrain":
      return `${target} drain reduction`;
    default:
      return target;
  }
};

/** Describes the magnitude of a bonus in the selected number format. */
export const bonusValueText = (
  bonus: Bonus,
  format: NumberFormat,
): string => {
  switch (bonus.type) {
    case "attributeMultiplier": {
      const value = bonus.value.toNumber();
      if (Number.isFinite(value) && value > 0 && value < 2) {
        const sign = value > 1 ? "+" : "−";
        return `${sign}${formatNumber(
          bonus.value
            .sub(ExpNumber.ONE)
            .abs()
            .mul(ExpNumber.fromNumber(100)),
          format,
        )}%`;
      }
      return `×${formatNumber(bonus.value, format)}`;
    }
    case "costReductionPercent":
      return `−${formatNumber(
        bonus.value.mul(ExpNumber.fromNumber(100)),
        format,
      )}%`;
    case "costReductionBase":
      return `×${formatNumber(bonus.value, format)}`;
    case "costReductionFactor":
      return `^${formatNumber(bonus.value, format)}`;
    case "costReductionFlat":
      return `−${formatNumber(bonus.value, format)}`;
    case "attributeFlat":
      return `${bonus.value.isNegative ? "−" : "+"}${formatNumber(
        bonus.value.abs(),
        format,
      )}`;
    case "attributeDrain":
      return `−${formatNumber(bonus.value.abs(), format)}`;
    case "removeDrain":
      return `−${formatNumber(
        bonus.value.mul(ExpNumber.fromNumber(100)),
        format,
      )}%`;
    default:
      return formatNumber(bonus.value, format);
  }
};
