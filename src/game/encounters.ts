import encounterData from "./data/encounters.json";
import type { Bonus } from "./bonus";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";

/** A combat encounter whose victory applies data-driven bonuses (roadmap Milestone 8). */
export class EncounterDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly bonuses: Bonus[];

  constructor(key: string, name: string, description: string, bonuses: Bonus[]) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.bonuses = bonuses;
  }
}

type EncounterData = {
  key: string;
  name: string;
  description: string;
  bonuses: {
    type: Bonus["type"];
    destination: string;
    value: number;
  }[];
};

const toEncounterDefinition = (data: EncounterData): EncounterDefinition =>
  new EncounterDefinition(
    data.key,
    data.name,
    data.description,
    data.bonuses.map(({ type, destination, value }) => ({
      type,
      destination,
      value: ExpNumber.fromNumber(value),
    })),
  );

export const encounterDefinitions: EncounterDefinition[] = (
  encounterData as EncounterData[]
).map(toEncounterDefinition);
