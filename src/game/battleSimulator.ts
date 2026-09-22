import { ExpNumber } from "./expNumber";
import {
  findUnitDefinition,
  isBuyableUnit,
  unitDefinitions,
  type UnitDefinition,
} from "./units";
import { encounterDefinitions } from "./encounters";
import type { BuildingCost } from "./buildings";
import type { ResourceKey } from "./attributes";

/** Minimum-army simulator (dev tools only): cheapest winning army per battle. */
export type SimulatorArmy = ReadonlyMap<string, number>;
export type SimulatorCostTotal = {
  readonly resource: ResourceKey;
  readonly base: ExpNumber;
};
export type SimulatorResult = {
  readonly composition: SimulatorArmy;
  readonly military: ExpNumber;
  readonly totalCost: readonly SimulatorCostTotal[];
};
export type BattleSimulatorContext = {
  getCost: (unitId: string, count: number) => BuildingCost[];
  wins: (composition: SimulatorArmy, battleId: string) => boolean;
};

/** Buyable units of the battle's age and the previous age. */
export const simulatorCandidates = (battleAge: number): UnitDefinition[] =>
  unitDefinitions.filter(
    (unit) =>
      isBuyableUnit(unit) && unit.age >= battleAge - 1 && unit.age <= battleAge,
  );

const maximumProbe = 10_000_000;
const maximumPasses = 3;

const militaryOf = (costs: readonly SimulatorCostTotal[]): ExpNumber => {
  let total = ExpNumber.ZERO;
  for (const { resource, base } of costs) {
    if (resource === "military") total = total.add(base);
  }
  return total;
};

const sumCosts = (
  composition: SimulatorArmy,
  context: BattleSimulatorContext,
): SimulatorCostTotal[] => {
  const totals = new Map<ResourceKey, ExpNumber>();
  for (const [unitId, count] of composition) {
    for (const { resource, base } of context.getCost(unitId, count)) {
      totals.set(resource, (totals.get(resource) ?? ExpNumber.ZERO).add(base));
    }
  }
  return [...totals.entries()].map(([resource, base]) => ({ resource, base }));
};

const compositionCost = (
  composition: SimulatorArmy,
  context: BattleSimulatorContext,
): ExpNumber => militaryOf(sumCosts(composition, context));

const withCount = (
  composition: SimulatorArmy,
  unitId: string,
  count: number,
): SimulatorArmy => {
  const next = new Map(composition);
  if (count <= 0) next.delete(unitId);
  else next.set(unitId, count);
  return next;
};

/** Cheapest solo winner per unit, then bounded mixed hill-climb, then trim. */
export const solveMinimumArmy = (
  battleId: string,
  candidates: readonly UnitDefinition[],
  context: BattleSimulatorContext,
  requireMixed = false,
): SimulatorResult | null => {
  const battle = encounterDefinitions.find(({ key }) => key === battleId);
  if (!battle) return null;
  let best: SimulatorArmy | null = null;
  let bestCost = ExpNumber.INFINITY;
  for (const unit of candidates) {
    if (!findUnitDefinition(unit.key)) continue;
    let lo = 1;
    let hi = 1;
    while (!context.wins(new Map([[unit.key, hi]]), battle.key)) {
      hi *= 2;
      if (hi > maximumProbe) break;
    }
    if (hi > maximumProbe) continue;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (context.wins(new Map([[unit.key, mid]]), battle.key)) hi = mid;
      else lo = mid + 1;
    }
    const composition = new Map([[unit.key, lo]]);
    const cost = compositionCost(composition, context);
    if (cost.lt(bestCost)) {
      best = composition;
      bestCost = cost;
    }
  }
  // Some battles require complementary roles: neither the siege unit nor the
  // naval unit can win alone, but their combination can. Seed the hill-climb
  // with bounded power-of-two pair searches so those armies are discoverable.
  if (requireMixed && !best) {
      const powers = Array.from({ length: 24 }, (_, index) => 2 ** index);
      for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < candidates.length;
          rightIndex += 1
        ) {
          const left = candidates[leftIndex];
          const right = candidates[rightIndex];
          for (const leftCount of powers) {
            for (const rightCount of powers) {
              const composition = new Map([
                [left.key, leftCount],
                [right.key, rightCount],
              ]);
              if (!context.wins(composition, battle.key)) continue;
              const cost = compositionCost(composition, context);
              if (cost.lt(bestCost)) {
                best = composition;
                bestCost = cost;
              }
            }
          }
        }
      }
  }
  if (!best) return null;
  const ids = candidates.map((unit) => unit.key);
  let improved = true;
  let passes = 0;
  while (improved && passes < maximumPasses) {
    improved = false;
    passes += 1;
    for (const [unitId, count] of [...best]) {
      for (const other of ids) {
        if (other === unitId) continue;
        const base = withCount(best, unitId, Math.ceil(count / 2));
        let add = 1;
        let found = false;
        while (add <= maximumProbe) {
          const trial = withCount(base, other, (base.get(other) ?? 0) + add);
          if (context.wins(trial, battle.key)) {
            found = true;
            break;
          }
          add *= 2;
        }
        if (!found) continue;
        let lo = 1;
        let hi = add;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          const trial = withCount(base, other, (base.get(other) ?? 0) + mid);
          if (context.wins(trial, battle.key)) hi = mid;
          else lo = mid + 1;
        }
        const next = withCount(base, other, (base.get(other) ?? 0) + lo);
        const cost = compositionCost(next, context);
        if (cost.lt(bestCost) && context.wins(next, battle.key)) {
          best = next;
          bestCost = cost;
          improved = true;
        }
      }
    }
  }
  for (const [unitId, count] of [...best]) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (context.wins(withCount(best, unitId, mid), battle.key)) hi = mid;
      else lo = mid + 1;
    }
    best = withCount(best, unitId, lo);
  }
  bestCost = compositionCost(best, context);
  return { composition: best, military: bestCost, totalCost: sumCosts(best, context) };
};
