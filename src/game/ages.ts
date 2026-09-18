import ageData from "./data/ages.json";
import { GameObject } from "./gameObject";

/** One age in the campaign: a population band with a name and optional unlocks. */
export class AgeDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly populationThreshold: number;
  readonly unlocks: readonly string[];

  constructor(
    key: string,
    name: string,
    description: string,
    populationThreshold: number,
    unlocks: readonly string[] = [],
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.description = description;
    this.populationThreshold = populationThreshold;
    this.unlocks = unlocks;
  }
}

type AgeData = {
  key: string;
  name: string;
  description: string;
  populationThreshold: number;
  unlocks?: string[];
};

const toAgeDefinition = (data: AgeData): AgeDefinition =>
  new AgeDefinition(
    data.key,
    data.name,
    data.description,
    data.populationThreshold,
    data.unlocks ?? [],
  );

export const ageDefinitions: AgeDefinition[] = ageData.map(toAgeDefinition);

export const findAgeDefinition = (
  ageId: string,
): AgeDefinition | undefined =>
  ageDefinitions.find(({ key }) => key === ageId);

/** The age that owns a unit, so the engine can retire N-2 units on entry. */
export const ageOfUnit = (unitAge: number): number => unitAge;