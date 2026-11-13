/**
 * Cross-language parity check for offline battle plans.
 *
 * Reads exported problems + Python plans, rebuilds the same ArmyStack inputs the
 * solver used, runs the authoritative TypeScript simulator, and compares the
 * outcome/survivors and military cost recorded by the Python worker.
 */
import { readFileSync } from "node:fs";
import { ExpNumber } from "../../src/game/expNumber.js";
import { calculateCostSeries, type CostParameters } from "../../src/game/buyableCost.js";
import { simulateBattleSummary, type ArmyStack } from "../../src/game/battle.js";
import type { SerializedExpNumber, SerializedUnitStats, SerializedCostParameters, SerializedArmyStack, BattleProblem } from "./battleProblemExport.js";

type BattlePlan = {
  fingerprint: string;
  battleId: string;
  proofStatus: string;
  plan?: {
    composition: Record<string, number>;
    totalComposition: Record<string, number>;
    military: SerializedExpNumber;
    totalCost: { resource: string; base: SerializedExpNumber }[];
    formations: Record<string, string>;
    orders: Record<string, string>;
    battle: {
      outcome: string;
      playerSurvivors: SerializedExpNumber;
      enemySurvivors: SerializedExpNumber;
    };
  };
  searchStats?: Record<string, number>;
};

const deserExp = (value: SerializedExpNumber): ExpNumber =>
  new ExpNumber(value.s, value.m, value.e);

const deserStats = (value: SerializedUnitStats) => ({
  hp: deserExp(value.hp),
  attack: deserExp(value.attack),
  armor: value.armor,
  range: value.range,
  speed: value.speed,
  accuracy: value.accuracy,
});

const deserStack = (stack: SerializedArmyStack): ArmyStack => ({
  unitId: stack.unitId,
  count: deserExp(stack.count),
  stats: deserStats(stack.stats),
  ...(stack.formation ? { formation: stack.formation as ArmyStack["formation"] } : {}),
  ...(stack.order ? { order: stack.order as ArmyStack["order"] } : {}),
  ...(stack.targetDomain ? { targetDomain: stack.targetDomain as ArmyStack["targetDomain"] } : {}),
  ...(stack.targetTag ? { targetTag: stack.targetTag } : {}),
});

const deserCostParameters = (
  parameters: readonly SerializedCostParameters[],
): CostParameters[] =>
  parameters.map((param) => ({
    cost: {
      resource: param.resource as CostParameters["cost"]["resource"],
      base: deserExp(param.base),
      factor: param.factor,
      exponent: param.exponent,
    },
    unitBase: deserExp(param.unitBase),
    unitFactor: deserExp(param.unitFactor),
    reductions: {
      base: deserExp(param.reductions.base),
      factor: deserExp(param.reductions.factor),
      percent: deserExp(param.reductions.percent),
      flat: deserExp(param.reductions.flat),
    },
  }));

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);

const expClose = (left: SerializedExpNumber, right: SerializedExpNumber): boolean => {
  const a = deserExp(left);
  const b = deserExp(right);
  if (a.isZero && b.isZero) return true;
  const ratio = a.div(b).toNumber();
  return Number.isFinite(ratio) && Math.abs(ratio - 1) <= 1e-9;
};

const main = (): void => {
  const args = process.argv.slice(2);
  const argValue = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  const problemsPath = argValue("--problems", "sim-output/battle-problems/problems.jsonl");
  const plansPath = argValue("--plans", "sim-output/battle-plans/plans.jsonl");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Number.POSITIVE_INFINITY;

  const problems = new Map(readJsonl<BattleProblem>(problemsPath).map((p) => [p.fingerprint, p]));
  const plans = readJsonl<BattlePlan>(plansPath);
  let checked = 0;
  let mismatches = 0;

  for (const plan of plans) {
    if (checked >= limit) break;
    const problem = problems.get(plan.fingerprint);
    if (!problem || !plan.plan) {
      console.log(`SKIP ${plan.battleId}: missing problem or plan`);
      continue;
    }
    checked += 1;
    const player: ArmyStack[] = Object.entries(plan.plan.composition).map(
      ([unitId, count]) => ({
        unitId,
        count: ExpNumber.fromNumber(count),
        stats: deserStats(problem.candidateStats[unitId]),
        formation: plan.plan!.formations[unitId] as ArmyStack["formation"],
        order: plan.plan!.orders[unitId] as ArmyStack["order"],
      }),
    );
    const enemy = problem.enemyStacks.map(deserStack);
    const summary = simulateBattleSummary(player, enemy);
    const outcomeOk = summary.outcome === plan.plan.battle.outcome;
    const playerOk = expClose(
      { s: summary.playerSurvivors.sign, m: summary.playerSurvivors.mantissa, e: summary.playerSurvivors.exponent },
      plan.plan.battle.playerSurvivors,
    );
    const enemyOk = expClose(
      { s: summary.enemySurvivors.sign, m: summary.enemySurvivors.mantissa, e: summary.enemySurvivors.exponent },
      plan.plan.battle.enemySurvivors,
    );

    let military = ExpNumber.ZERO;
    for (const [unitId, count] of Object.entries(plan.plan.composition)) {
      for (const cost of calculateCostSeries(
        deserCostParameters(problem.candidateCosts[unitId] ?? []),
        ExpNumber.ZERO,
        ExpNumber.fromNumber(count),
      )) {
        if (cost.resource === "military") military = military.add(cost.base);
      }
    }
    const militaryOk = expClose(
      { s: military.sign, m: military.mantissa, e: military.exponent },
      plan.plan.military,
    );

    if (!outcomeOk || !playerOk || !enemyOk || !militaryOk) {
      mismatches += 1;
      console.log(`MISMATCH ${plan.battleId} ${plan.fingerprint.slice(0, 18)}`);
      console.log(`  outcome ts=${summary.outcome} py=${plan.plan.battle.outcome}`);
      console.log(
        `  survivors ts=${summary.playerSurvivors.toString()}/${summary.enemySurvivors.toString()} ` +
          `py=${JSON.stringify(plan.plan.battle.playerSurvivors)}/${JSON.stringify(plan.plan.battle.enemySurvivors)}`,
      );
      console.log(
        `  military ts=${military.toString()} py=${JSON.stringify(plan.plan.military)}`,
      );
    } else {
      console.log(`OK ${plan.battleId} ${plan.fingerprint.slice(0, 18)} sims=${plan.searchStats?.simulations ?? "?"}`);
    }
  }

  console.log(`Checked ${checked} plan(s); mismatches=${mismatches}`);
  if (mismatches > 0) process.exit(1);
};

main();
