# Idle Civ — Content & Scope Manifest

> **Purpose:** one self-contained briefing of everything the game contains — content,
> systems, and remaining scope — so an AI (or a new contributor) can estimate the project
> without reading the codebase or the full roadmap.
>
> **Snapshot:** commit `857b4d9` (branch `main`), 2026-09-15.
> **Sources of truth:** `src/game/*.ts` (live definitions) and `docs/roadmap.md`
> (planned design). This file is a hand-authored snapshot — regenerate it after large
> content changes.
>
> **Status legend:** 🟢 live in code · 🟡 defined but gated / unreachable · 🔵 designed,
> not implemented (roadmap).

## 1. The game in one paragraph

A browser-based idle/incremental game with a civilization theme (React 19 + TypeScript +
Vite, no backend). The player gathers food/wood/stone/gold, assigns workers, buys 12
building types with exponentially scaling costs, and pushes population toward the campaign
goal of **10 billion people**, finishing with a **colony-ship launch**. A bonus/upgrade
layer (32 enhancer tiers), unlock gates, and an in-game codex (Gamepedia) already exist.
Ages, saves, statistics, achievements, battles, and research are still on the roadmap.
Prestige is deliberately deferred until the first loop is done.

## 2. Resources (20 live, 2 planned)

All amounts use `ExpNumber` (mantissa/exponent — no overflow to `Infinity`).

### Production resources — worker-assignable, 🟢

| id | Gathered by | Per worker | Building multiplier | Displayed in |
| --- | --- | --- | --- | --- |
| `food` | gather click + workers | 1/s | ×1.1 per farm | sidebar summary, gather grid |
| `wood` | gather click + workers | 1/s | ×1.1 per lumber-yard | sidebar summary, gather grid |
| `stone` | gather click + workers | 1/s | ×1.1 per quarry | sidebar summary, gather grid |
| `gold` | gather click + workers | 1/s | ×1.1 per gold-mine | sidebar summary, gather grid |

Rate formula (per resource): `(Σ flat additions) × (Π multipliers) − (Σ drains)`, clamped
at 0. Click gain = `(worker production + 1)` × multipliers (drains excluded).

### Special resources

| id | Family | Status | Notes |
| --- | --- | --- | --- |
| `population` | worker pool | 🟢 | Derived from built citizens; each citizen drains 1 food/s; capped by `peopleCapacity`; assignable workers = population − assigned |
| `science` | building | 🟡 | Produced 1/s per university; university is gated at 20 town halls (unreachable today) |
| `military` | building | 🟢 | Produced 1/s per barracks; barracks gated at 5 town halls |
| `metalwork` | building | 🟡 | Produced 1/s per smithy; smithy gated behind the first battle (no battles yet); also an upgrade cost from enhancer tier 3 |

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

| id | Name | Costs (base × factor) | Effects | Unlock | Status |
| --- | --- | --- | --- | --- | --- |
| `people` | Citizen | food 10 ×1.2 | +1 population; drains 1 food/s each | always | 🟢 engine special case |
| `house` | House | wood 10 ×1.3 | +10 `peopleCapacity` | always | 🟢 |
| `farm` | Farm | food 10 ×1.25, wood 10 ×1.25 | food gain ×1.1 each | always | 🟢 |
| `lumber-yard` | Lumber Yard | wood 10 ×1.25, stone 5 ×1.25 | wood gain ×1.1 each | always | 🟢 |
| `quarry` | Quarry | stone 20 ×1.3 | stone gain ×1.1 each | always | 🟢 |
| `gold-mine` | Gold Mine | wood 100 ×1.25, stone 50 ×1.3 | gold gain ×1.1 each | always | 🟢 |
| `market` | Market | wood 300 ×1.2, stone 120 ×1.15 | none yet | always | 🟢 inert |
| `town-hall` | Town Hall | wood 1000 ×1.25, stone 500 ×1.25, gold 500 ×1.25 | +10 `houseCapacity` | always | 🟢 |
| `smithy` | Smithy | wood 360 ×1.2, stone 180 ×1.15 | +1 `metalwork`/s each | after first battle (placeholder; cannot fire yet) | 🟡 |
| `barracks` | Barracks | wood 420 ×1.22, stone 260 ×1.18, food 100 ×1.1 | +1 `military`/s each | 5 town halls | 🟢 |
| `university` | University | wood 520 ×1.24, stone 300 ×1.18, gold 180 ×1.16 | +1 `science`/s each | 20 town halls (unreachable: TH capacity is 10) | 🟡 |
| `monument` | Monument | stone 900 ×1.3, gold 400 ×1.2 | none | never (`available: false`) | 🔒 |

Known engine debt: `people`/`house`/`town-hall` capacity bookkeeping is special-cased in
the engine instead of being fully data-driven; age-driven availability will replace the
hardcoded `available` flag (roadmap Milestone 2).

## 4. Upgrades (32, all 🟢)

**Enhancer upgrades** — generated data: 4 buildings × 8 tiers.

- **Ids:** `{building}-enhancer-{threshold}` with thresholds `10, 100, 1k, 10k, 100k, 1M, 10M, 100M` (e.g. `farm-enhancer-1000`); names "Enhanced Farm I"–"VIII".
- **Applies to:** farm → food, lumber-yard → wood, quarry → stone, gold-mine → gold.
- **Unlock condition:** building count ≥ 98% of its current effective capacity (self-sequencing: each tier raises capacity ×10, so the next tier appears ~10× later).
- **Effects (every tier):** building capacity **×10**; resource production **×2** (stacks multiplicatively across tiers).
- **Cost reductions (per tier):** tiers 3–5 (1k/10k/100k) add `costReductionPercent` 0.5 on their building — compounding to **÷8** across the three; tiers 6–8 (1M+) add `costReductionFactor` 0.01 — growth factor 1.25 → **1.22**.
- **Metalwork gate:** tiers 3+ (1k and beyond) also cost **1,000 metalwork** — a deliberate progression wall until battles unlock the smithy.
- **Cost formula (placeholder, Balance-pending):** `ceil(120 s × (90 food / 9 other workers) × 1.1^(0.98 × threshold) × 2^tierIndex)` per cost resource of the building — roughly two minutes of estimated production at the moment the tier unlocks. Worker assumption mirrors the current housing ceiling (population ≤ 110).
- **Endgame:** tier 8 raises capacity to 1e9 — the max expected per building at the end of the first loop.

**Cost-reduction engine (🟢):** applied per unit inside `getBuildingCost()` in the fixed
order `base → factor → percent → flat`; base/percent/flat clamp at 0, growth factor
clamps at 1. Percent reductions compound as `Π(1 − N)`, factor reductions sum. Used
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

| id | Name | Population range | Expected content |
| --- | --- | --- | --- |
| `ancient` | Ancient | 1 – 1,000 | compressed opening (merges Prehistoric/Stone/Bronze); 3 battles — wolf (First Fire), Bronze Raid, **Troy boss** → next age |
| `iron-age` | Iron Age | 1,000 – 10,000 | 3 battles — Kadesh, Assyrian Siege, **Iron Collapse boss** → next age |
| `classical` | Classical | 10,000 – 1,000,000 | 3 battles — 2 regular + age-end boss → next age |
| `middle-ages` | Middle Ages | 1,000,000 – 10,000,000 | exact midpoint age; 3 battles — 2 regular + boss → next age |
| `renaissance` | Renaissance | 10,000,000 – 100,000,000 | 3 battles — 2 regular + boss → next age |
| `industrial` | Industrial | 100,000,000 – 1,000,000,000 | 3 battles — 2 regular + boss → next age |
| `modern-space` | Modern / Space | 1,000,000,000 – 10,000,000,000 | 5 battles + **Orbital War final boss**; colony-ship launch near the end |

Shape: `AgeDefinition { id, name, populationThreshold, unlocks?, upgrades?, encounters? }`.
Campaign end goals: 10 billion population, then a colony ship (multi-requirement project:
structure, propulsion, life support, crew, reserves, navigation) — the interstellar/prestige
loop beyond that is deferred by decision.

## 6. Systems inventory

| System | Status | Notes |
| --- | --- | --- |
| Tick loop | 🟢 | 1-second `setInterval` in React; applies rates to the 4 production + 3 building resources, clamped at 0. No delta-time yet — background tabs throttle |
| Workers | 🟢 | Assign/unassign per production resource; auto-assign keeps food ≈ 10× others while equalizing the rest; multiplier 1…1e9 / Max (Infinity) |
| Gather clicks | 🟢 | Per-resource click gain; dev auto-clicker (`autoClicksPerSecond`) exists as a dev tool |
| Building purchase | 🟢 | Buy 1/10/…/1e9/Max; O(1)-per-check affordability via closed-form geometric sum + doubling probe/binary search (`getMaxAffordableBuildings`) |
| Auto-buy | 🟢 | Dev-tools toggle; one pass in definition order buying the max affordable |
| Bonus application | 🟢 | `resourceMultiplier` (production + capacities) and cost reductions (`percent`, `factor`) live; `flat`/`drain`/`base` types have engine paths but no data |
| Upgrade lifecycle | 🟢 | `seen` → Gamepedia reveal (permanent), `unlocked` → tab, `bought` → bonuses derived from id list; purchase is one-shot |
| Unlock gates | 🟢 | Buildings: `building-count` (barracks/university) and `battle` (smithy, placeholder id `first-battle`); Upgrades: `building-capacity` ratio 0.98 |
| UI tabs | 🟢 | Production, Upgrades, Achievements, Trade (hidden until a market exists), Settings, Stats, Dev Tools; **Army** hidden until barracks exists; **Research** hidden until university exists (both render no content yet) |
| Gamepedia | 🟢 | Registry + relations + search + reveal; categories resource/capacity/building/upgrade/achievement populated, research/combat empty; stat/unit/battle categories planned |
| Number formats | 🟢 | scientific / engineering / named / compact; only persisted preference (`localStorage`, try/catch-wrapped) |
| Saves | 🔵 | **None.** Everything resets on reload; roadmap Milestone 3: versioned JSON primary, XML/Base64 interchanges, migrations; offline gains will use an efficiency factor `E_off` = 25–50% of active production, capped at 12 h |
| Statistics | 🟡 | Stats tab, tracked counters (clicks, play time, buildings built, fastest records) and the `stat` Gamepedia category (click power, auto-click rate as derived attributes) are live; Milestone 5's command-style actions → result events remain 🔵 |
| Achievements | 🟢 | 12 milestone records (`src/game/data/achievements.json`): resource/population/building-count/encounter/upgrade-count requirements, evaluated by `CivilizationState.checkAchievements()` at the end of `tick()`; earned ids only in state; revealed in the Gamepedia, listed in the Achievements tab; age + click milestones still pending |
| Ages / era card | 🔵 | Sidebar era card is a hardcoded mock ("Neolithic Dawn", "Year 12", "68% to Bronze Age") — do not build on it |
| Battle system | 🔵 | Milestone 8 — campaign prototype (`temp/campaign_v2.json`, not compiled/wired): **23 encounters** (2 regular + 1 age-end boss per age, 5 in Modern/Space) over a **79-unit roster** (`temp/unit-v2-currated.json`); unit availability comes from the research tree/battle rewards, not per-encounter lists; wolf first; victories apply data-driven rewards (caps, upgrades, unlocks) |
| Research tree | 🔵 | Milestone 9 — `era` field referencing age ids |
| Game-length simulation | 🔵 | Milestone 10 — headless engine run at accelerated speed reporting time-to-age/pacing; needs Vitest first |
| Prestige / interstellar loop | 🔵 | Deferred by decision until the first loop (10B + colony ship) is done; permanent across loops: achievements, prestige bonuses (undefined), `seen` |

## 7. Remaining scope (roadmap order)

| Milestone | Remaining work |
| --- | --- |
| 1 — Data-driven definitions | Move definitions to `src/game/data/` (one file per content type); age-driven availability |
| 2 — Ages | The 7 `AgeDefinition`s above; transition events; age-driven unlocks |
| 3 — Saves | Versioned JSON (+ XML/Base64 codecs), migrations, **offline progress**; persist `seen`/`unlocked`/`bought` per upgrade |
| 4 — Action multiplier | Shared `getActionQuantity()` seam (UI multipliers already exist) |
| 5 — Statistics | Command-style actions → result events → stats tab |
| 6 — Achievements | Age-transition achievements + click-power milestones (`×2` click power at 100/1k/10k/100k/1M clicks); the 12 milestone records and the engine/tab/Gamepedia wiring are done |
| 7 — Upgrades (rest) | `attributeFlat`/`attributeDrain`/`costReductionBase`/`costReductionFlat` data; research/achievement/battle unlock sources |
| 8 — Battles | Deterministic combat for 23 encounters (2 regular + 1 boss per age; 5 in Modern/Space) over a 79-unit roster; wolf first (unlocks smithy + town-hall cap 100); content reference: `temp/campaign_v2.json` |
| 9 — Research | Tree keyed to ages |
| 10 — Simulation | Headless pacing run; requires proposing Vitest first (no test runner today) |
| Deferred | Prestige mechanics, prestige bonuses, interstellar loop, colony ship |

## 8. Conventions an AI must respect

- **Domain layer is React-free** — nothing under `src/game/` imports React or DOM.
- **Immutable state transitions** — engine methods return new instances; no-op returns `this`.
- **`ExpNumber` for anything unbounded** (amounts, rates, multipliers, costs); plain `number` only for counts/ticks/thresholds.
- **Stable kebab-case ids** — saves, achievements, and the Gamepedia key off them; renaming is breaking.
- **No per-content conditionals in the engine** — behaviour lives in definition data/bonuses (a few legacy special cases exist; do not add more).
- **Numbers reach the player only through `formatNumber`** (two decimals, `<1` renders as `0`).
- **Cost reductions are per unit** in the fixed order `base → factor → percent → flat`; attribute bonuses stack option A (multipliers multiply, flats/drains sum).
- **Unlocks are explicit id lists** on their source (age/research/encounter/building) — never a rule engine.
- **First loop before prestige.**
- Validation gate: `npm run build` (tsc + vite) and `npm run lint` (oxlint) must both pass; Node/npm are vendored in `tools/node/`. No test framework installed — propose Vitest before adding one.
- Full working rules: `AGENTS.md` at the repo root.

## 9. Scope at a glance

| Dimension | Live | Planned total (first loop) |
| --- | --- | --- |
| Buildings | 12 | ~12 + colony-ship project pieces |
| Resources | 20 (4 production, 1 population, 3 building, 12 capacity) | + 2 stats (click power, auto-click rate) |
| Upgrades | 32 enhancer tiers | + research-gated, achievement-gated, battle-reward upgrades |
| Ages | 0 | 7 |
| Units / encounters | 0 | 79-unit roster + 23 encounters (7 age-end bosses) |
| Research | 0 | 1 tree across 7 eras |
| Achievements | 12 (milestone set) | ages + milestones + click milestones |
| Saves | 0 | versioned JSON + 2 interchange codecs + offline |
| Screens | 1 (tabs) | 1 + stats tab + modal |
| Code | ~4,500 lines src | roadmap recommends a `src/game/data/` split first |
