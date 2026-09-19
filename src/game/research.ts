import researchData from "./data/research.json";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";
import { buildingDefinitions, type BuildingCost } from "./buildings";
import { parseBonusType, type Bonus } from "./bonus";
import {
  findAttributeDefinition,
  type ResourceKey,
} from "./attributes";
import { findUnitDefinition, parseUnitStatTarget } from "./units";

/**
 * One node of the technology tree (roadmap Milestone 9). A research is a
 * one-shot buyable: it costs science, permanently applies its bonuses through
 * the shared bonus path, may unlock units, and is gated by its prerequisites
 * and its age. Effects the engine cannot express yet are carried on the
 * definition under `ignored` with a reason, so nothing is silently dropped.
 */
export class ResearchDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly age: number;
  readonly category: string;
  readonly prerequisites: readonly string[];
  readonly costs: BuildingCost[];
  readonly bonuses: Bonus[];
  readonly unlocks: readonly string[];
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
    costs: BuildingCost[],
    bonuses: Bonus[],
    unlocks: readonly string[],
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
    this.costs = costs;
    this.bonuses = bonuses;
    this.unlocks = unlocks;
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
  costs: { resource: ResourceKey; base: number | string; factor: number }[];
  bonuses: { type: string; destination: string; value: number | string }[];
  unlocks?: string[];
  ignored?: {
    type: string;
    target: string;
    value: string;
    reason: string;
  }[];
};

const toResearchDefinition = (data: ResearchData): ResearchDefinition =>
  new ResearchDefinition(
    data.key,
    data.name,
    data.description,
    data.age,
    data.category,
    [...(data.prerequisites ?? [])],
    (data.costs ?? []).map(({ resource, base, factor }) => ({
      resource,
      base: ExpNumber.from(base),
      factor,
    })),
    (data.bonuses ?? []).map(({ type, destination, value }) => ({
      type: parseBonusType(type),
      destination,
      value: ExpNumber.from(value),
    })),
    [...(data.unlocks ?? [])],
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
      throw new Error(`Unknown research unit unlock: ${research.key} → ${unitId}`);
    }
  }
  for (const bonus of research.bonuses) {
    const destination = String(bonus.destination);
    if (destination === "all-production") continue;
    if (parseUnitStatTarget(destination)) continue;
    if (findAttributeDefinition(destination)) continue;
    if (buildingDefinitions.some(({ key }) => key === destination)) continue;
    // Cost reductions may target a unit id (§13.3: units are buyables).
    if (findUnitDefinition(destination)) continue;
    throw new Error(
      `Unknown research bonus destination: ${research.key} → ${destination}`,
    );
  }
}
