# Idle Civ — Development Timeline

> A dated log of what was built, newest first, reconstructed from the git history
> (`git --no-pager log`). Pair it with `docs/game-scope.md` (what the game
> contains now) and `docs/roadmap.md` (what is planned).

## 2026-09-28 — Strategy balance analysis and Age-0 progression documentation

- **Strategy performance analysis:** analyzed 7 simulation strategies (cheapest, balanced, production, military, fast-age, economy, speedrun) at 60-minute mark
- **Key finding:** only cheapest strategy reaches 3 battles/699 population within 1 hour; all others stall at 2 battles/~480 population
- **Root causes identified:**
  - Over-constrained building priorities with hardcoded orders block cheaper alternatives
  - Suboptimal worker ratios split focus (cheapest uses 100% food vs 40-50% in others)
  - Conservative battle launch conditions (50 power threshold vs immediate simulation-based launches)
  - Missing economy scaling prevents natural progression through building types
- **Age-0 progression spreadsheet updated:** `sim-output/age_0_building_progression.csv` now uses actual simulation data from `sim-output/sim/sim-cheapest.csv` instead of estimates
- **Corrected data sources:** building counts and production rates extracted directly from simulation CSV at 4 checkpoints (before each battle and end of age)
- **Short-term fixes applied (not yet benchmarked — see 2026-09-29 below):**
  - Increased food ratios to 0.65-0.8 in all strategies (citizens are critical)
  - Removed target counts from building priorities (let economy scale naturally)
- **Battle optimization attempt:** a cached-simulator-plan refactor was started and
  left half-applied; it was completed and reverted on 2026-09-29

## 2026-09-29 — Strategy repair, benchmark harness, speedrun retune

- **Repaired the interrupted strategy refactor.** The previous session left
  `tools/simulation.ts` calling `strategy.onBattleVictory()`, a method that was
  never added to the `SimulationStrategy` interface, and deleted the
  `shouldLaunchBattle` bodies from four strategies while replacing them with
  comments claiming they "inherit the optimized" version. Fixed by dropping the
  uncallable call and deleting `shouldLaunchBattle` entirely: it was provably
  dead. `decideAction` already calls `getRequiredBattleAction(state)` on its
  first line, and that helper re-checks the real `simulateEncounter` outcome, so
  the later priority-3 gate could never fire. This is why the "50 power
  threshold" root cause above was a phantom — that code was unreachable.
- **`tools/` is not type-checked by `npm run build`** (`tsconfig.app.json`
  includes only `src`; `tsconfig.node.json` only `vite.config.ts`), so a broken
  call in a tool passes the build gate silently. Verified the tools + game layer
  with a temporary tsconfig while repairing.
- **Added `tools/compare-bench.ts`:** prints the §7.2 headline columns (age,
  population, buildings, battles, research, army power, and time to `age-1`) for
  two runs, and reports a strategy missing from either side instead of silently
  dropping it.
- **Benchmark finding:** `balanced` at HEAD took **>23 minutes** of wall clock on
  a 2-hour horizon versus 83 s for `cheapest` — the ROI sweep's battle
  evaluation dominates run time. Benchmarks must budget for this.
- **Speedrun retuned.** Three real stalls, each found by tracing actual decisions
  (`tools/trace-strategy.ts`) rather than by reading the strategy:
  1. **Food guard preempted growth.** `food <= 0 -> gather food` ran *first*.
     Every citizen both costs food and drains 1/second, so a settlement worth
     speeding up sits at zero food almost continuously and ten gathered clicks
     cannot outrun the drain. The guard never cleared: 743 `gather food` against
     89 `build people` in 900 seconds. Moved *below* the age route, which already
     handles the food case.
  2. **The growth route deadlocked on its own target.** It returned `null` as
     soon as `population >= target` — but a settlement can hit the target and
     still be unable to grow because `peopleCapacity` is full, and the house that
     lifts it is exactly the purchase the route exists to make. It stood at
     `population === capacity === 90` with `canBuild("house") === true` and 4164
     spare wood, forever. Housing is now handled first and unconditionally, and
     escalates to a town hall when `houseCapacity` is exhausted.
  3. **Recruitment could not outrun the unit cost curve.** Only the *first*
     recommended unit type was bought, once per action, while a warrior's cost
     went 150 -> 606 -> 1787 -> 3472 military. The settlement spent 1127 actions
     gathering military and bought 24 units. Now every type in the plan is
     bought, and the ROI sweep (which raises military *income* — barracks 1 -> 10)
     runs *before* the advisor's gather hint, because a per-tick trickle cannot
     outrun a geometric cost curve.
- **Benchmarked 1h, all 7 strategies, before vs after** (`tools/compare-bench.ts`,
  HEAD `a9b9605` as the baseline). **No strategy regressed:**

  | strategy | population | buildings | battles | research | age |
  | --- | --- | --- | --- | --- | --- |
  | speedrun   | 100 -> 569 | 113 -> 753 | 1 -> 2 | 0 -> 10 | age0 |
  | fast-age   | 200 -> 967 | 383 -> 1436 | 1 -> 2 | 6 -> 13 | age0 |
  | production | 200 -> 992 | 555 -> 1466 | 1 -> 2 | 11 -> 13 | age0 |
  | balanced   | 885 -> 999 | 1380 -> 1594 | 2 -> 3 | 13 -> 23 | age0 |
  | economy    | 992 -> 999 | 1478 -> 1595 | 2 -> 3 | 13 -> 23 | age0 |
  | military   | 951 -> 1209 | 1499 -> 1834 | 2 -> 4 | 13 -> 28 | **age0 -> age1** |
  | cheapest   | 699 (unchanged — it overrides `decideAction` entirely) |

  `military` is now the first strategy to leave age 0. The crashed session's
  unvalidated edits (food ratios raised to 0.65-0.8, `targetCount` removed) were
  measured and **reverted**: they cost `balanced` 685 citizens and `military`
  749, and the "✅ validated" claims in the log above were not true.

## 2026-09-25 — Age-0 balance documentation refresh

- **Unit cost curves:** the default growth factor remains 5, with explicit Age-0
  exceptions: Tribesman factor 4; Bronze Spearman and Axeman factor 3. The updated
  bases are kept in `tools/gen/units.mjs` so regeneration does not restore the
  former values.
- **Building costs:** current JSON uses citizen 2.5; primary production 8;
  town halls 15; barracks/university 10 for wood and food (12 for stone); smithy
  and market 12. The documentation and balance workbook now record these values.
- **Research pricing:** the first research still costs 100 science, but global
  purchase `n` now follows `100 × 10^(√n − 1)`. `tools/gen/techtree.mjs` preserves
  live GUIDs and does not write per-tech prices.

## 2026-09-19 — Save system, offline progress, trade production

- **Save system (roadmap Milestone 3, first full slice):** versioned `SaveData`
  (`SAVE_VERSION = 1`) in `src/game/saveSystem.ts` with three interchange
  formats — JSON, **XML**, and **Base64** (same document, three encodings).
  Import/export in Settings (clipboard or file pickers via
  `src/components/saveFileIo.ts`, DOM plumbing kept out of the domain layer).
- **Static content GUIDs:** every entry in `src/game/data/*.json` carries a
  stable RFC-4122 v5 guid written by `tools/gen/guids.mjs`
  (`src/game/dataIds.ts`). Saves embed a `referencedGuids` snapshot so content
  renames can be migrated instead of silently dropping a player's progress.
- **Offline progress:** `E_off = 25%` efficiency, capped at 12 hours
  (`OFFLINE_EFFICIENCY`, `MAX_OFFLINE_MS`); a reload/import shows an
  offline-gain panel; Dev Tools import can skip the gain. Shared contract
  vectors in `src/game/data/offlineGainVectors.json` are asserted by a
  cross-language test (`tools/tests/offline_gain_test.py`, run with
  `npm run test:cross-language`).
- **Statistics grew time tracking:** `playTimeMs`/`runTimeMs` plus
  `onlineTimeMs`, `offlineTimeMs`, `longestOfflineMs`, `longestActiveMs`,
  `activeStreakMs`, and `wastedResources`.
- **Military as a trade resource:** barracks `military` production is now
  spendable (a step toward the Trade tab).

## 2026-09-18 — Ages, balance, dev tools, cost reductions

- **Ages went live (roadmap Milestone 2, first slice):** seven
  `AgeDefinition`s in `src/game/data/ages.json` (Ancient 0 → Modern/Space
  10^10), age UI in the sidebar, population-threshold transitions recorded in
  statistics, age-driven unit retirement (units from two ages back are retired;
  retirement waste feeds `wastedResources`).
- **All-building cost reduction:** the Master Builder / global
  `buildingCostMultiplier` path applies to every building, not just enhancer
  targets.
- **Dev tools expanded:** time skips (`+1m/+1h/+1d`), free
  buildings/units/upgrades, win-next-battle, reset-to-start; the checkbox bug
  (capture-phase click race) was fixed by inverting React state instead of
  reading `event.target.checked`.
- **Performance and balance passes** over production, encounters and the
  goldMine chain; unit icons fixed.

## 2026-09-17 — Battles first playable, achievement polish

- **Battle first slice playable (roadmap Milestone 8):** 79-unit roster, 24
  campaign encounters, deterministic stack sim, Army tab with 1-round/sec
  playback, victory bonuses.
- Achievement UI feedback (progress on family cards), extra achievements,
  balance tweaks.

## 2026-09-16 — Attributes, achievements, units

- **Attribute model** replaced the loose resource map (`family: amount |
capacity | derived`), unlocking derived stats (`clickPower`,
  `autoClickRate`).
- **Achievements + statistics slice:** JSON-backed achievement registry,
  `checkAchievements()` in the tick, milestone chains, Stats tab.
- Unit data v3 curation; battle shell.

## Earlier (2026-09-14 → 09-15) — Foundations

- `ExpNumber` (extended precision), number formatting, action multipliers,
  Gamepedia registry, upgrades (64 enhancer tiers), JSON-backed definitions,
  vendored Node toolchain, agents/docs scaffolding, roadmap pacing notes.
