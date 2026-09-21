# Idle Civ — Content & Scope Manifest

> **Purpose:** one self-contained briefing of everything the game contains — content,
> systems, and remaining scope — so an AI (or a new contributor) can estimate the project
> without reading the codebase or the full roadmap.
>
> **Snapshot:** commit current (branch `main`), 2026-09-21 — Updated building power system to resource multipliers, changed cost reduction factor to multiplicative computation.
> **Sources of truth:** `src/game/*.ts` (live definitions) and `docs/roadmap.md`
> (planned design). This file is a hand-authored snapshot — regenerate it after large
> content changes. See also `docs/timeline.md` for what landed when.
>
> **Status legend:** 🟢 live in code · 🟡 defined but gated / unreachable · 🔵 designed,
> not implemented (roadmap).

## 1. The game in one paragraph

A browser-based idle/incremental game with a civilization theme (React 19 + TypeScript +
Vite, no backend). The player gathers food/wood/stone/gold, assigns workers, buys 12
building types with exponentially scaling costs, and pushes population toward the campaign
goal of **10 billion people**, finishing with a **colony-ship launch**. A bonus/upgrade
layer (32 enhancer tiers), unlock gates, and an in-game codex (Gamepedia) already exist.
So do statistics (including online/offline time tracking), achievements, the battle first
slice (79 buyable units, 24 deterministic campaign encounters with a playback Army tab),
the seven-age progression (Ancient → Modern/Space, with age-driven unit retirement), and
a full save system (JSON/XML/Base64, GUID-stable content migration, offline gains at
25% efficiency capped at 12 h). Research, the trade economy, and prestige are still on
the roadmap.
Prestige is deliberately deferred until the first loop is done.

## 2. Resources (20 live, 2 planned)

All amounts use `ExpNumber` (mantissa/exponent — no overflow to `Infinity`).

### Production resources — worker-assignable, 🟢

| id      | Gathered by            | Per worker | Building multiplier  | Displayed in                 |
| ------- | ---------------------- | ---------- | -------------------- | ---------------------------- |
| `food`  | gather click + workers | 1/s        | ×1.1 per farm        | sidebar summary, gather grid |
| `wood`  | gather click + workers | 1/s        | ×1.1 per lumber-yard | sidebar summary, gather grid |
| `stone` | gather click + workers | 1/s        | ×1.1 per quarry      | sidebar summary, gather grid |
| `gold`  | gather click + workers | 1/s        | ×1.1 per gold-mine   | sidebar summary, gather grid |

Rate formula (per resource): `(Σ flat additions) × (Π multipliers) − (Σ drains)`, clamped
at 0. Click gain = `(worker production + 1)` × multipliers (drains excluded).

### Special resources

| id           | Family      | Status | Notes                                                                                                                             |
| ------------ | ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `population` | worker pool | 🟢     | Derived from built citizens; each citizen drains 1 food/s; capped by `peopleCapacity`; assignable workers = population − assigned |
| `science`    | building    | 🟡     | Produced 1/s per university; university is gated at 20 town halls (gated at 20 town halls)                                        |
| `military`   | building    | 🟢     | Produced 1/s per barracks; barracks gated at 5 town halls; spendable as a trade resource (production commit 2026-09-19)           |
| `metalwork`  | building    | 🟢     | Produced 1/s per smithy; smithy gated behind the first battle (`age0_1_first_fire`); also an upgrade cost from enhancer tier 3    |

Implemented: `click power` and `automated click power` are derived **attributes**
(`attributes.ts`, `family: "derived"`; own `stat` Gamepedia category + stats tab) — 🟢.

### Capacity resources (12, all 🟢)

`${buildingKey}Capacity` for each of the 12 buildings, **default 10** — this is the real
build limit (`maxCount` on definitions is decorative). Effective capacity = stored base ×
Π(bought capacity multipliers). `peopleCapacity` additionally has a floor of houses × 10;
`houseCapacity` a floor of 10 + 10 × town halls. Capacities are displayed in the buildings
UI (`count / capacity` per card), not in the sidebar.

## 3. Buildings (12)

Cost curve per entry: `cost = base × factor^count` (geometric; bulk buys use the
closed-form series). Order below drives the building grid and auto-buy.

| id            | Name        | Costs (base × factor)                            | Effects                             | Unlock                                         | Status                 |
| ------------- | ----------- | ------------------------------------------------ | ----------------------------------- | ---------------------------------------------- | ---------------------- |
| `people`      | Citizen     | food 10 ×1.2                                     | +1 population; drains 1 food/s each | always                                         | 🟢 engine special case |
| `house`       | House       | wood 10 ×1.3                                     | +10 `peopleCapacity`                | always                                         | 🟢                     |
| `farm`        | Farm        | food 10 ×1.25, wood 10 ×1.25                     | food gain ×1.1 each                 | always                                         | 🟢                     |
| `lumber-yard` | Lumber Yard | wood 10 ×1.25, stone 5 ×1.25                     | wood gain ×1.1 each                 | always                                         | 🟢                     |
| `quarry`      | Quarry      | stone 20 ×1.3                                    | stone gain ×1.1 each                | always                                         | 🟢                     |
| `gold-mine`   | Gold Mine   | wood 100 ×1.25, stone 50 ×1.3                    | gold gain ×1.1 each                 | always                                         | 🟢                     |
| `market`      | Market      | wood 300 ×1.2, stone 120 ×1.15                   | none yet                            | always                                         | 🟢 inert               |
| `town-hall`   | Town Hall   | wood 1000 ×1.25, stone 500 ×1.25, gold 500 ×1.25 | +10 `houseCapacity`                 | always                                         | 🟢                     |
| `smithy`      | Smithy      | wood 360 ×1.2, stone 180 ×1.15                   | +1 `metalwork`/s each               | after first battle                             | �                      |
| `barracks`    | Barracks    | wood 420 ×1.22, stone 260 ×1.18, food 100 ×1.1   | +1 `military`/s each                | 5 town halls                                   | 🟢                     |
| `university`  | University  | wood 520 ×1.24, stone 300 ×1.18, gold 180 ×1.16  | +1 `science`/s each                 | 20 town halls (unreachable: TH capacity is 10) | 🟡                     |
| `monument`    | Monument    | stone 900 ×1.3, gold 400 ×1.2                    | none                                | never (`available: false`)                     | 🔒                     |

Known engine debt: `people`/`house`/`town-hall` capacity bookkeeping is special-cased in
the engine instead of being fully data-driven; age-driven availability will replace the
hardcoded `available` flag (roadmap Milestone 2).

## 4. Upgrades (32, all 🟢)

**Enhancer upgrades** — generated data: 4 buildings × 8 tiers.

- **Ids:** `{building}-enhancer-{threshold}` with thresholds `10, 100, 1k, 10k, 100k, 1M, 10M, 100M` (e.g. `farm-enhancer-1000`); names "Enhanced Farm I"–"VIII".
- **Applies to:** farm → food, lumber-yard → wood, quarry → stone, gold-mine → gold.
- **Unlock condition:** building count ≥ 98% of its current effective capacity (self-sequencing: each tier raises capacity ×10, so the next tier appears ~10× later).
- **Effects (every tier):** building capacity **×10**; resource production **×2** (stacks multiplicatively across tiers).
- **Cost reductions (per tier):** tiers 3–5 (1k/10k/100k) add `costReductionPercent` 0.5 on their building — compounding to **÷8** across the three; tiers 6–8 (1M+) add `costReductionFactor` 0.01 — growth factor reduced multiplicatively, clamped at 1.01 minimum (formula: `1.01 + (baseFactor - 1.01) * Π(1 - N)`).
- **Metalwork gate:** tiers 3+ (1k and beyond) also cost **1,000 metalwork** — a deliberate progression wall until battles unlock the smithy.
- **Cost formula (placeholder, Balance-pending):** `ceil(120 s × (90 food / 9 other workers) × 1.1^(0.98 × threshold) × 2^tierIndex)` per cost resource of the building — roughly two minutes of estimated production at the moment the tier unlocks. Worker assumption mirrors the current housing ceiling (population ≤ 110).
- **Endgame:** tier 8 raises capacity to 1e9 — the max expected per building at the end of the first loop.

**Cost-reduction engine (🟢):** applied per unit inside `getBuildingCost()` in the fixed
order `base → factor → percent → flat`; base/percent/flat clamp at 0, growth factor
clamps at 1.01 minimum. Percent reductions compound as `Π(1 − N)`, factor reductions compound multiplicatively as `Π(1 − N)` and apply to the range above 1.01 (formula: `1.01 + (baseFactor - 1.01) * Π(1 - N)`). Used
today: `costReductionPercent` + `costReductionFactor` (enhancers). Defined but unused:
`costReductionBase`, `costReductionFlat` (engine path exists, no data).

**Bonus model (7 types):** resource-targeted — `resourceFlat`, `resourceMultiplier`,
`resourceDrain`; buyable-targeted — the four cost reductions above. Resource multipliers
stack multiplicatively, flats/drains sum equally (option A). Bonuses are always **derived
from the set of bought upgrade ids**, never accumulated into saved state.

**Planned upgrade sources (🔵):** ages, research completion, battle victories, building
counts — each declaring explicit unlock id lists; `seen`/`unlocked`/`bought` lifecycle
(`seen` permanent, `bought` resets each prestige loop).

## 5. Ages (7, all 🔵 — roadmap Milestone 2)

An age is entered when population crosses the next power of ten; the current age is
computed as the highest threshold reached (never persisted). Age-driven building
availability will replace the hardcoded `available` flag; each age declares explicit
unlock id lists (upgrades, research, encounters).

| id             | Name           | Population range               | Expected content                                                                                                           |
| -------------- | -------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `ancient`      | Ancient        | 1 – 1,000                      | compressed opening (merges Prehistoric/Stone/Bronze); 3 battles — wolf (First Fire), Bronze Raid, **Troy boss** → next age |
| `iron-age`     | Iron Age       | 1,000 – 10,000                 | 3 battles — Kadesh, Assyrian Siege, **Iron Collapse boss** → next age                                                      |
| `classical`    | Classical      | 10,000 – 1,000,000             | 3 battles — 2 regular + age-end boss → next age                                                                            |
| `middle-ages`  | Middle Ages    | 1,000,000 – 10,000,000         | exact midpoint age; 3 battles — 2 regular + boss → next age                                                                |
| `renaissance`  | Renaissance    | 10,000,000 – 100,000,000       | 3 battles — 2 regular + boss → next age                                                                                    |
| `industrial`   | Industrial     | 100,000,000 – 1,000,000,000    | 3 battles — 2 regular + boss → next age                                                                                    |
| `modern-space` | Modern / Space | 1,000,000,000 – 10,000,000,000 | 5 battles + **Orbital War final boss**; colony-ship launch near the end                                                    |

Shape: `AgeDefinition { id, name, populationThreshold, unlocks?, upgrades?, encounters? }`.
Campaign end goals: 10 billion population, then a colony ship (multi-requirement project:
structure, propulsion, life support, crew, reserves, navigation) — the interstellar/prestige
loop beyond that is deferred by decision.

## 6. Bonus diversity analysis

**Total bonus diversity by source (upgrades + research + encounters):**

| Age | Total Bonuses | Unique Types | Research | Encounters | Upgrades |
| --- | ------------- | ------------ | -------- | ---------- | -------- |
| 0   | 88            | 31           | 68       | 12         | 8        |
| 1   | 216           | 108          | 203      | 5          | 8        |
| 2   | 311           | 105          | 294      | 5          | 12       |
| 3   | 229           | 107          | 212      | 5          | 12       |
| 4   | 200           | 106          | 183      | 5          | 12       |
| 5   | 180           | 110          | 163      | 5          | 12       |
| 6   | 106           | 33           | 87       | 7          | 12       |
| 7   | 12            | 12           | 0        | 0          | 12       |

**Key patterns:**

- Research provides 80-95% of bonuses in most ages
- Peak diversity at Age 1 (108 unique bonus types)
- Cost reduction evolution: `costReductionPercent` (Ages 2-4) → `costReductionFactor` (Ages 5-7)
- Unit cost reductions dominate Ages 1-4 (80+ unit types)
- Late ages (6-7) show dramatic reduction in bonus diversity

**Achievement bonuses:** 63 resource multiplier achievements (7 resources × 9 tiers) plus 5 click power milestones, 21 hoarder achievements, and 7 Master Builder cost reduction milestones.

## 7. Systems inventory

| System                       | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tick loop                    | 🟢     | 1-second `setInterval` in React; applies rates to the 4 production + 3 building resources, clamped at 0. No delta-time yet — background tabs throttle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Workers                      | 🟢     | Assign/unassign per production resource; auto-assign keeps food ≈ 10× others while equalizing the rest; multiplier 1…1e9 / Max (Infinity)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Gather clicks                | 🟢     | Per-resource click gain; dev auto-clicker (`autoClicksPerSecond`) exists as a dev tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Building purchase            | 🟢     | Buy 1/10/…/1e9/Max; O(1)-per-check affordability via closed-form geometric sum + doubling probe/binary search (`getMaxAffordableBuildings`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Auto-buy                     | 🟢     | Dev-tools toggle; one pass in definition order buying the max affordable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bonus application            | 🟢     | `resourceMultiplier` (production + capacities) and cost reductions (`percent`, `factor`) live; `flat`/`drain`/`base` types have engine paths but no data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Upgrade lifecycle            | 🟢     | `seen` → Gamepedia reveal (permanent), `unlocked` → tab, `bought` → bonuses derived from id list; purchase is one-shot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Unlock gates                 | 🟢     | Buildings: `building-count` (barracks/university) and `battle` (smithy, placeholder id `first-battle`); Upgrades: `building-capacity` ratio 0.98                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| UI tabs                      | 🟢     | Production, Upgrades, Achievements, Trade (hidden until a market exists), Settings, Stats, Dev Tools; **Army** hidden until barracks exists; **Research** hidden until university exists (both render no content yet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Gamepedia                    | 🟢     | Registry + relations + search + reveal; categories resource/capacity/building/upgrade/achievement populated, research/combat empty; stat/unit/battle categories planned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Number formats               | 🟢     | scientific / engineering / named / compact; only persisted preference (`localStorage`, try/catch-wrapped)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Saves                        | 🟢     | **Milestone 3 first slice done** — versioned `SaveData` (`SAVE_VERSION = 1`) in `src/game/saveSystem.ts`; JSON, XML and Base64 encodings of the same document; import/export in Settings (clipboard/file pickers via `components/saveFileIo.ts`); static content GUIDs (`src/game/dataIds.ts`, generated by `tools/gen/guids.mjs`) with a `referencedGuids` snapshot in every save so content renames migrate; offline gains at `E_off` = 25% capped at 12 h with an offline-gain panel on load, plus a cross-language contract test (`tools/tests/offline_gain_test.py`, `npm run test:cross-language`) over `data/offlineGainVectors.json`; autosave interval and reset-to-start in Settings/Dev Tools |
| Statistics                   | 🟢     | Stats tab, tracked counters (clicks, buildings built, fastest age/battle records) and the `stat` Gamepedia category (click power, auto-click rate as derived attributes); time tracking now includes `playTimeMs`/`runTimeMs`, `onlineTimeMs`/`offlineTimeMs`, longest-offline/active streaks, and `wastedResources` (unit-retirement cost); command-style actions → result events remain 🔵                                                                                                                                                                                                                                                                                                             |
| Achievements                 | 🟢     | 65 concrete records (17 other milestones + resource multiplier chains 4×9, hoarder chains 4×3, Master Builder 7) with `family`/`tier` data, plus open-ended hoarder tiers every e³ past 1e9 (materialized on demand); cumulative family cards with locked/partial/complete states; age-transition and unit chains still pending                                                                                                                                                                                                                                                                                                                                                                          |
| Ages / era card              | 🟢     | **Milestone 2 first slice done** — seven `AgeDefinition`s in `src/game/data/ages.json` (`age-0` Ancient → `age-6` Modern/Space, thresholds at powers of ten), live era card in the sidebar, transitions recorded in statistics with fastest-age records, and age-driven unit retirement (units from two ages back are retired; their cost feeds `wastedResources`). Still pending: age-driven building availability (replacing the hardcoded `available` flag) and age-owned unlock lists                                                                                                                                                                                                                |
| Battle system                | 🟢     | **First slice done** — 79 units (`src/game/data/units.json`), **24 encounters** (`src/game/data/encounters.json`, 7 age bosses), deterministic stack sim (`src/game/battle.ts`), Army tab playback at 1 round/sec, victory bonuses, Gamepedia `unit`/`combat` pages, 79 vendored game-icons.net SVGs. Age-driven retirement now trims old units. Remaining: research-driven unlocks (Milestone 9), balance pass on cross-age enemy counts                                                                                                                                                                                                                                                                |
| Research tree                | 🔵     | Milestone 9 — `era` field referencing age ids                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Game-length simulation       | 🔵     | Milestone 10 — headless engine run at accelerated speed reporting time-to-age/pacing; needs Vitest first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Prestige / interstellar loop | 🔵     | Deferred by decision until the first loop (10B + colony ship) is done; permanent across loops: achievements, prestige bonuses (undefined), `seen`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Master Builder rewards target the derived `buildingCostMultiplier` stat (base ×1), shared by all buildings. Its seven milestones reduce base costs cumulatively to ÷2 through ÷8, before growth and other discounts; upgrade prices are unaffected. The stat is visible in Stats and linked from building cost breakdowns in Gamepedia.

## 8. Remaining scope (roadmap order)

| Milestone                   | Remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — Data-driven definitions | Definitions are JSON-backed (`src/game/data/*.json`); remaining: age-driven building availability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2 — Ages                    | **First slice done** — 7 ages, transitions, era card, age-driven unit retirement; remaining: age-driven unlocks and building availability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3 — Saves                   | **First slice done** — versioned JSON/XML/Base64, GUID migration, offline gains (25%, 12 h cap), contract tests; remaining: deeper migrations as the model evolves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4 — Action multiplier       | Shared `getActionQuantity()` seam (UI multipliers already exist)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5 — Statistics              | Counters + time tracking done; command-style actions → result events remain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6 — Achievements            | Age-transition achievements; milestone chains (resource multipliers, hoarders, Master Builder) + cumulative family cards + open-ended hoarder tiers are done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7 — Upgrades (rest)         | `attributeFlat`/`attributeDrain`/`costReductionBase`/`costReductionFlat` data; research/achievement/battle unlock sources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8 — Battles                 | **First slice done** — `src/game/units.ts` + `data/units.json` (79 units, per-age hp/attack scale ×8, cost factor 1.2), `src/game/battle.ts` (seeded deterministic stack/hp-pool sim, ≤ 200 rounds, stalemate outcome, `armyPower = attack × accuracy × √(hp ÷ (1 − armor))` summed over stacks), units as buyables **and** bonus receptacles (`hoplite.attack`, `tag.ranged.range`, `unitAll.hp` scopes; enemy boosts use the same channel), Army tab (unit column + enemy army + battle playback at 1 round/sec, units restored after battle), Gamepedia `unit`/`combat` pages, 79 vendored game-icons.net SVGs (CC BY 3.0, `public/units/ATTRIBUTION.md`). Age-driven retirement trims units from two ages back. Remaining: research-driven unlocks (Milestone 9), balance pass on cross-age enemy counts |
| 9 — Research                | Tree keyed to ages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10 — Simulation             | Headless pacing run; Vitest is installed (`npm test`), the runner exists but no simulation yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Deferred                    | Prestige mechanics, prestige bonuses, interstellar loop, colony ship                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 9. Conventions an AI must respect

- **Domain layer is React-free** — nothing under `src/game/` imports React or DOM.
- **Immutable state transitions** — engine methods return new instances; no-op returns `this`.
- **`ExpNumber` for anything unbounded** (amounts, rates, multipliers, costs); plain `number` only for counts/ticks/thresholds.
- **Stable kebab-case ids** — saves, achievements, and the Gamepedia key off them; renaming is breaking.
- **No per-content conditionals in the engine** — behaviour lives in definition data/bonuses (a few legacy special cases exist; do not add more).
- **Numbers reach the player only through `formatNumber`** (two decimals, `<1` renders as `0`).
- **Cost reductions are per unit** in the fixed order `base → factor → percent → flat`; factor reductions use multiplicative computation clamped at 1.01 minimum; attribute bonuses stack option A (multipliers multiply, flats/drains sum).
- **Unlocks are explicit id lists** on their source (age/research/encounter/building) — never a rule engine.
- **First loop before prestige.**
- Validation gate: `npm run build` (tsc + vite) and `npm run lint` (oxlint) must both pass; Node/npm are vendored in `tools/node/`. Tests: Vitest is installed (`npm test`, e.g. `src/game/saveSystem.test.ts`); the offline-gain contract also has a cross-language Python check (`npm run test:cross-language`).
- Full working rules: `AGENTS.md` at the repo root.

## 10. Scope at a glance

| Dimension          | Live                                                       | Planned total (first loop)                                  |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------------------- |
| Buildings          | 12                                                         | ~12 + colony-ship project pieces                            |
| Resources          | 20 (4 production, 1 population, 3 building, 12 capacity)   | + 2 stats (click power, auto-click rate)                    |
| Upgrades           | 32 enhancer tiers                                          | + research-gated, achievement-gated, battle-reward upgrades |
| Ages               | 7 (live)                                                   | 7                                                           |
| Units / encounters | 79 units, 24 encounters (7 age bosses)                     | 79-unit roster + 24 encounters (7 age-end bosses)           |
| Research           | 0                                                          | 1 tree across 7 eras                                        |
| Achievements       | 65 concrete + open-ended hoarder tiers                     | ages + unit chains                                          |
| Saves              | Versioned JSON/XML/Base64 + GUID migration + offline gains | deeper migrations as the model evolves                      |
| Screens            | 1 (tabs)                                                   | 1 + stats tab + modal                                       |
| Code               | ~4,500 lines src                                           | roadmap recommends a `src/game/data/` split first           |
