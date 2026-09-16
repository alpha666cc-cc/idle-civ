import statData from "./data/stats.json";
import { GameObject } from "./gameObject";

/**
 * A computed value the engine derives from state (AGENTS.md §13.2 decision 2):
 * click power and automated click power. Stats are never stored — they are read
 * through `CivilizationState.getStatValue()` and modified through bonuses whose
 * destination is the stat id, so `+1 per click` is an ordinary `resourceFlat`
 * bonus on `clickPower` and `×2 click power` is a `resourceMultiplier` bonus.
 */
export type StatKind = "clickPower" | "autoClickRate";

export class StatDefinition extends GameObject {
  readonly key: string;
  readonly name: string;
  readonly kind: StatKind;

  constructor(key: string, name: string, kind: StatKind, description: string) {
    super(key, description);
    this.key = key;
    this.name = name;
    this.kind = kind;
  }
}

type StatData = {
  key: string;
  name: string;
  kind: StatKind;
  description: string;
};

export const statDefinitions: StatDefinition[] = (statData as StatData[]).map(
  (data) => new StatDefinition(data.key, data.name, data.kind, data.description),
);

/** The stat a bonus destination refers to, or undefined for a resource/buyable id. */
export const findStatDefinition = (id: string): StatDefinition | undefined =>
  statDefinitions.find(({ key }) => key === id);