# Idle Civ — Development Timeline

> A dated log of what was built, newest first, reconstructed from the git history
> (`git --no-pager log`). Pair it with `docs/game-scope.md` (what the game
> contains now) and `docs/roadmap.md` (what is planned).

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
  gold-mine chain; unit icons fixed.

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
  Gamepedia registry, upgrades (32 enhancer tiers), JSON-backed definitions,
  vendored Node toolchain, agents/docs scaffolding, roadmap pacing notes.