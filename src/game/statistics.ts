import { ExpNumber } from "./expNumber";

/**
 * Tracked statistics (roadmap Milestone 5). Counters use `ExpNumber` because they
 * grow without bound (clicks, buildings built); times are plain milliseconds.
 * `playTimeMs` is lifetime and never resets; `runTimeMs` belongs to the current run
 * and is what a future prestige resets — records and achievements stay (AGENTS.md
 * §13.7 decision 4).
 */
export type Statistics = {
  /** Manual production clicks (`gather()`), one per click. */
  readonly productionClicks: ExpNumber;
  /** Clicks anywhere in the UI shell, excluding production clicks. */
  readonly uiClicks: ExpNumber;
  /** Cumulative buildings ever built; never decreases, even when nothing is sold. */
  readonly buildingsBuilt: ExpNumber;
  /** Cumulative buildings ever built, per building id. */
  readonly buildingsBuiltByKey: Record<string, ExpNumber>;
  /** Total time played in milliseconds; never reset. */
  readonly playTimeMs: number;
  /** Time played in this run in milliseconds; reset by a future prestige. */
  readonly runTimeMs: number;
  /** Time spent actively online; equal to playTimeMs for save compatibility. */
  readonly onlineTimeMs: number;
  /** Time represented by imported/offline gaps. */
  readonly offlineTimeMs: number;
  /** Largest single offline gap observed. */
  readonly longestOfflineMs: number;
  /** Largest uninterrupted active streak observed. */
  readonly longestActiveMs: number;
  /** Active streak in progress, reset when an offline gap is recorded. */
  readonly activeStreakMs: number;
  /** Fastest run time (ms) at which each age's population threshold was met, by age id. */
  readonly fastestAgeMs: Record<string, number>;
  /** Fastest run time (ms) at which each encounter was won, by encounter id. */
  readonly fastestBattleMs: Record<string, number>;
  /** Accumulated resource cost of retired units (1 point per resource unit lost). */
  readonly wastedResources: ExpNumber;
};

/** One tick is one second: the loop is a 1-second interval with no delta time. */
export const tickMilliseconds = 1000;

export const emptyStatistics = (): Statistics => ({
  productionClicks: ExpNumber.ZERO,
  uiClicks: ExpNumber.ZERO,
  buildingsBuilt: ExpNumber.ZERO,
  buildingsBuiltByKey: {},
  playTimeMs: 0,
  runTimeMs: 0,
  onlineTimeMs: 0,
  offlineTimeMs: 0,
  longestOfflineMs: 0,
  longestActiveMs: 0,
  activeStreakMs: 0,
  fastestAgeMs: {},
  fastestBattleMs: {},
  wastedResources: ExpNumber.ZERO,
});
