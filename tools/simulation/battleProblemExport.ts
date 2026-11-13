/**
 * Battle-problem export for the offline planner.
 *
 * The browser battle logs are playback artefacts, not solver inputs: they do not
 * carry the candidate roster, cost curves, research set, or pre-formation stats a
 * fresh optimizer needs. This module turns a `CivilizationState` + battle into a
 * self-contained JSON record using the same domain code the game uses, so the
 * Python worker can solve without re-implementing research/cost rules in TS.
 */
import { createHash } from "node:crypto";
import { readdirSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ageDefinitions } from "../../src/game/ages.js";
import type { EncounterDefinition } from "../../src/game/encounters.js";
import { findUnitDefinition } from "../../src/game/units.js";
import { formationDefinitions } from "../../src/game/formations.js";
import { CivilizationState } from "../../src/game/civilizationState.js";
import { simulatorCandidates } from "../../src/game/battleSimulator.js";
import type { CostParameters } from "../../src/game/buyableCost.js";
import type { ArmyStack } from "../../src/game/battle.js";
import type { UnitStats } from "../../src/game/units.js";
import { loadSaveEntry, type SaveEntry } from "./saveEntry.js";

export type SerializedExpNumber = { s: number; m: number; e: number };

export type SerializedUnitStats = {
  hp: SerializedExpNumber;
  attack: SerializedExpNumber;
  armor: number;
  range: number;
  speed: number;
  accuracy: number;
};

export type SerializedCostParameters = {
  resource: string;
  base: SerializedExpNumber;
  factor: number;
  exponent: number;
  unitBase: SerializedExpNumber;
  unitFactor: SerializedExpNumber;
  reductions: {
    base: SerializedExpNumber;
    factor: SerializedExpNumber;
    percent: SerializedExpNumber;
    flat: SerializedExpNumber;
  };
};

export type SerializedArmyStack = {
  unitId: string;
  count: SerializedExpNumber;
  stats: SerializedUnitStats;
  formation?: string;
  order?: string;
  targetDomain?: string;
  targetTag?: string;
};

export type BattleProblemUnit = {
  domain: string;
  canHit: string[];
  bonusVs: string[];
  tags: string[];
};

export type BattleProblemFormation = {
  positionOffset: number;
  movementSpeed: number;
  statBonuses?: readonly {
    attribute: string;
    multiplier?: number;
    additive?: number;
  }[];
  damageTakenVs?: readonly { tag: string; multiplier: number }[];
  damageDealtVs?: readonly { tag: string; multiplier: number }[];
};

export type BattleProblem = {
  schemaVersion: 1;
  rulesVersion: "battle-v1";
  battleId: string;
  battleAge: number;
  baseline: "scratch";
  source: {
    kind: "save" | "state";
    path?: string;
    researchHash: string;
  };
  researchIds: string[];
  candidateIds: string[];
  candidateStats: Record<string, SerializedUnitStats>;
  candidateCosts: Record<string, SerializedCostParameters[]>;
  enemyStacks: SerializedArmyStack[];
  availableFormations: string[];
  availableOrders: string[];
  ownedArmy: [];
  candidateResearchIds: Record<string, string[]>;
  researchCostsByCount: [];
  requireMixed: true;
  maximumRounds: number;
  units: Record<string, BattleProblemUnit>;
  formations: Record<string, BattleProblemFormation>;
  fingerprint: string;
};

const serExp = (value: { sign: number; mantissa: number; exponent: number }): SerializedExpNumber => ({
  s: value.sign,
  m: value.mantissa,
  e: value.exponent,
});

const serStats = (stats: UnitStats): SerializedUnitStats => ({
  hp: serExp(stats.hp),
  attack: serExp(stats.attack),
  armor: stats.armor,
  range: stats.range,
  speed: stats.speed,
  accuracy: stats.accuracy,
});

const serCostParameters = (parameters: readonly CostParameters[]): SerializedCostParameters[] =>
  parameters.map(({ cost, unitBase, unitFactor, reductions }) => ({
    resource: cost.resource,
    base: serExp(cost.base),
    factor: cost.factor,
    exponent: cost.exponent,
    unitBase: serExp(unitBase),
    unitFactor: serExp(unitFactor),
    reductions: {
      base: serExp(reductions.base),
      factor: serExp(reductions.factor),
      percent: serExp(reductions.percent),
      flat: serExp(reductions.flat),
    },
  }));

const serStack = (stack: ArmyStack): SerializedArmyStack => ({
  unitId: stack.unitId,
  count: serExp(stack.count),
  stats: serStats(stack.stats),
  ...(stack.formation ? { formation: stack.formation } : {}),
  ...(stack.order ? { order: stack.order } : {}),
  ...(stack.targetDomain ? { targetDomain: stack.targetDomain } : {}),
  ...(stack.targetTag ? { targetTag: stack.targetTag } : {}),
});

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const researchHashFor = (researchIds: readonly string[]): string =>
  sha256([...researchIds].sort().join(","));

/**
 * Build the scratch-baseline problem for `battle` using `state`'s exact bought
 * research set. Owned units, upgrades, achievements, buildings and encounter
 * progress are deliberately excluded; runtime lookup must verify the live
 * fingerprint before trusting a precomputed plan.
 */
export const battleProblemForState = (
  state: CivilizationState,
  battle: EncounterDefinition,
  source: { kind: "save" | "state"; path?: string } = { kind: "state" },
): BattleProblem => {
  const researchIds = [...new Set(state.boughtResearch)].sort();
  const enteredAges = ageDefinitions
    .slice(0, battle.age)
    .map(({ key }) => key);
  const scratch = new CivilizationState(
    undefined,
    undefined,
    {},
    undefined,
    {},
    0,
    [],
    [],
    enteredAges,
    [],
    undefined,
    {},
    undefined,
    false,
    false,
    false,
    researchIds,
  );

  const candidateIds = simulatorCandidates(battle.age)
    .filter((unit) => scratch.isUnitAvailable(unit.key))
    .map((unit) => unit.key)
    .sort();

  const candidateStats: Record<string, SerializedUnitStats> = {};
  const candidateCosts: Record<string, SerializedCostParameters[]> = {};
  for (const unitId of candidateIds) {
    const stats = scratch.getUnitStatsWithResearch(unitId, []);
    if (!stats) continue;
    candidateStats[unitId] = serStats(stats);
    candidateCosts[unitId] = serCostParameters(scratch.getUnitCostParameters(unitId));
  }

  const enemyStacks = scratch
    .getEnemyStacks(battle.key)
    .map(serStack)
    .sort((left, right) => left.unitId.localeCompare(right.unitId));

  const availableFormations = [...scratch.getAvailableFormations()].sort();
  const availableOrders = [...scratch.getAvailableOrders()].sort();

  const unitIds = new Set([...candidateIds, ...enemyStacks.map(({ unitId }) => unitId)]);
  const units: Record<string, BattleProblemUnit> = {};
  for (const unitId of [...unitIds].sort()) {
    const unit = findUnitDefinition(unitId);
    if (!unit) continue;
    units[unitId] = {
      domain: unit.domain,
      canHit: [...unit.canHit].sort(),
      bonusVs: [...unit.bonusVs].sort(),
      tags: [...unit.tags].sort(),
    };
  }

  const formations: Record<string, BattleProblemFormation> = {};
  for (const formation of formationDefinitions) {
    formations[formation.id] = {
      positionOffset: formation.positionOffset,
      movementSpeed: formation.movementSpeed,
      ...(formation.statBonuses ? { statBonuses: formation.statBonuses } : {}),
      ...(formation.damageTakenVs ? { damageTakenVs: formation.damageTakenVs } : {}),
      ...(formation.damageDealtVs ? { damageDealtVs: formation.damageDealtVs } : {}),
    };
  }

  const researchHash = researchHashFor(researchIds);
  const semantic: Omit<BattleProblem, "fingerprint" | "source"> = {
    schemaVersion: 1,
    rulesVersion: "battle-v1",
    battleId: battle.key,
    battleAge: battle.age,
    baseline: "scratch",
    researchIds,
    candidateIds,
    candidateStats,
    candidateCosts,
    enemyStacks,
    availableFormations,
    availableOrders,
    ownedArmy: [],
    candidateResearchIds: Object.fromEntries(candidateIds.map((id) => [id, []])),
    researchCostsByCount: [],
    requireMixed: true,
    maximumRounds: 101,
    units,
    formations,
  };

  return {
    ...semantic,
    source: { ...source, researchHash },
    fingerprint: `sha256:${sha256(canonicalJson(semantic))}`,
  };
};

export const battleProblemFingerprint = (problem: Omit<BattleProblem, "fingerprint" | "source">): string =>
  `sha256:${sha256(canonicalJson(problem))}`;

const savePathsUnder = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "auto" || entry.name === "battle") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
};

const defaultBattleIds = new Set([
  "age2_1_marathon",
  "age2_boss_gaugamela",
  "age3_2_hastings",
  "age3_boss_castillon",
]);

const parseArgs = (argv: readonly string[]) => {
  const options = {
    battles: new Set<string>(),
    all: false,
    saves: [] as string[],
    output: path.join("sim-output", "battle-problems", "problems.jsonl"),
    root: path.join("saves"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--battle") {
      for (const id of (argv[++index] ?? "").split(",")) {
        if (id) options.battles.add(id);
      }
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--save") {
      options.saves.push(argv[++index] ?? "");
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg === "--root") {
      options.root = argv[++index] ?? options.root;
    } else if (arg === "--help") {
      console.log(
        "Usage: tsx tools/simulation/battleProblemExport.ts [--battle id[,id]] [--all] [--save path]... [--root saves] [--output file]",
      );
      process.exit(0);
    }
  }
  return options;
};

const loadEntries = (options: ReturnType<typeof parseArgs>): SaveEntry[] => {
  const paths = [...options.saves];
  if (paths.length === 0) paths.push(...savePathsUnder(options.root));
  const entries: SaveEntry[] = [];
  const skipped: string[] = [];
  for (const savePath of paths) {
    try {
      entries.push(loadSaveEntry(savePath));
    } catch (error) {
      skipped.push(`${savePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} unreadable save file(s).`);
  }
  return entries;
};

export const collectBattleProblems = (
  options: ReturnType<typeof parseArgs>,
): BattleProblem[] => {
  const useDefault = !options.all && options.battles.size === 0;
  const byFingerprint = new Map<string, BattleProblem>();
  for (const entry of loadEntries(options)) {
    const battle = entry.state.getNextBattle();
    if (!battle) continue;
    const wanted = options.all || useDefault
      ? useDefault
        ? defaultBattleIds.has(battle.key)
        : true
      : options.battles.has(battle.key);
    if (!wanted) continue;
    const problem = battleProblemForState(entry.state, battle, {
      kind: "save",
      path: entry.path,
    });
    byFingerprint.set(problem.fingerprint, problem);
  }
  return [...byFingerprint.values()].sort((left, right) =>
    `${left.battleId}|${left.source.researchHash}`.localeCompare(
      `${right.battleId}|${right.source.researchHash}`,
    ),
  );
};

export const writeProblems = (problems: readonly BattleProblem[], output: string): void => {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, problems.map((problem) => JSON.stringify(problem)).join("\n") + (problems.length ? "\n" : ""), "utf8");
};

export const appendProblem = (problem: BattleProblem, output: string): void => {
  mkdirSync(path.dirname(output), { recursive: true });
  appendFileSync(output, JSON.stringify(problem) + "\n", "utf8");
};

const main = (): void => {
  const options = parseArgs(process.argv.slice(2));
  const problems = collectBattleProblems(options);
  writeProblems(problems, options.output);
  const counts = new Map<string, number>();
  for (const problem of problems) {
    const key = `${problem.battleId} research=${problem.researchIds.length}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`Wrote ${problems.length} battle problem(s) to ${options.output}`);
  for (const [key, count] of [...counts.entries()].sort()) {
    console.log(`  ${key}: ${count}`);
  }
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main();
}
