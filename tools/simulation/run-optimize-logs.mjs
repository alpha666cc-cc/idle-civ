import { optimizeBattleTactics } from "../../src/game/battleSimulator.js";
import { CivilizationState } from "../../src/game/civilizationState.js";
import { encounterDefinitions } from "../../src/game/encounters.js";
import { researchIdsForBattle } from "../../src/game/research.js";

// Dev-only smoke run: exercise optimizeBattleTactics on the campaign battles
// and print the iteration logs. Run: node --experimental-strip-types tools/simulation/run-optimize-logs.mjs

const state = new CivilizationState();

const simulate = (battleId, composition, formations, orders) => {
  const encounter = encounterDefinitions.find(({ key }) => key === battleId);
  if (!encounter) return false;
  const researchIds = researchIdsForBattle(encounter.age, [
    ...composition.keys(),
  ]);
  const stacks = [];
  for (const [unitId, count] of composition) {
    const stats = state.getUnitStatsWithResearch(unitId, [
      ...new Set([...state.boughtResearch, ...researchIds]),
    ]);
    if (!stats) continue;
    stacks.push({
      unitId,
      count,
      stats,
      formation: formations.get(unitId),
      order: orders.get(unitId),
    });
  }
  if (stacks.length === 0) return false;
  return (
    state.simulateWithStacksOutcome(stacks, state.getEnemyStacks(battleId)) ===
    "player"
  );
};

for (const battle of encounterDefinitions) {
  const candidates = state
    .getRosterUnits()
    .filter(
      (unit) =>
        unit.costs.length > 0 &&
        state.isUnitAvailable(unit.key) &&
        unit.age >= battle.age - 1 &&
        unit.age <= battle.age,
    );
  if (candidates.length === 0) {
    console.log(`[skip] ${battle.key}: no unlocked candidates`);
    continue;
  }
  console.log(`\n===== ${battle.key} (age ${battle.age}) =====`);
  optimizeBattleTactics(
    battle.key,
    candidates,
    {
      getCost: (unitId, count) => state.getUnitCost(unitId, count),
      getResearch: (ids) => state.getResearchForUnitTypes(ids),
      wins: (composition, battleId) =>
        simulate(battleId, composition, new Map(), new Map()),
      winsWithFormations: (composition, formations, battleId) =>
        simulate(battleId, composition, formations, new Map()),
      winsWithFormationsAndOrders: (composition, formations, orders, battleId) =>
        simulate(battleId, composition, formations, orders),
    },
    true,
  );
}

