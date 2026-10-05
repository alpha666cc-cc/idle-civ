/** Scratch: gate outcomes at maximumRounds = 101. */
import { ExpNumber } from "../src/game/expNumber.js";
import { simulateBattleOutcome, simulateBattle } from "../src/game/battle.js";
import { CivilizationState } from "../src/game/civilizationState.js";

const state = new CivilizationState();
const army = (list: [string, number][]) =>
  list.map(([unitId, count]) => {
    const stats = state.getUnitStats(unitId);
    if (!stats) throw new Error("unknown " + unitId);
    return { unitId, count: ExpNumber.fromNumber(count), stats };
  });

const enemy = state.getEnemyStacks("age0_2_wolf_pack");
console.log("canoe threshold at maxRounds=101:");
for (const n of [7, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32]) {
  const sim = simulateBattle(army([["canoe", n]]), enemy);
  console.log(
    `  x${String(n).padStart(2)}  ${sim.outcome.padEnd(10)} ${sim.rounds.length} rounds`,
  );
}
console.log("mixed + hulls:");
for (const c of [10, 16, 20, 24, 30, 40]) {
  const sim = simulateBattle(
    army([["warrior", 15], ["slinger", 12], ["canoe", c]]),
    enemy,
  );
  console.log(`  15w+12s+${c}canoe  ${sim.outcome.padEnd(10)} ${sim.rounds.length} rounds`);
}
