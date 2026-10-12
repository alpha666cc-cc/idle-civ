import { ExpNumber } from "./expNumber";
import { type FormationId } from "./formations";
import {
  simulateBattle,
  type ArmyStack,
  type BattleOutcome,
  type BattleSimulation,
} from "./battle";

/**
 * Formation optimizer (AGENTS.md §14 extension).
 *
 * After Age 1, automatically finds the best formation layout for a battle
 * using a smart search algorithm (hill climbing with random restarts) rather
 * than brute-forcing the full 2^N combination space.
 *
 * Optimization criteria (in order):
 * 1. Win > stalemate > loss
 * 2. Among wins: maximize survivors (minimize losses)
 *
 * Age 0/1 compatibility: optimizer only runs when formations are available
 * (Age 2+), so early game is unaffected.
 */

export type FormationAssignment = Record<string, FormationId>;

export type OptimizationResult = {
  readonly bestAssignments: FormationAssignment;
  readonly bestOutcome: BattleOutcome;
  readonly bestEnemySurvivors: ExpNumber;
  readonly iterations: number;
  readonly converged: boolean;
};

/**
 * Evaluate a formation assignment for a given battle.
 * Returns the battle simulation with those formations applied.
 */
const evaluateAssignments = (
  playerStacks: readonly ArmyStack[],
  enemyStacks: readonly ArmyStack[],
  assignments: FormationAssignment,
): BattleSimulation => {
  const modifiedStacks = playerStacks.map((stack) => ({
    ...stack,
    formation: assignments[stack.unitId] ?? "standard",
  }));
  return simulateBattle(modifiedStacks, enemyStacks);
};

/**
 * Hill climbing with random restarts to find optimal formations.
 *
 * Strategy:
 * 1. Start with current formations (or random if none)
 * 2. Try changing one unit's formation at a time
 * 3. Keep changes that improve the outcome (win > stalemate > loss)
 * 4. Among wins, prefer configurations with fewer enemy survivors (more complete victory)
 * 5. If stuck, random restart
 * 6. Converge when no improvement found after max iterations
 *
 * This avoids brute force (2^9 to 2^21 combinations) by exploiting local optima.
 */
export const optimizeFormations = (
  playerStacks: readonly ArmyStack[],
  enemyStacks: readonly ArmyStack[],
  currentAssignments: FormationAssignment,
  availableFormations: readonly FormationId[],
  options: {
    maxIterations?: number;
    maxRestarts?: number;
    convergenceThreshold?: number;
  } = {},
): OptimizationResult => {
  const {
    maxIterations = 100,
    maxRestarts = 5,
    convergenceThreshold = 10,
  } = options;

  if (availableFormations.length <= 1) {
    // No optimization possible with only one formation
    const sim = evaluateAssignments(
      playerStacks,
      enemyStacks,
      currentAssignments,
    );
    return {
      bestAssignments: currentAssignments,
      bestOutcome: sim.outcome,
      bestEnemySurvivors: sim.enemySurvivors,
      iterations: 0,
      converged: true,
    };
  }

  const unitIds = playerStacks.map((s) => s.unitId);
  if (unitIds.length === 0) {
    const sim = evaluateAssignments(
      playerStacks,
      enemyStacks,
      currentAssignments,
    );
    return {
      bestAssignments: currentAssignments,
      bestOutcome: sim.outcome,
      bestEnemySurvivors: sim.enemySurvivors,
      iterations: 0,
      converged: true,
    };
  }

  // Outcome ranking: player win > stalemate > enemy win
  const outcomeScore = (outcome: BattleOutcome): number => {
    switch (outcome) {
      case "player":
        return 2;
      case "stalemate":
        return 1;
      case "enemy":
        return 0;
    }
  };

  // Compare two simulations: better outcome wins, or if equal, fewer enemy survivors wins
  const isBetter = (a: BattleSimulation, b: BattleSimulation): boolean => {
    const scoreA = outcomeScore(a.outcome);
    const scoreB = outcomeScore(b.outcome);
    if (scoreA !== scoreB) return scoreA > scoreB;
    // Same outcome, compare enemy survivors (fewer is better = more complete victory)
    return a.enemySurvivors.lt(b.enemySurvivors);
  };

  let bestAssignments = { ...currentAssignments };
  let bestSim = evaluateAssignments(playerStacks, enemyStacks, bestAssignments);
  let bestScore = outcomeScore(bestSim.outcome);

  let noImprovementCount = 0;
  let totalIterations = 0;

  for (let restart = 0; restart < maxRestarts; restart++) {
    let currentAssignments =
      restart === 0
        ? { ...bestAssignments }
        : // Random restart: randomize formations
          Object.fromEntries(
            unitIds.map((id) => [
              id,
              availableFormations[
                Math.floor(Math.random() * availableFormations.length)
              ],
            ]),
          );

    let currentSim = evaluateAssignments(
      playerStacks,
      enemyStacks,
      currentAssignments,
    );
    let currentScore = outcomeScore(currentSim.outcome);

    if (isBetter(currentSim, bestSim)) {
      bestAssignments = { ...currentAssignments };
      bestSim = currentSim;
      bestScore = currentScore;
      noImprovementCount = 0;
    }

    for (let iter = 0; iter < maxIterations; iter++) {
      totalIterations++;

      // Try changing one random unit's formation
      const randomUnit = unitIds[Math.floor(Math.random() * unitIds.length)];
      const currentFormation = currentAssignments[randomUnit] ?? "standard";
      const otherFormations = availableFormations.filter(
        (f) => f !== currentFormation,
      );

      if (otherFormations.length === 0) continue;

      const newFormation =
        otherFormations[Math.floor(Math.random() * otherFormations.length)];
      const testAssignments = {
        ...currentAssignments,
        [randomUnit]: newFormation,
      };

      const testSim = evaluateAssignments(
        playerStacks,
        enemyStacks,
        testAssignments,
      );
      const testScore = outcomeScore(testSim.outcome);

      if (isBetter(testSim, currentSim)) {
        currentAssignments = testAssignments;
        currentSim = testSim;
        currentScore = testScore;

        if (isBetter(testSim, bestSim)) {
          bestAssignments = { ...testAssignments };
          bestSim = testSim;
          bestScore = testScore;
          noImprovementCount = 0;
        }
      }
    }

    // Check convergence
    if (bestScore === 2) {
      // Found a winning configuration
      break;
    }

    noImprovementCount++;
    if (noImprovementCount >= convergenceThreshold) {
      break;
    }
  }

  return {
    bestAssignments,
    bestOutcome: bestSim.outcome,
    bestEnemySurvivors: bestSim.enemySurvivors,
    iterations: totalIterations,
    converged: bestScore === 2 || noImprovementCount >= convergenceThreshold,
  };
};
