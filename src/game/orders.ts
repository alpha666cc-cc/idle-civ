import { GameObject } from "./gameObject";
import ordersJson from "./data/orders.json";

export type OrderId =
  | "standard"
  | "focus_weak"
  | "focus_strong"
  | "focus_counter"
  | "same_tag"
  | "protect_ranged";

export type OrderDefinitionData = {
  readonly id: OrderId;
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

export const orderDefinitions = ordersJson.map(
  (def) => new OrderDefinition_(def as OrderDefinitionData),
) as readonly OrderDefinition_[];

export const findOrderDefinition = (id: string): OrderDefinition_ | undefined =>
  orderDefinitions.find((def) => def.id === id);

export const ordersForAge = (ageIndex: number): readonly OrderId[] => {
  return orderDefinitions
    .filter((def) => def.unlockAge <= ageIndex)
    .map((def) => def.id as OrderId);
};

export const DEFAULT_ORDER: OrderId = "standard";

export const orderIds: readonly OrderId[] = orderDefinitions.map(
  (def) => def.id as OrderId,
);

export type OrderDefinition = OrderDefinition_;
