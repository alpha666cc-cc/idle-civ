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

export const orderDefinitions: readonly OrderDefinitionData[] = ordersJson as OrderDefinitionData[];

export const findOrderDefinition = (id: string): OrderDefinitionData | undefined =>
  orderDefinitions.find((def) => def.id === id);

export const ordersForAge = (ageIndex: number): readonly OrderId[] => {
  return orderDefinitions
    .filter((def) => def.unlockAge <= ageIndex)
    .map((def) => def.id);
};

export const DEFAULT_ORDER: OrderId = "standard";

export const orderIds: readonly OrderId[] = orderDefinitions.map((def) => def.id);
