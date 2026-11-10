import { GameObject } from "./gameObject";
import ordersJson from "./data/orders.json";

export type OrderId =
  | "focus_weak"
  | "focus_strong"
  | "focus_counter"
  | "protect_ranged";

export type TargetingCapabilityId = "target_domain" | "tag_focus";

export type OrderDefinitionData = {
  readonly id: OrderId;
  readonly name: string;
  readonly description: string;
  readonly unlockAge: number;
};

export type TargetingCapabilityDefinition = {
  readonly id: TargetingCapabilityId;
  readonly name: string;
  readonly description: string;
  readonly unlockAge: number;
};

class OrderDefinition_ extends GameObject {
  readonly name: string;
  readonly unlockAge: number;

  constructor(def: OrderDefinitionData) {
    super(def.id as string, def.description);
    this.name = def.name;
    this.unlockAge = def.unlockAge;
  }
}

const isTargetingCapabilityId = (
  id: string,
): id is TargetingCapabilityId =>
  id === "target_domain" || id === "tag_focus";

const isOrderId = (id: string): id is OrderId =>
  id === "focus_weak" ||
  id === "focus_strong" ||
  id === "focus_counter" ||
  id === "protect_ranged";

export const orderDefinitions = ordersJson
  .filter((def) => isOrderId(def.id))
  .map((def) => new OrderDefinition_(def as OrderDefinitionData));

export const targetingCapabilityDefinitions =
  ordersJson.filter(
    (def) => isTargetingCapabilityId(def.id),
  ) as readonly TargetingCapabilityDefinition[];

export const findOrderDefinition = (id: string): OrderDefinition_ | undefined =>
  orderDefinitions.find((def) => def.id === id);

export const ordersForAge = (ageIndex: number): readonly OrderId[] => {
  return orderDefinitions
    .filter((def) => def.unlockAge <= ageIndex)
    .map((def) => def.id as OrderId);
};

export const targetingCapabilitiesForAge = (
  ageIndex: number,
): readonly TargetingCapabilityId[] =>
  targetingCapabilityDefinitions
    .filter((def) => def.unlockAge <= ageIndex)
    .map((def) => def.id);

export const DEFAULT_ORDER: OrderId = "focus_weak";

export const orderIds: readonly OrderId[] = orderDefinitions.map(
  (def) => def.id as OrderId,
);

export type OrderDefinition = OrderDefinition_;
