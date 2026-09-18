import unitData from "./data/units.json";
import type { ResourceKey } from "./attributes";
import type { BuildingCost } from "./buildings";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";

/**
 * Units (AGENTS.md §13.3): buyables with the building cost model, no capacity
 * limit, and the receptacle for bonuses. `hp` and `attack` are `ExpNumber`
 * because bonuses and age scaling grow them without bound; `armor`, `range`,
 * `speed` and `accuracy` are bounded scalars — they describe *how* a unit fights
 * (whether it can reach a target at all, how often it lands) rather than how much
 * damage it survives or deals, so they stay plain numbers.
 */
export type UnitDomain = "ground" | "air" | "naval";

export type UnitStatKey =
  | "hp"
  | "attack"
  | "armor"
  | "range"
  | "speed"
  | "accuracy";

export const unitStatKeys: readonly UnitStatKey[] = [
  "hp",
  "attack",
  "armor",
  "range",
  "speed",
  "accuracy",
];

export const unitStatLabels: Record<UnitStatKey, string> = {
  hp: "Health",
  attack: "Attack",
  armor: "Armour",
  range: "Range",
  speed: "Speed",
  accuracy: "Accuracy",
};

export const unitDomainLabels: Record<UnitDomain, string> = {
  ground: "Ground",
  air: "Air",
  naval: "Naval",
};

/** The stats a battle actually reads, after every bonus in force. */
export type UnitStats = {
  readonly hp: ExpNumber;
  readonly attack: ExpNumber;
  readonly armor: number;
  readonly range: number;
  readonly speed: number;
  readonly accuracy: number;
};

export class UnitDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly age: number;
  readonly domain: UnitDomain;
  readonly tags: readonly string[];
  readonly canHit: readonly UnitDomain[];
  readonly bonusVs: readonly string[];
  /** Buyable from the start when true; otherwise a battle victory unlocks it. */
  readonly available: boolean;
  readonly costs: BuildingCost[];
  readonly stats: UnitStats;

  constructor(
    key: string,
    name: string,
    description: string,
    age: number,
    domain: UnitDomain,
    tags: readonly string[],
    canHit: readonly UnitDomain[],
    bonusVs: readonly string[],
    available: boolean,
    costs: BuildingCost[],
    stats: UnitStats,
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.age = age;
    this.domain = domain;
    this.tags = tags;
    this.canHit = canHit;
    this.bonusVs = bonusVs;
    this.available = available;
    this.costs = costs;
    this.stats = stats;
  }

  /** "Ground · infantry, armored" — the domain/tags line in the Gamepedia. */
  get typeSummary(): string {
    return [unitDomainLabels[this.domain], this.tags.join(", ")]
      .filter((part) => part.length > 0)
      .join(" · ");
  }

  /** Domains this unit can shoot at, for the "can hit" line. */
  get targetSummary(): string {
    return this.canHit.map((domain) => unitDomainLabels[domain]).join(", ");
  }
}

type UnitData = {
  id: string;
  name: string;
  description: string;
  age: number;
  domain: UnitDomain;
  tags: string[];
  canHit: UnitDomain[];
  bonusVs?: string[];
  hp: number;
  attack: number;
  armor: number;
  range: number;
  speed: number;
  accuracy: number;
  available: boolean;
  costs: { resource: ResourceKey; base: number | string; factor: number }[];
};

const toUnitDefinition = (data: UnitData): UnitDefinition =>
  new UnitDefinition(
    data.id,
    data.name,
    data.description,
    data.age,
    data.domain,
    data.tags,
    data.canHit,
    data.bonusVs ?? [],
    data.available,
    data.costs?.map(({ resource, base, factor }) => ({
      resource,
      base: ExpNumber.from(base),
      factor,
    })) ?? [],
    {
      hp: ExpNumber.fromNumber(data.hp),
      attack: ExpNumber.fromNumber(data.attack),
      armor: data.armor,
      range: data.range,
      speed: data.speed,
      accuracy: data.accuracy,
    },
  );

export const unitDefinitions: UnitDefinition[] = (unitData as UnitData[]).map(
  toUnitDefinition,
);

export const findUnitDefinition = (
  unitId: string,
): UnitDefinition | undefined =>
  unitDefinitions.find(({ key }) => key === unitId);

/** Units the player can ever buy; `false` for enemy-only beasts. */
export const isBuyableUnit = (unit: UnitDefinition): boolean =>
  unit.costs.length > 0;

/**
 * Bonus destinations that target a unit stat (AGENTS.md §13.1/§14). Three
 * scopes, one grammar, so tomorrow's research is pure data:
 *   `hoplite.attack`   — one unit
 *   `tag.ranged.range` — every unit carrying a tag
 *   `unitAll.hp`       — every unit
 */
export type UnitStatTarget =
  | {
      readonly scope: "unit";
      readonly unitId: string;
      readonly stat: UnitStatKey;
    }
  | { readonly scope: "tag"; readonly tag: string; readonly stat: UnitStatKey }
  | { readonly scope: "all"; readonly stat: UnitStatKey };

const unitStatPattern = new RegExp(
  "^([a-z0-9-]+)\\.(hp|attack|armor|range|speed|accuracy)$",
);
const tagStatPattern = new RegExp(
  "^tag\\.([a-z-]+)\\.(hp|attack|armor|range|speed|accuracy)$",
);
const allStatPattern = new RegExp(
  "^unitAll\\.(hp|attack|armor|range|speed|accuracy)$",
);

export const parseUnitStatTarget = (
  destination: string,
): UnitStatTarget | undefined => {
  const all = allStatPattern.exec(destination);
  if (all) return { scope: "all", stat: all[1] as UnitStatKey };

  const tag = tagStatPattern.exec(destination);
  if (tag) return { scope: "tag", tag: tag[1], stat: tag[2] as UnitStatKey };

  const unit = unitStatPattern.exec(destination);
  if (unit && findUnitDefinition(unit[1])) {
    return { scope: "unit", unitId: unit[1], stat: unit[2] as UnitStatKey };
  }
  return undefined;
};

export const unitMatchesStatTarget = (
  unit: UnitDefinition,
  target: UnitStatTarget,
): boolean =>
  target.scope === "all"
    ? true
    : target.scope === "tag"
      ? unit.tags.includes(target.tag)
      : unit.key === target.unitId;

/** Units a destination reaches, so the Gamepedia can link modifiers both ways. */
export const unitsForStatTarget = (target: UnitStatTarget): UnitDefinition[] =>
  unitDefinitions.filter((unit) => unitMatchesStatTarget(unit, target));

export const unitStatTargetLabel = (target: UnitStatTarget): string => {
  const stat = unitStatLabels[target.stat].toLowerCase();
  if (target.scope === "all") return `every unit's ${stat}`;
  if (target.scope === "tag") return `${target.tag} units' ${stat}`;
  return `${findUnitDefinition(target.unitId)?.name ?? target.unitId} ${stat}`;
};

/** Armour is capped below 1: a hit always lands at least some damage. */
export const maximumArmor = 0.9;

/** Effective hit points — armour divides incoming damage, so it multiplies HP. */
export const effectiveHitPoints = (stats: UnitStats): ExpNumber =>
  stats.hp.div(
    ExpNumber.ONE.sub(ExpNumber.fromNumber(Math.min(stats.armor, maximumArmor))),
  );

/**
 * Army power (AGENTS.md §14): `attack × accuracy × √(effective HP)` per unit,
 * summed over stacks by the caller. It is a heuristic — range, speed and domain
 * matchups decide who can shoot whom and are not priced in — but it is monotone
 * in every combat stat and predicts the stack model well under the square law.
 */
export const unitPower = (stats: UnitStats): ExpNumber =>
  stats.attack
    .mul(ExpNumber.fromNumber(stats.accuracy))
    .mul(effectiveHitPoints(stats).pow(0.5));