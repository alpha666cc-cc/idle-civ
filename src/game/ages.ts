import ageData from "./data/ages.json";
import { GameObject } from "./gameObject";
import { parseBonus, type Bonus } from "./bonus";

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

  constructor(
    key: string,
    name: string,
    description: string,
    populationThreshold: number,
    unlocks: readonly string[] = [],
    bonuses: readonly Bonus[] = [],
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.description = description;
    this.populationThreshold = populationThreshold;
    this.unlocks = unlocks;
    this.bonuses = bonuses;
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
};

const toAgeDefinition = (data: AgeData): AgeDefinition =>
  new AgeDefinition(
    data.key,
    data.name,
    data.description,
    data.populationThreshold,
    data.unlocks ?? [],
    (data.bonuses ?? []).map((b) => parseBonus(b.type, b.destination, b.value)),
  );

export const ageDefinitions: AgeDefinition[] = ageData.map(toAgeDefinition);

export const findAgeDefinition = (
  ageId: string,
): AgeDefinition | undefined =>
  ageDefinitions.find(({ key }) => key === ageId);

/** The age that owns a unit, so the engine can retire N-2 units on entry. */
export const ageOfUnit = (unitAge: number): number => unitAge;