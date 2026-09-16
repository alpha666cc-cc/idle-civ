import achievementData from "./data/achievements.json";
import { parseBonusType, type Bonus } from "./bonus";
import { ExpNumber } from "./expNumber";
import { GameObject } from "./gameObject";
import { buildingDefinitions, type BuildingKey } from "./buildings";
import { encounterDefinitions } from "./encounters";
import { findAttributeDefinition, type ResourceKey } from "./attributes";
import { formatNumber } from "./numberFormat";

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
  | { type: "buildings-total"; count: number }
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
  /** Milestone chains group their tiers under one family (§13.4); singletons omit it. */
  readonly family?: string;
  /** Position inside the family; open-ended hoarder tiers use their exponent. */
  readonly tier?: number;

  constructor(
    key: string,
    name: string,
    description: string,
    requirement: AchievementRequirement,
    bonuses: Bonus[] = [],
    family?: string,
    tier?: number,
  ) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.requirement = requirement;
    this.bonuses = bonuses;
    this.family = family;
    this.tier = tier;
  }
}

type AchievementRequirementData =
  | { type: "resource"; resource: ResourceKey; amount: number }
  | { type: "population"; amount: number }
  | { type: "clicks"; amount: number }
  | { type: "building-count"; building: BuildingKey; count: number }
  | { type: "buildings-total"; count: number }
  | { type: "encounter"; encounterId: string }
  | { type: "upgrade-count"; count: number };

type AchievementData = {
  key: string;
  name: string;
  description: string;
  requirement: AchievementRequirementData;
  bonuses?: { type: string; destination: string; value: number }[];
  family?: string;
  tier?: number;
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
    case "buildings-total":
      return { type: "buildings-total", count: data.count };
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
        type: parseBonusType(type),
        destination,
        value: ExpNumber.fromNumber(value),
      })),
      data.family,
      data.tier,
    ),
);

/**
 * Open-ended milestone chains (§13.4): after the concrete tiers in
 * `data/achievements.json` run out, a hoarder chain keeps granting a tier every
 * `exponentStep` powers of ten, forever. Tiers are not authored data — they are
 * materialized from the spec on demand with deterministic, save-stable ids
 * (`<family>-e<exponent>`), so reaching e144654654356 still earns its bonus.
 */
export type OpenEndedHoarderChain = {
  family: string;
  resource: ResourceKey;
  /** First open-ended tier sits at 10^startExponent (the hoarders start at 1e9). */
  startExponent: number;
  /** Tier spacing in powers of ten (every e3 for the hoarders). */
  exponentStep: number;
  label: string;
};

export const openEndedHoarderChains: OpenEndedHoarderChain[] = [
  { family: "food-hoarder", resource: "food", startExponent: 9, exponentStep: 3, label: "Food Hoarder" },
  { family: "wood-hoarder", resource: "wood", startExponent: 9, exponentStep: 3, label: "Wood Hoarder" },
  { family: "stone-hoarder", resource: "stone", startExponent: 9, exponentStep: 3, label: "Stone Hoarder" },
  { family: "gold-hoarder", resource: "gold", startExponent: 9, exponentStep: 3, label: "Gold Hoarder" },
];

const chainForId = (
  id: string,
): { chain: OpenEndedHoarderChain; exponent: number; endExponent: number } | undefined => {
  for (const chain of openEndedHoarderChains) {
    const prefix = `${chain.family}-e`;
    if (!id.startsWith(prefix)) continue;
    const parts = id.slice(prefix.length).split("-through-e");
    if (parts.length > 2) return undefined;
    const exponent = Number(parts[0]);
    const endExponent = Number(parts[1] ?? parts[0]);
    if (![exponent, endExponent].every((value) =>
      Number.isSafeInteger(value) && value >= chain.startExponent &&
      (value - chain.startExponent) % chain.exponentStep === 0,
    ) || endExponent < exponent) return undefined;
    return { chain, exponent, endExponent };
  }
  return undefined;
};

const materializedTiers = new Map<string, AchievementDefinition>();

/** Builds the synthetic achievement tier for an open-ended chain milestone. */
export const materializeOpenEndedTier = (
  chain: OpenEndedHoarderChain,
  exponent: number,
): AchievementDefinition => {
  const key = `${chain.family}-e${exponent}`;
  const cached = materializedTiers.get(key);
  if (cached) return cached;
  const threshold = ExpNumber.fromLog10(exponent);
  const resourceLabel =
    findAttributeDefinition(chain.resource)?.label ?? chain.resource;
  const definition = new AchievementDefinition(
    key,
    chain.label,
    `Hold ${formatNumber(threshold, "named")} ${resourceLabel.toLowerCase()}. Reward: +${exponent} ${resourceLabel.toLowerCase()}/sec.`,
    { type: "resource", resource: chain.resource, amount: threshold },
    [
      {
        type: "attributeFlat",
        destination: chain.resource,
        value: ExpNumber.fromNumber(exponent),
      },
    ],
    chain.family,
    exponent,
  );
  materializedTiers.set(key, definition);
  return definition;
};

/**
 * Resolves any achievement id — concrete data or a materialized open-ended tier —
 * so bonus application and the Gamepedia treat both shapes identically.
 */
export const findAchievementDefinition = (
  id: string,
): AchievementDefinition | undefined => {
  const concrete = achievementDefinitions.find(({ key }) => key === id);
  if (concrete) return concrete;
  const match = chainForId(id);
  if (!match) return undefined;
  if (match.exponent === match.endExponent) {
    return materializeOpenEndedTier(match.chain, match.exponent);
  }
  const cached = materializedTiers.get(id);
  if (cached) return cached;
  const { chain, exponent, endExponent } = match;
  const count = (endExponent - exponent) / chain.exponentStep + 1;
  const reward = ExpNumber.fromNumber(exponent)
    .add(ExpNumber.fromNumber(endExponent))
    .mul(ExpNumber.fromNumber(count))
    .div(ExpNumber.fromNumber(2));
  const definition = new AchievementDefinition(
    id,
    chain.label,
    `Hoarder milestones from 1e${exponent} through 1e${endExponent}. Rewards from every tier are included.`,
    { type: "resource", resource: chain.resource, amount: ExpNumber.fromLog10(endExponent) },
    [{ type: "attributeFlat", destination: chain.resource, value: reward }],
    chain.family,
    endExponent,
  );
  materializedTiers.set(id, definition);
  return definition;
};

/** Next unearned exponent, independent of resources subsequently spent. */
export const nextHoarderExponent = (
  chain: OpenEndedHoarderChain,
  earnedIds: readonly string[],
): number => earnedIds.reduce((next, id) => {
  const match = chainForId(id);
  return match?.chain.family === chain.family
    ? Math.max(next, match.endExponent + chain.exponentStep)
    : next;
}, chain.startExponent);
