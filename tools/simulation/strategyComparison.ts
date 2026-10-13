/**
 * Multi-strategy comparison and evolution system.
 * Runs multiple strategies in parallel and compares their performance.
 */

import type {
  SimulationResult,
  SimulationConfig,
  SimulationStrategy,
} from "./simulation.js";
import { runSimulation } from "./simulationRunner.js";
import { formatExpoNumber } from "./simFormat.js";

/**
 * Comparison metrics for ranking strategies.
 */
export interface StrategyMetrics {
  strategyName: string;
  gameTime: number;
  objectiveReached: boolean;
  finalPopulation: number;
  totalBuildings: number;
  battlesWon: number;
  militaryPower?: number;
  averageProductionRate: number;
  score: number; // Composite score for ranking
}

/**
 * Multi-strategy comparison result.
 */
export interface ComparisonResult {
  timestamp: number;
  config: SimulationConfig;
  results: Array<{
    strategyName: string;
    result: SimulationResult;
    metrics: StrategyMetrics;
  }>;
  ranking: StrategyMetrics[];
  bestStrategy: StrategyMetrics;
}

/**
 * Calculate composite metrics from a simulation result.
 */
function calculateMetrics(
  strategyName: string,
  result: SimulationResult,
): StrategyMetrics {
  const finalState = result.finalState;
  const population = finalState.population.toNumber();
  const totalBuildings = Object.values(finalState.builtBuildings).reduce(
    (sum: number, count: number) => sum + count,
    0,
  );
  const battlesWon = finalState.defeatedEncounters.length;
  const militaryPower = finalState.getArmyPower().toNumber();

  // Calculate average production rate across all resources
  const productionRates = [
    finalState.computeResourceRate("food").toNumber(),
    finalState.computeResourceRate("wood").toNumber(),
    finalState.computeResourceRate("stone").toNumber(),
    finalState.computeResourceRate("gold").toNumber(),
  ];
  const averageProductionRate =
    productionRates.reduce((sum, rate) => sum + rate, 0) /
    productionRates.length;

  // Composite score (higher is better)
  // Weight: population (40%), buildings (20%), battles (20%), production (20%)
  const score =
    population * 0.4 +
    totalBuildings * 100 * 0.2 +
    battlesWon * 500 * 0.2 +
    averageProductionRate * 0.2;

  return {
    strategyName,
    gameTime: result.gameTime,
    objectiveReached: result.objectiveReached,
    finalPopulation: population,
    totalBuildings,
    battlesWon,
    militaryPower,
    averageProductionRate,
    score,
  };
}

/**
 * Run multiple strategies in parallel and compare results.
 */
export async function compareStrategies(
  strategies: SimulationStrategy[],
  config: SimulationConfig,
): Promise<ComparisonResult> {
  console.log(`Running ${strategies.length} strategies in parallel...`);

  // Run all strategies in parallel
  const results = await Promise.all(
    strategies.map(async (strategy) => {
      const startTime = Date.now();
      const result = runSimulation(strategy, config);
      const endTime = Date.now();

      console.log(
        `Strategy "${strategy.name}" completed in ${((endTime - startTime) / 1000).toFixed(2)}s`,
      );

      return {
        strategyName: strategy.name,
        result,
        metrics: calculateMetrics(strategy.name, result),
      };
    }),
  );

  // Rank by composite score
  const ranking = [...results.map((r) => r.metrics)].sort(
    (a, b) => b.score - a.score,
  );

  const bestStrategy = ranking[0];

  return {
    timestamp: Date.now(),
    config,
    results,
    ranking,
    bestStrategy,
  };
}

/**
 * Run an evolutionary strategy tournament:
 * 1. Run N strategies in parallel
 * 2. Select best performers
 * 3. Mutate/crossover best strategies for next generation
 * 4. Repeat for specified generations
 */
export async function evolutionaryTournament(
  initialStrategies: SimulationStrategy[],
  config: SimulationConfig,
  generations: number = 5,
  topN: number = 2,
): Promise<{
  finalRanking: StrategyMetrics[];
  bestStrategy: StrategyMetrics;
  history: ComparisonResult[];
}> {
  let currentStrategies = [...initialStrategies];
  const history: ComparisonResult[] = [];

  for (let gen = 0; gen < generations; gen++) {
    console.log(`\n=== Generation ${gen + 1}/${generations} ===`);

    const comparison = await compareStrategies(currentStrategies, config);
    history.push(comparison);

    console.log(`\nGeneration ${gen + 1} Ranking:`);
    comparison.ranking.forEach((metrics, index) => {
      console.log(
        `${index + 1}. ${metrics.strategyName}: Score ${formatExpoNumber(metrics.score)}, Population ${formatExpoNumber(metrics.finalPopulation)}, Buildings ${metrics.totalBuildings}, Battles ${metrics.battlesWon}`,
      );
    });

    // Select top performers for next generation
    const topPerformers = comparison.ranking.slice(0, topN);

    // In a full implementation, we would mutate/crossover strategies here
    // For now, we just keep the top performers
    if (gen < generations - 1) {
      currentStrategies = initialStrategies.filter((s: SimulationStrategy) =>
        topPerformers.some((m: StrategyMetrics) => m.strategyName === s.name),
      );

      // If we have fewer strategies than needed, add some variation
      if (currentStrategies.length < initialStrategies.length) {
        currentStrategies = [...initialStrategies]; // Reset for next gen
      }
    }
  }

  const finalComparison = history[history.length - 1];
  return {
    finalRanking: finalComparison.ranking,
    bestStrategy: finalComparison.bestStrategy,
    history,
  };
}

/**
 * Run a head-to-head comparison between two strategies.
 */
export async function headToHead(
  strategyA: SimulationStrategy,
  strategyB: SimulationStrategy,
  config: SimulationConfig,
): Promise<{
  winner: string;
  metricsA: StrategyMetrics;
  metricsB: StrategyMetrics;
  comparison: ComparisonResult;
}> {
  const comparison = await compareStrategies([strategyA, strategyB], config);

  // compareStrategies always returns a result per requested strategy, but guard
  // anyway: an optional chain is undefined by design, so never assert past it.
  const metricsA = comparison.results.find(
    (r) => r.strategyName === strategyA.name,
  )?.metrics;
  const metricsB = comparison.results.find(
    (r) => r.strategyName === strategyB.name,
  )?.metrics;
  if (!metricsA || !metricsB) {
    throw new Error(
      `Missing metrics for ${!metricsA ? strategyA.name : strategyB.name}`,
    );
  }

  const winner =
    metricsA.score > metricsB.score ? strategyA.name : strategyB.name;

  return {
    winner,
    metricsA,
    metricsB,
    comparison,
  };
}

/**
 * Save comparison results to a file.
 */
export async function saveComparisonResults(
  comparison: ComparisonResult,
  filepath: string,
): Promise<void> {
  const fs = await import("node:fs");

  const data = {
    timestamp: comparison.timestamp,
    config: comparison.config,
    ranking: comparison.ranking,
    bestStrategy: comparison.bestStrategy,
    // Include simplified results (full state is too large)
    results: comparison.results.map((r) => ({
      strategyName: r.strategyName,
      success: r.result.success,
      objectiveReached: r.result.objectiveReached,
      gameTime: r.result.gameTime,
      terminationReason: r.result.terminationReason,
      objectiveMet: r.result.objectiveMet,
      snapshotCount: r.result.snapshots.length,
      metrics: r.metrics,
    })),
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`Comparison results saved to ${filepath}`);
}

/**
 * Load comparison results from a file.
 */
export async function loadComparisonResults(
  filepath: string,
): Promise<ComparisonResult> {
  const fs = await import("node:fs");
  const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  return data as ComparisonResult;
}
