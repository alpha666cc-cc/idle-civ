import encounterData from "./data/encounters.json";
import { parseBonus, type Bonus, isValidBonusDestination } from "./bonus";
import { GameObject } from "./gameObject";
import { findUnitDefinition } from "./units";
import { type FormationId } from "./formations";

/** One enemy stack: how many of a unit stand against the player. */
export type EnemyStack = {
  readonly unitId: string;
  readonly count: number;
  /** Historical scale of the force, e.g. "3k Polish dragoons". */
  readonly label?: string;
  /** Formation for this unit type (Age 2+). Defaults to standard if not set. */
  readonly formation?: FormationId;
};

/**
 * A battle (AGENTS.md §13.4/§14, roadmap Milestone 8). Encounters are ordered:
 * the campaign is a sequence and the engine offers the first battle not yet won.
 * Enemy stat scaling is research-driven; encounter-specific `enemyBoosts` are kept
 * only for compatibility with older data and are ignored in gameplay.
 */
export class EncounterDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly age: number;
  readonly year: number;
  readonly isBoss: boolean;
  readonly historical?: string;
  readonly enemyArmy: EnemyStack[];
  readonly enemyBoosts?: Bonus[];
  readonly bonuses: Bonus[];
  readonly unlocks: readonly string[];

  constructor(
    key: string,
    name: string,
    description: string,
    age: number,
    year: number,
    isBoss: boolean,
    enemyArmy: EnemyStack[],
    enemyBoosts: Bonus[] | undefined,
    bonuses: Bonus[],
    unlocks: readonly string[],
    historical?: string,
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.age = age;
    this.year = year;
    this.isBoss = isBoss;
    this.historical = historical;
    this.enemyArmy = enemyArmy;
    this.enemyBoosts = enemyBoosts;
    this.bonuses = bonuses;
    this.unlocks = unlocks;
  }

  /** Total enemy units committed, for the battle card's summary line. */
  get enemyUnitCount(): number {
    return this.enemyArmy.reduce((total, stack) => total + stack.count, 0);
  }
}

type EncounterData = {
  key: string;
  name: string;
  description: string;
  age: number;
  year: number;
  isBoss: boolean;
  historical?: string;
  enemyArmy: {
    unitId: string;
    count: number;
    label?: string;
    formation?: FormationId;
  }[];
  enemyBoosts?: { type: string; destination: string; value: number }[];
  bonuses: { type: string; destination: string; value: number }[];
  unlocks: string[];
};

const toBonus = (data: {
  type: string;
  destination: string;
  value: number;
}): Bonus => {
  const destination = String(data.destination);
  if (!isValidBonusDestination(destination)) {
    throw new Error(`Unknown encounter bonus destination: ${destination}`);
  }
  return parseBonus(data.type, destination, data.value);
};

const toEncounterDefinition = (data: EncounterData): EncounterDefinition =>
  new EncounterDefinition(
    data.key,
    data.name,
    data.description,
    data.age,
    data.year,
    data.isBoss,
    data.enemyArmy.map(({ unitId, count, label, formation }) => ({
      unitId,
      count,
      label,
      formation,
    })),
    (data.enemyBoosts ?? []).map(toBonus),
    data.bonuses.map(toBonus),
    data.unlocks,
    data.historical,
  );

export const encounterDefinitions: EncounterDefinition[] = (
  encounterData as EncounterData[]
).map(toEncounterDefinition);

export const findEncounterDefinition = (
  encounterId: string,
): EncounterDefinition | undefined =>
  encounterDefinitions.find(({ key }) => key === encounterId);

// A typo in the campaign data would otherwise silently drop a stack or leave a
// unit permanently locked, so fail loudly at import time (as upgrades.ts does).
for (const encounter of encounterDefinitions) {
  for (const stack of encounter.enemyArmy) {
    if (!findUnitDefinition(stack.unitId)) {
      throw new Error(
        `Unknown enemy unit in ${encounter.key}: ${stack.unitId}`,
      );
    }
  }
  for (const unitId of encounter.unlocks) {
    if (!findUnitDefinition(unitId)) {
      throw new Error(`Unknown unlock in ${encounter.key}: ${unitId}`);
    }
  }
}
