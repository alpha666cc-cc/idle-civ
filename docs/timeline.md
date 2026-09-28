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
- **Age-0 progression spreadsheet updated:** `age_0_building_progression.csv` now uses actual simulation data from `temp/sim/sim-cheapest.csv` instead of estimates
- **Corrected data sources:** building counts and production rates extracted directly from simulation CSV at 4 checkpoints (before each battle and end of age)
- **Recommended fixes documented:** increase food ratios to 0.6-0.8, lower battle launch thresholds, remove target counts from priorities, add cheapest fallback

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
