import ageData from "./data/ages.json";
import { GameObject } from "./gameObject";
import { parseBonus, type Bonus } from "./bonus";
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

/** One age in the campaign: a population band with a name, optional unlocks, and
 * optional data-driven bonuses applied on entry (AGENTS.md §13.4). Bonuses reuse the
 * existing factor model (`attributeFlat`/`attributeMultiplier`/`attributeDrain`) and the
 * cost-reduction pipeline, so age awards are just another bonus source alongside upgrades,
 * encounters, research and achievements. */
export class AgeDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly populationThreshold: number;
  readonly unlocks: readonly string[];
  readonly bonuses: readonly Bonus[];
  /** Resource prices this age scales up, applied from the moment it is entered. */
  readonly costMultipliers: readonly ResourceCostMultiplier[];

  constructor(
    key: string,
    name: string,
    description: string,
    populationThreshold: number,
    unlocks: readonly string[] = [],
    bonuses: readonly Bonus[] = [],
    costMultipliers: readonly ResourceCostMultiplier[] = [],
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.description = description;
    this.populationThreshold = populationThreshold;
    this.unlocks = unlocks;
    this.bonuses = bonuses;
    this.costMultipliers = costMultipliers;
  }
}

type AgeData = {
  key: string;
  name: string;
  description: string;
  populationThreshold: number;
  unlocks?: string[];
  bonuses?: {
    type: string;
    destination: string;
    value: number | string;
  }[];
  costMultipliers?: { resource: string; factor: number | string }[];
};

const toAgeDefinition = (data: AgeData): AgeDefinition =>
  new AgeDefinition(
    data.key,
    data.name,
    data.description,
    data.populationThreshold,
    data.unlocks ?? [],
    (data.bonuses ?? []).map((b) => parseBonus(b.type, b.destination, b.value)),
    (data.costMultipliers ?? []).map(({ resource, factor }) => ({
      resource: resource as ResourceKey,
      factor: ExpNumber.from(factor),
    })),
  );

export const ageDefinitions: AgeDefinition[] = ageData.map(toAgeDefinition);

export const findAgeDefinition = (
  ageId: string,
): AgeDefinition | undefined =>
  ageDefinitions.find(({ key }) => key === ageId);

/** The age that owns a unit, so the engine can retire N-2 units on entry. */
export const ageOfUnit = (unitAge: number): number => unitAge;