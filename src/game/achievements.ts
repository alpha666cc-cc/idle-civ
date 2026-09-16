import achievementData from "./data/achievements.json";
import type { Bonus } from "./bonus";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";
import { buildingDefinitions, type BuildingKey } from "./buildings";
import { encounterDefinitions } from "./encounters";
import type { ResourceKey } from "./resources";

/**
 * Achievement requirements are data-driven and evaluated by the engine
 * (roadmap Milestone 6). Achievements are permanent historical records
 * (AGENTS.md §13.4): they never carry unlock lists and never reset, so the
 * engine stores their ids and nothing else.
 */
export type AchievementRequirement =
  | { type: "resource"; resource: ResourceKey; amount: ExpNumber }
  | { type: "population"; amount: ExpNumber }
  | { type: "clicks"; amount: ExpNumber }
  | { type: "building-count"; building: BuildingKey; count: number }
  | { type: "encounter"; encounterId: string }
  | { type: "upgrade-count"; count: number };

/**
 * An achievement is a permanent record, but it may still carry a **reward**: a
 * bonus list applied for as long as the achievement is earned (AGENTS.md §13.1,
 * §13.4 — rewards are bonuses, only *unlock lists* stay off achievements).
 */
export class AchievementDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly requirement: AchievementRequirement;
  readonly bonuses: Bonus[];

  constructor(
    key: string,
    name: string,
    description: string,
    requirement: AchievementRequirement,
    bonuses: Bonus[] = [],
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.requirement = requirement;
    this.bonuses = bonuses;
  }
}

type AchievementRequirementData =
  | { type: "resource"; resource: ResourceKey; amount: number }
  | { type: "population"; amount: number }
  | { type: "clicks"; amount: number }
  | { type: "building-count"; building: BuildingKey; count: number }
  | { type: "encounter"; encounterId: string }
  | { type: "upgrade-count"; count: number };

type AchievementData = {
  key: string;
  name: string;
  description: string;
  requirement: AchievementRequirementData;
  bonuses?: { type: Bonus["type"]; destination: string; value: number }[];
};

const toRequirement = (
  data: AchievementRequirementData,
): AchievementRequirement => {
  switch (data.type) {
    case "resource":
      return {
        type: "resource",
        resource: data.resource,
        amount: ExpNumber.fromNumber(data.amount),
      };
    case "population":
      return { type: "population", amount: ExpNumber.fromNumber(data.amount) };
    case "clicks":
      return { type: "clicks", amount: ExpNumber.fromNumber(data.amount) };
    case "building-count":
      return {
        type: "building-count",
        building: data.building,
        count: data.count,
      };
    case "encounter":
      return { type: "encounter", encounterId: data.encounterId };
    case "upgrade-count":
      return { type: "upgrade-count", count: data.count };
  }
};

for (const data of achievementData as AchievementData[]) {
  const { requirement } = data;
  if (
    requirement.type === "building-count" &&
    !buildingDefinitions.some(({ key }) => key === requirement.building)
  ) {
    throw new Error(`Unknown achievement building: ${requirement.building}`);
  }
  if (
    requirement.type === "encounter" &&
    !encounterDefinitions.some(({ key }) => key === requirement.encounterId)
  ) {
    throw new Error(`Unknown achievement encounter: ${requirement.encounterId}`);
  }
}

export const achievementDefinitions: AchievementDefinition[] = (
  achievementData as AchievementData[]
).map(
  (data) =>
    new AchievementDefinition(
      data.key,
      data.name,
      data.description,
      toRequirement(data.requirement),
      (data.bonuses ?? []).map(({ type, destination, value }) => ({
        type,
        destination,
        value: ExpNumber.fromNumber(value),
      })),
    ),
);
