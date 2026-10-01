# Idle Civ — Content & Scope Manifest

> **Purpose:** one self-contained briefing of everything the game contains — content,
> systems, and remaining scope — so an AI (or a new contributor) can estimate the project
> without reading the codebase or the full roadmap.
>
> **Snapshot:** 2026-09-25 — Age-0 unit bases and factors, advanced-building cost factors, and global research pricing are documented below.
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
layer (64 enhancer tiers), unlock gates, and an in-game codex (Gamepedia) already exist.
So do statistics (including online/offline time tracking), achievements, the battle first
slice (79 buyable units, 24 deterministic campaign encounters with a playback Army tab),
the seven-age progression (Ancient → Modern/Space, with age-driven unit retirement), a
172-node research tree, and a full save system (JSON/XML/Base64, GUID-stable content
migration, offline gains at 25% efficiency capped at 12 h). The trade economy and
prestige are still on the roadmap.
Prestige is deliberately deferred until the first loop is done.

## 2. Resources (20 live, 2 planned)

All amounts use `ExpNumber` (mantissa/exponent — no overflow to `Infinity`).

### Production resources — worker-assignable, 🟢

| id      | Gathered by            | Per worker | Building multiplier  | Displayed in                 |
| ------- | ---------------------- | ---------- | -------------------- | ---------------------------- |
| `food`  | gather click + workers | 1/s        | ×1.1 per farm        | sidebar summary, gather grid |
| `wood`  | gather click + workers | 1/s        | ×1.1 per lumberYard | sidebar summary, gather grid |
| `stone` | gather click + workers | 1/s        | ×1.1 per quarry      | sidebar summary, gather grid |
| `gold`  | gather click + workers | 1/s        | ×1.1 per goldMine   | sidebar summary, gather grid |

Rate formula (per resource): `(Σ flat additions) × (Π multipliers) − (Σ drains)`, clamped
at 0. Click gain = `(worker production + 1)` × multipliers (drains excluded).

### Special resources

The four **advanced production** resources (see §3) are not worker-assignable — they are
produced by the advanced buildings themselves, one per second each.

| id          | Family   | Status | Produced by                                            | Notes                                                                                          |
| ----------- | -------- | ------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `population` | worker pool | 🟢  | — (derived from `people` buildings)                    | each citizen drains 1 food/s; capped by `peopleCapacity`; assignable = population − assigned   |
| `military`  | building | 🟢     | `barracks`, +1/s each                                  | gated at 90 citizens; also the primary unit cost; spendable as a trade resource                 |
| `science`   | building | 🟢     | `university`, +1/s each                                | gated on battle `age0_1_first_fire`; funds the research tree                                    |
| `metalwork` | building | 🟢     | `smithy`, +1/s each                                    | gated at 5 town halls; also an enhancer cost from tier 3 on                                    |
| `trade`     | building | 🟢     | `market`, +1/s each                                    | gated on `age1`; the Trade tab's fuel — a route asks for `reserve × intensity` as a gold value every second, capped by what is held, and never spends the reserve, which also raises every production rate by `1 + log₁₀(reserve + 1)` |

Implemented: `click power` and `automated click power` are derived **attributes**
(`attributes.ts`, `family: "derived"`; own `stat` Gamepedia category + stats tab) — 🟢.

### Capacity resources (11, all 🟢)

`${buildingKey}Capacity` for each of the 11 buildings, **default 10** — this is the real
build limit (`maxCount` on definitions is decorative). Effective capacity = stored base ×
Π(bought capacity multipliers). `peopleCapacity` additionally has a floor of houses × 10;
`houseCapacity` a floor of 10 + 10 × town halls. Capacities are displayed in the buildings
UI (`count / capacity` per card), not in the sidebar.

## 3. Buildings (11)

Cost curve per entry: the total for `n` units is `T(n) = base × (factor^√n − 1)`, so
unit `n` costs `T(n) − T(n−1)` and a bulk buy is one subtraction `T(n + k) − T(n)`.
Building costs are per-entry data: citizens use factor 2.5, primary production buildings
use 8, barracks/university wood and food use 10 (stone remains 12), town halls use 15,
and smithy/market use 12. The first buys never get cheaper (the early dip is clamped
to the first unit price).
Order below drives the building grid and auto-buy.

**Endgame factor targets (age 7 — target only, not applied to game data):** the planned
progressive reduction walks the cost growth factors down from **25 → 1.07** (buildings) and
**2.5 → 1.02** (citizens) across the campaign, so a 1e9-count production building costs
≈10^988 and 10B citizens ≈10^1000 at the seventh age. Per-age end-of-age targets (derived
from the production-exponent progression): age 1–2 hold ≈25, age 3 falls to ≈2.83, age 4
≈1.77, age 5 ≈1.34, age 6 ≈1.155, age 7 ≈1.07. Citizens walk 2.5 → 1.02 over the same ten
steps (smooth interpolation; their intermediate shape is not yet pe-confirmed).

### Two tiers of production buildings

The eight buildings that produce anything split into a **primary** and an **advanced**
tier. The split is data, not an engine branch: membership is derived from the `effects`
a definition carries (see `buildingPowerAttributeDefinitions` in `attributes.ts`), so both
tiers are handled by identical code paths and each owns a `${key}Power` stat.

| | **Primary production** | **Advanced production** |
| --- | --- | --- |
| Buildings | `farm`, `lumberYard`, `quarry`, `goldMine` | `barracks`, `university`, `smithy`, `market` |
| Boosts | a **worker-assignable** resource (`food`/`wood`/`stone`/`gold`) | a **building** resource (`military`/`science`/`metalwork`/`trade`) |
| Effect | `additiveMultiplier` `+10%` each | `resourceProduction` `+1/s` each, plus `additiveMultiplier` `+5%` (market has no multiplier) |
| Work input | needs workers assigned to that resource | self-sustaining — no worker assignment |
| Power stat | `farmPower`, `lumberYardPower`, `quarryPower`, `goldMinePower` | `barracksPower`, `universityPower`, `smithyPower`, `marketPower` |
| Availability | available from the start | gated: barracks at 90 citizens, university on `age0_1_first_fire`, smithy at 5 town halls, market on `age1` |
| Enhancers | 8 tiers each, **grant `×10` capacity** | 8 tiers each, **power + production only — no capacity bonus** |

The practical difference: primary buildings feed the click/worker economy you play from
the first minute, while the advanced tier is gated behind population, battles or ages and
generates the resources that later gate research, units and upgrades. Because their
enhancers grant no capacity, the advanced four are capped at their base capacity of 10 —
only tier 1 (threshold 9) of each chain is reachable today. Raising that cap is a
separate balance decision (research/age capacity bonuses, or a rescaled threshold ladder).

| id            | Name        | Costs (base × factor)                          | Tier      | Effects                                | Unlock                    | Status        |
| ------------- | ----------- | ---------------------------------------------- | --------- | -------------------------------------- | ------------------------- | ------------- |
| `people`      | Citizen     | food 10 ×2.5                                  | —         | +1 population; drains 1 food/s each    | always                    | 🟢 engine case |
| `house`       | House       | wood 10 ×12                                   | capacity  | +10 `peopleCapacity`                   | always                    | 🟢            |
| `farm`        | Farm        | food 10 ×8, wood 10 ×8                        | primary   | food gain ×1.1 each                    | always                    | 🟢            |
| `lumberYard` | Lumber Yard | wood 10 ×8, stone 5 ×8                        | primary   | wood gain ×1.1 each                    | always                    | 🟢            |
| `quarry`      | Quarry      | stone 20 ×8                                   | primary   | stone gain ×1.1 each                   | always                    | 🟢            |
| `goldMine`   | Gold Mine   | wood 100 ×8, stone 50 ×8                      | primary   | gold gain ×1.1 each                    | always                    | 🟢            |
| `townHall`   | Town Hall   | wood 10000 ×15, stone 7500 ×15, gold 12500 ×15 | capacity | +10 `houseCapacity`, +1 barracks and university each | always | 🟢 |
| `barracks`    | Barracks    | wood 10000 ×10, stone 1000 ×12, food 5000 ×10  | advanced  | +1 `military`/s, ×1.05 each            | 90 citizens               | 🟢            |
| `university`  | University  | wood 10000 ×10, stone 10000 ×12, gold 7500 ×10 | advanced  | +1 `science`/s, ×1.05 each             | battle `age0_1_first_fire` | 🟢            |
| `smithy`      | Smithy      | wood 1e6 ×12, stone 1e6 ×12                    | advanced  | +1 `metalwork`/s, ×1.05 each           | 5 town halls              | 🟢            |
| `market`      | Market      | wood 25e6 ×12, stone 25e6 ×12                  | advanced  | +1 `trade`/s (no multiplier effect)    | age `age1`               | 🟢            |

Known engine debt: `people`/`house`/`townHall` capacity bookkeeping is special-cased in
the engine instead of being fully data-driven; age-driven availability will replace the
hardcoded `available` flag (roadmap Milestone 2).

## 4. Units (79; 77 buyable)

Buyable units share the square-root buyable curve. The default growth factor is 5.
The Age-0 rebalance adds these bands:

| Unit | Base costs (all entries) | Factor |
| --- | --- | --- |
| Tribesman (`warrior`) | military 150; food 5,000 | 4 |
| Dugout Canoe (`canoe`) | military 25,000; wood 400,000 | 5 |
| Bronze Spearman (`spearman_bronze`) | military 100,000; metalwork 5,000 | 3 |
| Bronze Axeman (`axeman_bronze`) | military 300,000; metalwork 20,000 | 3 |

All other buyable units use factor 5. The 172 research definitions carry no individual
price: each age owns a `research: { base, factor }` schedule (`age0` 1,000/10, `age1`
1e9/200, then ×1e6 base and ×10 factor per age) and prices purchase `n` of that age at
`base × factor^(√n − 1)`. The counter `n` counts only research bought in the current age,
so it restarts at 0 on every age change, and buying a tech from an earlier age costs the
current price without advancing it.

## 5. Upgrades (64, all 🟢)

**Enhancer upgrades** — generated data: 8 buildings × 8 tiers (32 primary + 32 advanced).

- **Ids:** `{building}-enhancer-{threshold}` with thresholds `10, 100, 1k, 10k, 100k, 1M, 10M, 100M` (e.g. `farm-enhancer-1000`); names "Enhanced Farm I"–"VIII".
- **Applies to:** farm → food, lumberYard → wood, quarry → stone, goldMine → gold.
- **Unlock condition:** building count ≥ 98% of its current effective capacity (self-sequencing: each tier raises capacity ×10, so the next tier appears ~10× later).
- **Effects (every tier):** building capacity **×10**; resource production **×2** (stacks multiplicatively across tiers).
- **Cost reductions (per tier):** tiers 3–5 (1k/10k/100k) add `costReductionPercent` 0.5 on their building — compounding to **÷8** across the three; tiers 6–8 (1M+) add `costReductionFactor` 0.99 — the value is a **power**: the cost curve is re-shaped as `(F^√n)^0.99`, i.e. costs grow at 99% of the default rate (formula: `max(1.01, F^Π(N))`, floored at 1.01).
- **Metalwork gate:** tiers 3+ (1k and beyond) also cost **1,000 metalwork** — a deliberate progression wall until battles unlock the smithy.
- **Cost formula (placeholder, Balance-pending):** `ceil(120 s × (90 food / 9 other workers) × 1.1^(0.98 × threshold) × 2^tierIndex)` per cost resource of the building — roughly two minutes of estimated production at the moment the tier unlocks. Worker assumption mirrors the current housing ceiling (population ≤ 110).
- **Endgame:** tier 8 raises capacity to 1e9 — the max expected per building at the end of the first loop.

**Cost-reduction engine (🟢):** applied per unit inside `getBuildingCost()` in the fixed
order `base → factor → percent → flat`; base/percent/flat clamp at 0, growth factor
clamps at 1.01 minimum. Percent reductions compound as `Π(1 − N)`; factor reductions are **powers** that compound as `Π(N)` and re-shape the curve as `(F^√n)^N` (formula: `max(1.01, F^Π(N))`) — the log-growth exponent is scaled by exactly N on every growth factor, so one value means the same thing wherever it is applied. Used
today: `costReductionPercent` + `costReductionFactor` (enhancers). Defined but unused:
`costReductionBase`, `costReductionFlat` (engine path exists, no data).

**Bonus model (7 types):** resource-targeted — `resourceFlat`, `additiveMultiplier`,
`resourceDrain`; buyable-targeted — the four cost reductions above. Building `additiveMultiplier` bonuses sum as percentages (× power); other
multiplier sources compound, flats/drains sum equally. Bonuses are always **derived
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
| Bonus application            | 🟢     | `additiveMultiplier` (production + capacities) and cost reductions (`percent`, `factor`) live; `flat`/`drain`/`base` types have engine paths but no data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Upgrade lifecycle            | 🟢     | `seen` → Gamepedia reveal (permanent), `unlocked` → tab, `bought` → bonuses derived from id list; purchase is one-shot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Unlock gates                 | 🟢     | Buildings: `buildingCount` (barracks/university) and `battle` (smithy, placeholder id `first-battle`); Upgrades: `building-capacity` ratio 0.98                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| UI tabs                      | 🟢     | Production, Upgrades, Achievements, Trade (hidden until a market exists), Settings, Stats, Dev Tools; **Army** hidden until barracks exists; **Research** hidden until university exists (both render no content yet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Gamepedia                    | 🟢     | Registry + relations + search + reveal; categories resource/capacity/building/upgrade/achievement populated, research/combat empty; stat/unit/battle categories planned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Number formats               | 🟢     | scientific / engineering / named / compact; only persisted preference (`localStorage`, try/catch-wrapped)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Saves                        | 🟢     | **Milestone 3 first slice done** — versioned `SaveData` (`SAVE_VERSION = 1`) in `src/game/saveSystem.ts`; JSON, XML and Base64 encodings of the same document; import/export in Settings (clipboard/file pickers via `components/saveFileIo.ts`); static content GUIDs (`src/game/dataIds.ts`, generated by `tools/gen/guids.mjs`) with a `referencedGuids` snapshot in every save so content renames migrate; offline gains at `E_off` = 25% capped at 12 h with an offline-gain panel on load, plus a cross-language contract test (`tools/tests/offline_gain_test.py`, `npm run test:cross-language`) over `data/offlineGainVectors.json`; autosave interval and reset-to-start in Settings/Dev Tools |
| Statistics                   | 🟢     | Stats tab, tracked counters (clicks, buildings built, fastest age/battle records) and the `stat` Gamepedia category (click power, auto-click rate as derived attributes); time tracking now includes `playTimeMs`/`runTimeMs`, `onlineTimeMs`/`offlineTimeMs`, longest-offline/active streaks, and `wastedResources` (unit-retirement cost); command-style actions → result events remain 🔵                                                                                                                                                                                                                                                                                                             |
| Achievements                 | 🟢     | 65 concrete records (17 other milestones + resource multiplier chains 4×9, hoarder chains 4×3, Master Builder 7) with `family`/`tier` data, plus open-ended hoarder tiers every e³ past 1e9 (materialized on demand); cumulative family cards with locked/partial/complete states; age-transition and unit chains still pending                                                                                                                                                                                                                                                                                                                                                                          |
| Ages / era card              | 🟢     | **Milestone 2 first slice done** — seven `AgeDefinition`s in `src/game/data/ages.json` (`age0` Ancient → `age6` Modern/Space, thresholds at powers of ten), live era card in the sidebar, transitions recorded in statistics with fastest-age records, and age-driven unit retirement (units from two ages back are retired; their cost feeds `wastedResources`). Still pending: age-driven building availability (replacing the hardcoded `available` flag) and age-owned unlock lists                                                                                                                                                                                                                |
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
| 8 — Battles                 | **First slice done** — `src/game/units.ts` + `data/units.json` (79 units, per-age hp/attack scale ×8, cost factor 5), `src/game/battle.ts` (fully deterministic stack/hp-pool sim — no damage RNG, the seed is a battle fingerprint and does not change the outcome; ≤ 200 rounds, stalemate outcome, `armyPower = attack × accuracy × √(hp ÷ (1 − armor))` summed over stacks), units as buyables **and** bonus receptacles (`hoplite.attack`, `tag.ranged.range`, `unitAll.hp` scopes; enemy boosts use the same channel), Army tab (unit column + enemy army + battle playback at 1 round/sec, units restored after battle), Gamepedia `unit`/`combat` pages, 79 vendored game-icons.net SVGs (CC BY 3.0, `public/units/ATTRIBUTION.md`). Age-driven retirement trims units from two ages back. Remaining: research-driven unlocks (Milestone 9), balance pass on cross-age enemy counts |
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
| Buildings          | 11 (2 capacity, 8 production, 1 citizen)         | ~11 + colony-ship project pieces                            |
| Resources          | 21 (4 production, 1 population, 4 building, 12 capacity) | + 2 stats (click power, auto-click rate)              |
| Upgrades           | 64 enhancer tiers (32 primary + 32 advanced)       | + research-gated, achievement-gated, battle-reward upgrades |
| Ages               | 7 (live)                                                   | 7                                                           |
| Units / encounters | 79 units, 24 encounters (7 age bosses)                     | 79-unit roster + 24 encounters (7 age-end bosses)           |
| Research           | 172 definitions across 7 ages                    | 1 tree across 7 eras                                        |
| Achievements       | 65 concrete + open-ended hoarder tiers                     | ages + unit chains                                          |
| Saves              | Versioned JSON/XML/Base64 + GUID migration + offline gains | deeper migrations as the model evolves                      |
| Screens            | 1 (tabs)                                                   | 1 + stats tab + modal                                       |
| Code               | ~4,500 lines src                                           | roadmap recommends a `src/game/data/` split first           |
