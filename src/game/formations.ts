import { GameObject } from "./gameObject";
import formationData from "./data/formations.json";

/**
 * Battle formations (positioning + stat trades).
 *
 * A formation is per unit type, controlling:
 * - Position offset: how far forward/back the unit stands relative to army front
 * - Movement speed: how fast this unit pushes the line closed
 * - Stat bonuses: trades (e.g., +hp, -attack for defensive formations)
 *
 * Formations unlock at Age 2 entry (Standard, Frontline, Backline).
 * Advanced formations (Rush, Turtle, etc.) are research unlocks.
 *
 * Age 0/1 compatibility: no formation effects apply before Age 2, so existing
 * battles resolve identically.
 */

export type FormationId =
  | "standard"
  | "frontline"
  | "backline"
  | "rush"
  | "turtle"
  | "skirmish"
  | "shield_wall"
  | "pike_square";

export type FormationDefinitionData = {
  readonly id: FormationId;
  readonly name: string;
  readonly description: string;
  readonly unlockAge: number; // Age at which this formation is available (entry or research)
  readonly unlockType: "age_entry" | "research";
  readonly researchId?: string; // If unlockType is "research", which tech unlocks it

  // Position offset: negative = forward (frontline), positive = back (backline)
  readonly positionOffset: number;

  // Movement speed: how fast this unit pushes the line closed
  readonly movementSpeed: number;

  // Stat bonuses: optional trades (e.g., +hp, -attack)
  readonly statBonuses?: readonly {
    readonly attribute: string;
    readonly multiplier: number;
  }[];

  // Damage taken from attackers carrying a given tag, as a multiplier on
  // incoming damage (e.g. Turtle shields against `ranged` fire).
  readonly damageTakenVs?: readonly {
    readonly tag: string;
    readonly multiplier: number;
  }[];

  // Damage dealt to targets carrying a given tag, as a multiplier on outgoing
  // damage (e.g. Pike Square spears cavalry).
  readonly damageDealtVs?: readonly {
    readonly tag: string;
    readonly multiplier: number;
  }[];
};

class FormationDefinition_ extends GameObject {
  readonly name: string;
  readonly unlockAge: number;
  readonly unlockType: "age_entry" | "research";
  readonly researchId?: string;
  readonly positionOffset: number;
  readonly movementSpeed: number;
  readonly statBonuses?: readonly {
    readonly attribute: string;
    readonly multiplier: number;
  }[];
  readonly damageTakenVs?: readonly {
    readonly tag: string;
    readonly multiplier: number;
  }[];
  readonly damageDealtVs?: readonly {
    readonly tag: string;
    readonly multiplier: number;
  }[];

  constructor(def: FormationDefinitionData) {
    super(def.id as string, def.description);
    this.name = def.name;
    this.unlockAge = def.unlockAge;
    this.unlockType = def.unlockType;
    this.researchId = def.researchId;
    this.positionOffset = def.positionOffset;
    this.movementSpeed = def.movementSpeed;
    this.statBonuses = def.statBonuses;
    this.damageTakenVs = def.damageTakenVs;
    this.damageDealtVs = def.damageDealtVs;
  }
}

export const formationDefinitions = formationData.map(
  (def) => new FormationDefinition_(def as FormationDefinitionData),
) as readonly FormationDefinition_[];

export const findFormationDefinition = (
  id: FormationId | string,
): FormationDefinition_ | undefined =>
  formationDefinitions.find((f) => f.id === id);

export const formationIds = formationDefinitions.map(
  (f) => f.id as FormationId,
) as readonly FormationId[];

export type FormationDefinition = FormationDefinition_;

/**
 * Get formations available at a given age (entry unlocks only).
 * Research-unlocked formations are not included here.
 */
export const formationsForUnlocks = (
  ageIndex: number,
  boughtResearch: readonly string[],
): readonly FormationId[] =>
  formationDefinitions
    .filter(
      (formation) =>
        formation.unlockAge <= ageIndex &&
        (formation.unlockType === "age_entry" ||
          (formation.researchId !== undefined &&
            boughtResearch.includes(formation.researchId))),
    )
    .map((formation) => formation.id as FormationId);

/**
 * Default formation for a unit type when none is set.
 */
export const DEFAULT_FORMATION: FormationId = "standard";
