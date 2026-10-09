import researchData from "./data/research.json";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";
import { findFormationDefinition } from "./formations";
import { parseBonusType, type Bonus, isValidBonusDestination } from "./bonus";
import { findUnitDefinition } from "./units";

/**
 * A one-shot unit upgrade attached to a research: when the tech is bought, every
 * `ratio` owned units of `from` are replaced by one unit of `to`, and the `from`
 * line stops being buyable (an obsolete unit is a permanent conversion, not a
 * second purchase path). The ratio is data, so a future per-pair conversion
 * table only touches the JSON.
 */
export type UnitConversion = {
  readonly from: string;
  readonly to: string;
  readonly ratio: number;
};

/**
 * One node of the technology tree (roadmap Milestone 9). A research is a
 * one-shot buyable: it costs science, permanently applies its bonuses through
 * the shared bonus path, may unlock units, may close an obsolete unit line, and
 * is gated by its prerequisites and its age. Effects the engine cannot express
 * yet are carried on the definition under `ignored` with a reason, so nothing is
 * silently dropped.
 */
export class ResearchDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly age: number;
  readonly category: string;
  readonly prerequisites: readonly string[];
  readonly bonuses: Bonus[];
  readonly unlocks: readonly string[];
  readonly unlocksFormations: readonly string[];
  readonly conversions: readonly UnitConversion[];
  readonly ignored: readonly {
    readonly type: string;
    readonly target: string;
    readonly value: string;
    readonly reason: string;
  }[];

  constructor(
    key: string,
    name: string,
    description: string,
    age: number,
    category: string,
    prerequisites: readonly string[],
    bonuses: Bonus[],
    unlocks: readonly string[],
    unlocksFormations: readonly string[],
    conversions: readonly UnitConversion[],
    ignored: readonly {
      readonly type: string;
      readonly target: string;
      readonly value: string;
      readonly reason: string;
    }[],
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.age = age;
    this.category = category;
    this.prerequisites = prerequisites;
    this.bonuses = bonuses;
    this.unlocks = unlocks;
    this.unlocksFormations = unlocksFormations;
    this.conversions = conversions;
    this.ignored = ignored;
  }
}

type ResearchData = {
  key: string;
  name: string;
  description: string;
  age: number;
  category: string;
  prerequisites: string[];
  bonuses: { type: string; destination: string; value: number | string }[];
  unlocks?: string[];
  unlocksFormations?: string[];
  conversions?: { from: string; to: string; ratio?: number }[];
  ignored?: {
    type: string;
    target: string;
    value: string;
    reason: string;
  }[];
};

/** Flat fallback so a hand-authored pair may omit its rate. */
const defaultConversionRatio = 10;

const toResearchDefinition = (data: ResearchData): ResearchDefinition =>
  new ResearchDefinition(
    data.key,
    data.name,
    data.description,
    data.age,
    data.category,
    [...(data.prerequisites ?? [])],
    (data.bonuses ?? []).map(({ type, destination, value }) => ({
      type: parseBonusType(type),
      destination,
      value: ExpNumber.from(value),
    })),
    [...(data.unlocks ?? [])],
    [...(data.unlocksFormations ?? [])],
    (data.conversions ?? []).map(({ from, to, ratio }) => ({
      from,
      to,
      ratio: ratio ?? defaultConversionRatio,
    })),
    [...(data.ignored ?? [])],
  );

export const researchDefinitions: ResearchDefinition[] = (
  researchData as ResearchData[]
).map(toResearchDefinition);

export const findResearchDefinition = (
  researchId: string,
): ResearchDefinition | undefined =>
  researchDefinitions.find(({ key }) => key === researchId);

/** Researches whose purchase unlocks a unit, for `isUnitAvailable`. */
export const researchesUnlockingUnit = (unitId: string): ResearchDefinition[] =>
  researchDefinitions.filter((research) => research.unlocks.includes(unitId));

/** Researches whose purchase closes (converts away) a unit line. */
export const researchesClosingUnit = (unitId: string): ResearchDefinition[] =>
  researchDefinitions.filter((research) =>
    research.conversions.some((conversion) => conversion.from === unitId),
  );

const prerequisiteClosure = (
  researchId: string,
  seen = new Set<string>(),
): string[] => {
  if (seen.has(researchId)) return [];
  const research = findResearchDefinition(researchId);
  if (!research) return [];
  seen.add(researchId);
  return [
    ...research.prerequisites.flatMap((prerequisite) =>
      prerequisiteClosure(prerequisite, seen),
    ),
    researchId,
  ];
};

const shortestUnlockClosure = (unitId: string): string[] => {
  const paths = researchesUnlockingUnit(unitId).map((research) =>
    prerequisiteClosure(research.key),
  );
  return paths.sort((left, right) => left.length - right.length)[0] ?? [];
};

/** Research and prerequisites needed to unlock the requested unit types. */
export const researchIdsForUnitUnlocks = (
  unitIds: readonly string[],
): string[] => {
  const ids = new Set<string>();
  for (const unitId of unitIds) {
    for (const researchId of shortestUnlockClosure(unitId)) {
      ids.add(researchId);
    }
  }
  return researchDefinitions
    .filter((research) => ids.has(research.key))
    .map((research) => research.key);
};

/**
 * Research applied to an encounter's army: every completed research from an
 * earlier age, the shortest prerequisite path needed to unlock each unit in the
 * army, and every tech from the battle's own age when the enemy is the boss.
 * The result is deterministic and contains no duplicate ids.
 */
export const researchIdsForBattle = (
  battleAge: number,
  unitIds: readonly string[],
  isBoss = false,
): string[] => {
  const ids = new Set(
    researchDefinitions
      .filter(
        (research) =>
          research.age < battleAge || (isBoss && research.age === battleAge),
      )
      .map((research) => research.key),
  );
  for (const unitId of unitIds) {
    for (const researchId of shortestUnlockClosure(unitId)) {
      ids.add(researchId);
    }
  }
  return researchDefinitions
    .filter((research) => ids.has(research.key))
    .map((research) => research.key);
};

export const researchBonusesForIds = (
  researchIds: readonly string[],
): [researchId: string, bonus: Bonus][] =>
  researchIds.flatMap((researchId) =>
    (findResearchDefinition(researchId)?.bonuses ?? []).map(
      (bonus) => [researchId, bonus] as [string, Bonus],
    ),
  );

// Module-load validation: a stale id in the JSON would otherwise no-op
// silently at purchase/reveal time. Fail loudly instead.
const researchIds = new Set(researchDefinitions.map(({ key }) => key));
for (const research of researchDefinitions) {
  for (const prerequisite of research.prerequisites) {
    if (!researchIds.has(prerequisite)) {
      throw new Error(
        `Unknown research prerequisite: ${research.key} → ${prerequisite}`,
      );
    }
  }
  for (const unitId of research.unlocks) {
    if (!findUnitDefinition(unitId)) {
      throw new Error(
        `Unknown research unit unlock: ${research.key} → ${unitId}`,
      );
    }
  }
  for (const formationId of research.unlocksFormations) {
    const formation = findFormationDefinition(formationId);
    if (!formation || formation.researchId !== research.key) {
      throw new Error(
        `Mismatched research formation unlock: ${research.key} → ${formationId}`,
      );
    }
  }
  for (const conversion of research.conversions) {
    if (!findUnitDefinition(conversion.from)) {
      throw new Error(
        `Unknown conversion source: ${research.key} → ${conversion.from}`,
      );
    }
    if (!findUnitDefinition(conversion.to)) {
      throw new Error(
        `Unknown conversion target: ${research.key} → ${conversion.to}`,
      );
    }
    if (conversion.from === conversion.to) {
      throw new Error(`Conversion source equals target: ${research.key}`);
    }
    if (!Number.isFinite(conversion.ratio) || conversion.ratio < 1) {
      throw new Error(
        `Conversion ratio must be a number ≥ 1: ${research.key} → ${conversion.ratio}`,
      );
    }
  }
  for (const bonus of research.bonuses) {
    const destination = String(bonus.destination);
    if (isValidBonusDestination(destination)) continue;
    throw new Error(
      `Unknown research bonus destination: ${research.key} → ${destination}`,
    );
  }
}
