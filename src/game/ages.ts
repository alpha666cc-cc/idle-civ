import ageData from "./data/ages.json";
import { GameObject } from "./gameObject";
import { parseBonus, type Bonus, isValidBonusDestination } from "./bonus";
import { ExpNumber } from "./expNumber";
import type { ResourceKey } from "./attributes";

/**
 * A per-resource price scale an age imposes from the moment it is entered. This
 * is the inverse of a bonus: where `attributeMultiplier` makes a resource
 * cheaper to earn, this makes it dearer to spend, so an age whose power spike
 * would otherwise trivialise a purchase curve can re-anchor it. Values compose
 * across ages (see `CivilizationState.getResourceCostMultiplier`).
 */
export type ResourceCostMultiplier = {
  resource: ResourceKey;
  factor: ExpNumber;
};

/**
 * The price schedule an age uses for research: `base × factor^((n^exponent) − 1)`,
 * where `n` is the number of research bought *in that age*. `base` is what the
 * age's first tech costs, `factor` how fast the curve climbs within it, and
 * `exponent` how fast the climb itself accelerates (`0.5` reproduces the old
 * square-root curve exactly: the first tech still costs precisely `base`).
 */
export type AgeResearchCost = {
  base: ExpNumber;
  factor: number;
  exponent: number;
};

/** One ordered campaign age with its building target and optional entry bonuses. */
export class AgeDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly buildingThreshold: number;
  readonly unlocks: readonly string[];
  readonly bonuses: readonly Bonus[];
  /** Resource prices this age scales up, applied from the moment it is entered. */
  readonly costMultipliers: readonly ResourceCostMultiplier[];
  /**
   * This age's research price schedule (AGENTS.md §4.5). Research is costed by
   * the age the player is *in*, so entering a new age restarts the curve at its
   * own base and a fresh counter.
   */
  readonly research: AgeResearchCost;

  constructor(
    key: string,
    name: string,
    description: string,
    buildingThreshold: number,
    unlocks: readonly string[] = [],
    bonuses: readonly Bonus[] = [],
    costMultipliers: readonly ResourceCostMultiplier[] = [],
    research: AgeResearchCost = {
      base: ExpNumber.fromNumber(100),
      factor: 10,
      exponent: 0.5,
    },
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.description = description;
    this.buildingThreshold = buildingThreshold;
    this.unlocks = unlocks;
    this.bonuses = bonuses;
    this.costMultipliers = costMultipliers;
    this.research = research;
  }
}

type AgeData = {
  key: string;
  name: string;
  description: string;
  buildingThreshold: number;
  unlocks?: string[];
  bonuses?: {
    type: string;
    destination: string;
    value: number | string;
  }[];
  costMultipliers?: { resource: string; factor: number | string }[];
  research?: { base: number | string; factor: number; exponent?: number };
};

const toAgeDefinition = (data: AgeData): AgeDefinition => {
  const bonuses = (data.bonuses ?? []).map((b) => {
    const destination = String(b.destination);
    if (!isValidBonusDestination(destination)) {
      throw new Error(
        `Unknown age bonus destination: ${data.key} → ${destination}`,
      );
    }
    return parseBonus(b.type, b.destination, b.value);
  });

  return new AgeDefinition(
    data.key,
    data.name,
    data.description,
    data.buildingThreshold,
    data.unlocks ?? [],
    bonuses,
    (data.costMultipliers ?? []).map(({ resource, factor }) => ({
      resource: resource as ResourceKey,
      factor: ExpNumber.from(factor),
    })),
    data.research
      ? {
          base: ExpNumber.from(data.research.base),
          factor: data.research.factor,
          exponent: data.research.exponent ?? 0.5,
        }
      : undefined,
  );
};

export const ageDefinitions: AgeDefinition[] = ageData.map(toAgeDefinition);

export const findAgeDefinition = (ageId: string): AgeDefinition | undefined =>
  ageDefinitions.find(({ key }) => key === ageId);

/** The age that owns a unit, so the engine can retire N-2 units on entry. */
export const ageOfUnit = (unitAge: number): number => unitAge;
