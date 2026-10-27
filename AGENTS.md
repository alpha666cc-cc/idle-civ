# AGENTS.md

Shared instructions for **every** AI agent (and human contributor) working in this
repository. Read this file first, then the docs it points to.

| Document                    | Answers                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `AGENTS.md` (this file)     | How to work here: rules, architecture, conventions, validation    |
| `docs/roadmap.md`           | What to build next: milestones, save format, ages, balance intent |
| `.github/agents/*.agent.md` | Per-agent roles (lead / coder / balance). They defer to this file |
| `README.md`                 | Getting started, template notes                                   |

If a per-agent file and this file disagree, **this file wins**.

---

## 1. What this project is

`idle-civilization` — a browser-based **idle/incremental game** with a civilization
theme. The player gathers food/wood/stone/gold, assigns workers, buys buildings
that add production multipliers, drains and capacities, and steers a settlement
toward a 10-billion population and an interstellar colony ship
(see `docs/roadmap.md` → "Long-term loop: From Earth to the stars").

- **Stack:** React 19 + TypeScript ~6.0 + Vite 8, icons from `lucide-react`,
  linting via `oxlint`. No CSS framework, no router, no state library, no backend.
- **Language level:** ES2023, bundler module resolution, `jsx: react-jsx`.
- **Branch:** `main`. 50 tracked files. Current HEAD is a battle prototype commit.
- **Current state:** one screen; economy (resources, workers, buildings, capacities,
  Gamepedia modal, number-format preference, dev tools auto-clicker/auto-buy/auto-assign).
  **Implemented (bonus/upgrade slice):** the `Bonus` type (`src/game/bonus.ts`),
  attribute-targeted bonuses (`attributeMultiplier` on production resources and
  capacities), the cost-reduction path in `getBuildingCost()` (enhancer tiers 3–8 use
  `costReductionPercent`/`costReductionFactor` on their building), the
  `UpgradeDefinition` registry with the 64 production-enhancer tiers
  (`src/game/upgrades.ts`, 8 buildings × 8 tiers), the Upgrades tab, unlock-gated
  buildings and the `military`/`metalwork`
  resources. **Implemented (achievement slice):** the `AchievementDefinition` registry
  (`src/game/achievements.ts` + `data/achievements.json`), five data-driven requirement
  types, `CivilizationState.checkAchievements()` (run from `tick()`), the
  `earnedAchievements` id list, the Achievements tab and the `achievement` Gamepedia
  category. **Implemented (statistics slice):** `Statistics` on the state
  (`src/game/statistics.ts`) — production clicks, UI clicks, buildings built (total and
  per building), lifetime and per-run play time, and fastest age/battle records — the
  live Stats tab, the `stat` definitions/Gamepedia category, and click power as a
  global stat that the five click-milestone achievements raise (+1/+2/+5/+20/+100).
  **Implemented (units & battle slice, Milestone 8):** the `UnitDefinition` registry
  (79 JSON-backed units, `src/game/units.ts` + `data/units.json`), `unitCounts` on the
  state with unit buy/cost paths on the shared buyable evaluator, per-unit effective
  stats folding the three stat bonus scopes (`<unit>.<stat>`, `tag.<tag>.<stat>`,
  `unitAll.<stat>`; enemy boosts use the same channel), the fully deterministic
  stack battle sim (`src/game/battle.ts` — no damage RNG, so the same armies
  always give the same result; the seed is a battle fingerprint, battle id + both
  army signatures, kept for logging/replay; ≤ 200 rounds, played back at
  1 round/sec), campaign battles in
  `data/encounters.json` (`age`/`year`/`isBoss`/`enemyArmy`/`enemyBoosts`),
  **per-unit battle orders** (`BattleOrder` in `battle.ts`: `standard` plus seven
  classical-age orders that change targeting and screening only — the `standard`
  path is exactly the old weakest-pool rule, so a battle with no orders resolves
  as it did before; `unitOrders` on the state, persisted in `SAVE_VERSION = 5`),
  `resolveBattle()` + `getNextBattle()` (units are never lost — post-battle counts
  are restored), the Army tab (`components/ArmyPanel.tsx`; roster window =
  current age + previous age, age = first unentered age after completed ages) and the `unit` Gamepedia
  category with per-stat subtabs. Unit icons are vendored game-icons.net SVGs
  (`public/units/`, CC BY 3.0 — regenerate with `node tools/gen/icons.mjs`).
  **Implemented (trade slice):** trade routes in `src/game/trade.ts` + the Trade tab
  (`components/TradePanel.tsx`). Each route has an on/off toggle, a buy/sell toggle
  and a 0–100% intensity slider. Each second a route asks for
  `resources.trade × intensity` as a gold value (**the banked reserve, never the
  income, and never spent**) and moves `goldValue × production(resource) /
production(gold)` units — a tenth of that when buying, the spread. **Both legs are
  capped by what the settlement actually holds**: a sale is limited by the stock and
  credits the gold that stock is worth, a purchase by the purse and buys what the
  purse covers. The price comes from the production ratio against gold (static
  `tradeRatios` as the zero-rate fallback), read from `baseProductionFactors()` so a
  route cannot price itself.

  Both legs are `drain` rows in `getProductionFactors()` — debits positive, credits
  negative — so **nothing a route does picks up the production multipliers** (the
  factor model multiplies `additional` rows and subtracts `drain` rows) and every
  effect a route has lands in the Gamepedia's **Drain** list, labelled
  `food route` / `food route sale` / `food route purchase`, rather than needing an Add
  row. Values are recomputed from the state on every read, so a drain is replaced
  each tick and never stacked, and the normal tick applies them like any other
  production or upkeep — no separate trade step. Routes live on the state
  (`tradeRoutes`, all configured routes written including disabled ones to preserve
  intensity settings, persisted in `SAVE_VERSION = 6`), the cap on how many run at
  once is the `tradeRoutes` stat (base 1, so an `attributeFlat` bonus opens a further
  route). Each card shows the whole chain — `<n> trade power → +X food −Y gold per
  second`, computed even while the route is off — and the header states the value
  (1 trade power = 1 gold). The gold card and the old trade-power conversion are gone.
  **Not yet implemented:** saves, ages, research,
  offline progress (trade routes do not run offline), `attributeDrain`/`costReductionFlat` bonus data, unit
  retirement (old units stay owned and counted in army power), more than one
  simultaneous route (nothing grants the second slot yet).
  Full bonus/buyable/upgrade design: **§13**.

- **Current implementation target: the first loop** — one playthrough from Ancient through
  the 10-billion population goal and the colony-ship launch. Prestige is deliberately
  **deferred**; only its design constraints are honoured now (§13.7).

---

## 2. Golden rules (non-negotiable)

1. **The domain layer must stay React-free.** Nothing under `src/game/` may import
   React, DOM APIs, or UI modules. Game rules live in `src/game/`, rendering lives in
   `src/App.tsx` and `src/components/`. This is the project's core architectural
   promise (`docs/roadmap.md` → Direction) and currently holds true — keep it that way.
2. **Immutable state transitions.** `CivilizationState` methods return a **new**
   instance and never mutate `this`. The established no-op idiom is to return `this`
   unchanged, so callers can test `next === state`. Follow both halves of that idiom.
3. **Use `ExpNumber` for anything that can grow without bound** — resource amounts,
   production rates, multipliers, building costs. Use plain `number` for counts,
   indices, tick rates, worker counts, and array lengths. Never let an idle-game
   quantity sit in a JS double (it overflows to `Infinity` around 1.8e308).
4. **Stable IDs, never display names, as identifiers.** IDs are camelCase
   (`lumberYard`, `goldMine`, `townHall`). Saves, achievements, statistics and
   Gamepedia references will all key off them, so renaming an ID is a breaking change.
5. **Do not add per-content conditionals to the engine.** No `if (buildingKey === "farm")`
   in new simulation code. Definitions carry data + effects; the engine reads them.
   (A handful of legacy special cases exist — see §9 — do not add more.) New effects
   should be authored as bonuses in the planned model described in §13.
6. **Respect the TypeScript config invariants** (`verbatimModuleSyntax`,
   `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`). Details in §6.
7. **The user owns git — see §7 "Version control".** Never commit or `git reset`;
   `git stash` only if you pop it back; never `git clean`/`checkout --`/discarding
   `restore`/force flags. Ask the user to commit. Do not destroy files.
   `temp/` is not a scratch or cleanup folder; it may contain user-owned work.
   Never delete, clean, truncate, or remove anything in `temp/`.
   `scratch/` is the AI scratch folder; put disposable scratch artifacts there.
8. **Ship original content.** No Civilization-specific names, text, artwork, or other
   protected assets. Broad historical/4X inspiration is fine; copying is not.
9. **Validate before claiming done.** `npm run build` (which runs `tsc -b && vite build`)
   must pass, ideally plus `npm run lint`.

---

## 3. Repository map

```text
idle-civ/
  AGENTS.md                 <- you are here
  README.md                 getting started / Vite template notes
  docs/roadmap.md           the design + milestone source of truth (long, read it)
  docs/game-scope.md        AI-readable content & scope manifest (snapshot; refresh after big content changes)
  index.html                Vite entry, mounts <div id="root">, favicon.svg
  package.json              scripts: dev / build / lint / preview  (no test script)
  vite.config.ts            @vitejs/plugin-react only, no aliases, no path mapping
  tsconfig.json             solution file -> tsconfig.app.json + tsconfig.node.json
  .oxlintrc.json            plugins react/typescript/oxc, 2 explicit rules
  .vscode/                  tasks (Start Vite, Build), chrome launch, PATH + Prettier
  public/                   favicon.svg (used), icons.svg (currently unused), units/ (79 vendored unit SVGs + ATTRIBUTION.md)
  tools/node/               vendored Node v22.23.2 + npm 10.9.8 (PATH is patched to it)
  tools/gen/                data + icon generators (units.mjs, battles.mjs, techtree.mjs, researchLayout.mjs, icons.mjs + icon-index.txt)
  tools/simulation/         headless simulator, strategies, benchmarks, optimization tools and their tests
  temp/                     exploratory prototypes: battle.ts, campaign_v2.json, unit100-v3.json
  sim-output/               GITIGNORED simulation output: snapshot CSVs/ODS, balance-plan.*, age_*_analysis.csv
  src/
    main.tsx                createRoot + <StrictMode> + styles.css
    App.tsx                 the single-screen UI shell (tabs, game loop, dev tools)
    styles.css              one global stylesheet, CSS custom properties
    components/
      GamepediaModal.tsx    codex modal: list, search, per-category detail views
      ArmyPanel.tsx         Army tab: unit roster, buy path, battle panel (1 round/sec playback)
      ResearchPanel.tsx     Research tab: the technology tree grid + arrow overlay
      TradePanel.tsx        Trade tab: one market route per tradable resource (on/off, buy/sell, 0–100% intensity)
      unitIcons.ts          per-unit icon resolution (vendored SVG map + lucide fallback)
    game/                   pure domain layer, zero React imports
      gameObject.ts         abstract GameObject base (id, description, seen)
      attributes.ts         attribute (resource/capacity/stat) keys, definitions, factor model, rates
      buildings.ts          BuildingDefinition + the 12 building definitions
      bonus.ts              Bonus union + factories + cost-reduction folding (§13.1)
      upgrades.ts           UpgradeDefinition registry (JSON-backed) + unlock gates
      encounters.ts         EncounterDefinition registry (JSON-backed), victory bonuses
      units.ts              UnitDefinition registry (JSON-backed), stat scopes, power
      battle.ts             deterministic stack battle simulation + armyPower
      achievements.ts       AchievementDefinition registry (JSON-backed) + requirements + rewards
      statistics.ts         Statistics type: clicks, buildings built, play time, best times
      trade.ts              trade routes: the price model (production ratio vs gold), the spread, route settings
      data/                 JSON definition payloads (buildings, upgrades, encounters, achievements, stats)
      workerProduction.ts   WorkerProduction: per-resource worker + auto-click maths
      civilizationState.ts  the engine: state, tick, gather, build, workers, costs (585 lines)
      gamepedia.ts          registry + relation graph (module-level registration)
      expNumber.ts          extended-precision number (mantissa/exponent as doubles)
      numberFormat.ts       scientific / engineering / named / compact formatting
```

---

## 4. Architecture and domain model

### 4.1 Layering

```text
React components (App.tsx, GamepediaModal.tsx)
        │  read state fields, call methods, format with formatNumber()
        ▼
Engine (civilizationState.ts)  ── mutates nothing, returns new state
        │  reads definitions + factor model
        ▼
Definitions (attributes.ts, buildings.ts) + registries (gamepedia.ts) + numeric core (expNumber.ts)
```

Rules of thumb:

- Components may compute **presentation** (icons, tones, labels, layout). They must not
  compute **game rules**. If a component needs a number the engine does not expose,
  add a getter to `CivilizationState`.
- Domain modules import each other freely; they must never import from `src/` root,
  `src/components/`, or React.

### 4.2 `GameObject` (`src/game/gameObject.ts`)

```ts
export abstract class GameObject {
  readonly id: string;
  readonly description: string;
  seen = false;              // discovery flag used by Gamepedia
  protected constructor(id: string, description: string) { ... }
}
```

Every definition type extends it. `id` is the stable key; for `AttributeDefinition` the
id equals its `key`. `seen` starts `false` and is flipped by registration/reveal so
undiscovered content stays hidden from the player.

### 4.3 Attributes — resources, capacities and stats (`src/game/attributes.ts`)

Every value a bonus destination can name is an **attribute** (§13.2), registered in one
`attributeDefinitions` list with an `AttributeFamily`:

- `"amount"` — the four `ProductionResourceKey`s (`"food" | "wood" | "stone" | "gold"` —
  worker-assignable; `WorkerAssignments` is a `Record` of exactly these four) plus the
  tracked `population`/`science`/`military`/`metalwork` resources.
- `"capacity"` — `CapacityResourceKey` = `` `${buildingKey}Capacity` `` — **capacity is
  stored as a resource**. Eleven exist today, one per building, defaulting to 10 in
  `emptyResourceAmounts()` (town-hall to 1).
- `"derived"` — `DerivedAttributeKey` (`clickPower`, `autoClickRate`): computed stats,
  never stored (§13.2 decision 2).

- **JSON numeric rule (AGENTS.md §4.3 addition):** when you write JSON data files that
  hold numbers later read by `ExpNumber`, use **scientific notation** for any numeric
  literal `> 1,000,000` (e.g. `"4.173e3"`, `"3.4013865e7"`, `"4.081946632061209e+43"`).
  This keeps JSON source readable and avoids precision drift versus the `ExpNumber` /
  `ExpNumber.from()` path. Player-facing formatting still goes through `formatNumber()`
  (§4.7); this rule applies to data authored in JSON only.

Supporting shapes: `ResourceAmounts` (`Record<ResourceKey, ExpNumber>`),
`ResourceFactor = readonly [AttributeDefinition | string, ExpNumber]`,
`ResourceFactors = { additional, multiplicative, additiveMultiplier, drain }`, and

The single rate formula lives here:

```ts
computeResourceRate({ additional, multiplicative, additiveMultiplier, drain })
  = (Σ additional) × (Π multiplicative) × (1 + Σ additiveMultiplier)
    − (Σ drain)
```

A factor's source is either an `AttributeDefinition` (rendered with its label) or a
free-form `string` (a building key, `"manual click"`, `"dev auto clicker"`). Because
building keys are Gamepedia ids, the Gamepedia modal turns factor sources into links.

### 4.4 Buildings and cost scaling (`src/game/buildings.ts`)

```ts
type BuildingCost = {
  resource: ResourceKey;
  base: ExpNumber;
  factor: number;
  exponent: number;
};
type BuildingEffects = {
  capacityProvided?: { building: BuildingKey; perBuilding: ExpNumber };
  additiveMultiplier?: { resource: ResourceKey; perBuilding: ExpNumber };
  resourceDrain?: { resource: ResourceKey; amount: ExpNumber };
};
```

`BuildingDefinition` fields: `key` (= id), `name`, `description`, `costs`, `available`,
`maxCount` (default 10), `effects`, `power`, `unlock`.

- `power` is the base of that building's `${key}Power` derived stat, and it is **data** —
  a `power` field on the JSON entry (default 1), so a building can start above or below 1
  and the engine reads the value instead of a hardcoded constant. Only buildings with a
  production effect get one; `house`, `town-hall` and `people` carry none.

- **Cost data is per entry, not one global building factor:** citizens use 2.5, primary
  production buildings 8, barracks/university wood+food 10 (stone 12), town halls 15,
  and smithy/market 12. The Age-0 unit generator likewise uses factor 5 except the
  Tribesman (4) and Bronze Spearman/Axeman (3); their base costs are explicit in
  `tools/gen/units.mjs`. Research is **priced by the age the player is in**, not
  globally: each age carries a `research: { base, factor, exponent }` in `ages.json` and
  prices purchase `n` of that age at `base × factor^((n^exponent) − 1)`
  (`exponent` 0.5 = the square-root curve), where `n` counts
  only research bought _in that age_. The pricing age is `getCurrentAge()` — the age
  the player has advanced **into** by _completing_ the previous one (its battles +
  its building target) and taking that age's completion reward. Age bonuses in
  `ages.json` are **completion rewards**, not entry bonuses: they are paid out by
  `enterAge(id)` for the age named `id`, so Ancient's rewards arrive when Ancient is
  completed and the player moves into the Iron Age. Advancing resets `n` to 0, and a
  tech bought from an earlier age costs the current age's next price without advancing
  `n`. `research.json` does not contain per-tech costs. Research is a **buyable**
  like buildings and units — it takes the same four cost-reduction types, folding
  them **per unit** in the §13.1 order `base → factor → percent → flat`, clamped at 0.
  It is not a building, though, so only a bonus naming `"research"` explicitly
  reaches it; the blanket `allBuildings` reductions and the global
  `buildingCostMultiplier` stat do not (`getResearchCostModifiers()` enforces this).

- Cumulative curve: `T(n) = base × factor^(n^exponent − 1)` is the total spent
  owning `n` units, so unit `n` costs `T(n) − T(n−1)` and buying `count` more from
  `alreadyBuilt` is one subtraction, `T(alreadyBuilt + count) − T(alreadyBuilt)`,
  rounded up. Cost entries default to exponent `0.5`; ages already set this for
  research schedules. The engine keeps the existing linear early-cost floor before
  switching to the exponent curve. `costAt()` and `formatCost()` on the definition
  were removed with the geometric series.
- `maxCount` is **not** the live limit: the live limit is the building's capacity
  resource (also 10 by default), raised via `CivilizationState.upgradeBuildingLimit()`.
  Treat `maxCount` as decorative metadata, not authority.

The 11 definitions, in order (order matters — it drives `autoBuyBuildings()` and the
building grid order, which roughly tracks progression): `people` ("Citizen", costs food,
drains 1 food/sec each), `house`, `farm`, `lumber-yard`, `quarry`, `gold-mine`,
`town-hall`, `barracks`, `university`, `smithy`, `market`.

**Production buildings come in two tiers.** Membership is data, not an engine branch: it is
derived from the `effects` a definition carries (`attributes.ts` →
`buildingPowerAttributeDefinitions` filters on `additiveMultiplier || resourceProduction`),
so both tiers run through identical code paths and each owns a `${key}Power` stat.

|           | **Primary** — `farm`, `lumber-yard`, `quarry`, `gold-mine`  | **Advanced** — `barracks`, `university`, `smithy`, `market`                                     |
| --------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Boosts    | a worker-assignable resource (`food`/`wood`/`stone`/`gold`) | a building resource (`military`/`science`/`metalwork`/`trade`)                                  |
| Effect    | `additiveMultiplier` `+10%` each                            | `resourceProduction` `+1/s` each **plus** `additiveMultiplier` `+5%` (market has no multiplier) |
| Workers   | needs workers assigned                                      | self-sustaining                                                                                 |
| Unlock    | available from the start                                    | 90 citizens / `age0_1_first_fire` / 5 town halls / `age-1`                                      |
| Enhancers | 8 tiers, **grant `×10` capacity**                           | 8 tiers, **no capacity bonus** — power + production only                                        |

Because the advanced enhancers grant no capacity, barracks/university/smithy/market are
capped at their base capacity of 10 and only tier 1 (threshold 9) of each 8-tier chain is
reachable today. Do not assume the advanced chains are live past tier 1 without first
adding a capacity source (research/age bonus) or rescaling the thresholds.

Other data conventions: `house` gives `+10 peopleCapacity`; `town-hall` gives
`+10 houseCapacity` plus `+1` barracks and university each.

`effects` is a **per-building stopgap**. The target model is a shared
`bonuses: Bonus[]` list whose destinations are resources _or_ buyables (buildings and
units), with resource bonuses reusing today's factor model and four new cost-reduction
types — full spec in §13. Nothing of that is implemented; keep authoring `effects` data
as it is until that work is scheduled, and do not add a third effect shape in the
meantime.

### 4.5 `CivilizationState` — the engine (`src/game/civilizationState.ts`)

Immutable state holding `resources`, `workers`, `builtBuildings` (one string entry per
built building), `resourceFactors`, `buildingCostOverrides`, `autoClicksPerSecond`, the
id lists `boughtUpgrades`, `defeatedEncounters`, `enteredAges`, `earnedAchievements`,
and `statistics` (`src/game/statistics.ts`).

Getters: `population` (= `resources.population`), `maximumPopulation` /
`housingCapacity` (= `peopleCapacity`), `assignedWorkers`, `availableWorkers`.

| Method                                              | Behaviour                                                                                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tick()`                                            | Applies `computeResourceRate()` to each **production** resource (clamped at 0), advances both play-time counters by one second, records the current ordered age, then `checkAchievements()`               |
| `gather(key)`                                       | Adds `computeClickGain(key)` = `clickPower × productionPerWorker × Π multipliers` (drains excluded) and counts one production click                                                                       |
| `assignWorker` / `unassignWorker`                   | Clamped by available workers / current count                                                                                                                                                              |
| `autoAssignWorkers(count = Infinity)`               | Assigns all idle workers (or up to `count`); keeps food ≈ 10× the other resources while equalising the others                                                                                             |
| `build(key, count)`                                 | No-op unless `canBuild()`; subtracts cost, applies special resource deltas, appends ids, adds to the cumulative building counters                                                                         |
| `autoBuyBuildings()`                                | One pass in definition order, buying `getMaxAffordableBuildings()` each                                                                                                                                   |
| `upgradeBuildingLimit(key, slots)`                  | Raises `` `${key}Capacity` ``                                                                                                                                                                             |
| `upgradeBuildingCosts(key, costs)`                  | Per-building cost override (for future upgrades)                                                                                                                                                          |
| `addFactor(key, type, factor)`                      | Appends a factor (for future upgrades/research)                                                                                                                                                           |
| `setAutoClicksPerSecond(n)`                         | Dev-tools auto clicker (also the current `autoClickRate` stat value)                                                                                                                                      |
| `recordUiClick()`                                   | Counts one click anywhere in the UI shell (production clicks are counted by `gather()`)                                                                                                                   |
| `computeClickPower()`                               | The global click power stat: base 1, `attributeFlat` bonuses sum, `attributeMultiplier` bonuses compound                                                                                                  |
| `getAttributeValue(key)`                            | Current value of any attribute: computed for derived stats, stored amount/capacity base otherwise                                                                                                         |
| `getDerivedAttributeFactors(key)`                   | Base term + every active flat/multiplier bonus targeting a derived attribute, paired with source ids (feeds the Gamepedia stat page)                                                                      |
| `getTradeRoute(id)` / `setTradeRoute(id, patch)`    | Trade-route settings (on/off, buy/sell, 0–1 intensity share of the trade power bank). Enabling one is refused while every slot is taken; a no-op patch returns `this`                                     |
| `getActiveTradeRoutes()` / `getTradeRouteSlots()`   | The routes running, and how many may (the `tradeRoutes` stat, based at 1 — an `attributeFlat` bonus opens a further slot with no engine change)                                                           |
| `getTradePrice(id)` / `getTradeRouteThroughput(id)` | The live mid price from the production ratio vs gold (read from `baseProductionFactors`, so a route's own legs cannot price it), and the chain the card shows: banked trade power → goods/gold per second |
| `getTradePowerRate()`                               | Trade power income per second — what markets and their boosts produce                                                                                                                                     |
| `buyUpgrade(id)`                                    | No-op unless unlocked and affordable; pays the cost and appends the id                                                                                                                                    |
| `defeatEncounter(id)`                               | Idempotent; appends the encounter id and records the fastest victory time                                                                                                                                 |
| `enterAge(id)`                                      | Idempotent; appends the age id and records the fastest entry time                                                                                                                                         |
| `checkAchievements()`                               | Appends every achievement whose requirement is met; returns `this` when nothing is new                                                                                                                    |

Queries: `getFactors`, `computeResourceRate`, `computeClickGain`, `getBuildingMax`,
`getBuildingCost`, `formatBuildingCost`, `getMaxAffordableBuildings`,
`getBuildingCount`, `isBuildingAtCapacity`, `hasResourcesForBuilding`,
`isBuildingAvailable`, `getBuildFailureReason`, `isUpgradeUnlocked`,
`isUpgradeBought`, `getUpgradeCost`, `hasResourcesForUpgrade`,
`getUpgradeFailureReason`, `isAchievementEarned`, `getFastestAgeTime`,
`getFastestBattleTime`.

`getBuildFailureReason()` returns `"locked" | "capacity" | "resources" | null`; the UI
switches on that vocabulary to pick its notice text, so keep the strings stable.

Notable internals: `getFactors()` merges worker production (only for production keys,
phrased as a `WorkerProduction` source), a `"dev auto clicker"` entry when
`autoClicksPerSecond > 0`, caller-added factors from `resourceFactors`, and building
`additiveMultiplier` (per-building bonus × count, **summed**) /
`resourceDrain.amount × count` contributions.
`computeClickGain()` is the only click path: it multiplies the global click power stat by
the resource's `productionPerWorker` and the resource multipliers, and names the factor
source after the `clickPower` stat so the Gamepedia links it.
`activeBonuses()` is the single bonus seam: bought upgrades + defeated encounters +
earned achievements, each paired with its source id, feeding `getFactors()`,
`getBuildingMax()`, `getBuildingCost()` and `computeClickPower()`.
`getMaxAffordableBuildings()` caps its search at 1,000,000 and uses a doubling probe
plus binary search, so MAX stays O(log n) with O(1) cost checks.

### 4.6 Gamepedia (`src/game/gamepedia.ts`)

A `Map<string, GamepediaEntry>` where
`GamepediaEntry = { object: GameObject; category; relatedIds: string[] }` and
`GamepediaCategory = "resource" | "capacity" | "building" | "unit" | "upgrade"
| "achievement" | "stat" | "research" | "combat"`.

API: `register` (throws on duplicate id), `get`, `require` (throws on unknown),
`relatedTo` (filters out undiscovered entries), `reveal`, `visible` (discovered only —
use this for anything player-facing), `search` (over id/name/label/description of
visible entries), `buildRelations()` (makes `relatedIds` bidirectional), `all()`
(everything, including undiscovered — engine-internal lookups only).

**Registration happens as a module side effect at import time:** every attribute
definition — amounts, capacities and derived stats (all `seen = true`), then buildings
(`seen = building.available`), then upgrades, encounters and achievements (`seen` stays
`false` — the App reveals them when their unlock fires / the encounter is won / the
achievement is earned), then `buildRelations()`. Consequences:

- Importing `gamepedia.ts` is enough to populate it; never build a second registry.
- Building `relatedIds` are derived automatically from costs and effects
  (cost resources, multiplier target, drain target, `capacityProvided.building`).
  Upgrades and encounters derive them from their bonus destinations, and achievements
  from their requirement target (resource, `population`, building or encounter id).
- `buildingsForResource(resourceId)` returns buildings linked to a resource.

`resource`, `capacity`, `building`, `unit`, `upgrade`, `achievement`, `stat` and
`combat` entries exist today (combat holds the campaign encounters; upgrades hold the 64
enhancer tiers; `stat` holds `clickPower`, `autoClickRate` and `armyPower`, all
`seen = true` because computed values are visible from the start). The `research`
category is wired through the types and the modal tabs but carries no data, so that tab
shows "Nothing discovered here yet". `capacity` entries have no tab of their own; they
are reached through links from buildings and factors.

Unit entries derive `relatedIds` from their cost resources, and battle entries link
their `enemyArmy` unit ids; the modal's unit page shows the unit's description and a
per-stat subtab grid, the battle page shows the historical blurb and the enemy roster.

### 4.7 Numbers: `ExpNumber` + `formatNumber`

`ExpNumber` stores `sign (−1|0|1) × mantissa [1,10) × 10^exponent`, with the exponent
itself a double — range ≈ 10^(1.8e308), precision ≈ 15 significant digits. Constants
`ZERO`, `ONE`, `TEN`, `INFINITY`, `NEGATIVE_INFINITY`, `NAN`; constructors `from`,
`fromNumber`, `fromLog10`, `max`, `min`; predicates `isZero`, `isNegative`, `isFinite`;
ops `neg`, `abs`, `add`, `sub`, `mul`, `div`, `pow(number | ExpNumber)`, `floor`, `ceil`;
comparisons `eq/gt/gte/lt/lte/compareTo`; `toString()` (e.g. `"1.23e9"`, `"Infinity"`,
`"NaN"`).

Gotchas: `floor()`/`ceil()` are **no-ops above 1e308** (they return `this`); dividing by
zero yields ±`INFINITY`; `0/0` yields `NAN`; `NaN` comparisons are meaningless; `pow`
with a negative base and a non-integer exponent yields `NAN`.

`formatNumber(value, format)` accepts an `ExpNumber` **or** a plain number, in four
formats: `"scientific"` (`1.23e9`), `"engineering"` (`12.35e9`, exponent a multiple of
3 and omitted below 1000), `"named"` (`1.23K/M/B/T/Qa…Tr`, falling back to
Excel-style column letters) and `"compact"` (`1.23C`, Excel-style `A…Z, AA…ZZ,
AAA…`). `|value| < 1` renders as `"0"`;
two decimals; past `Number.MAX_SAFE_INTEGER` the exponent itself prints in scientific
notation. `compactSuffix(tier)` is exported for reuse.

Always pipe user-visible numbers through `formatNumber` (`App.tsx` wraps it as
`const fmt = (n) => formatNumber(n, numberFormat)`); never render a raw `ExpNumber`
in the UI. The Gamepedia modal floors first via its local `formatAmount()`.
Durations (play time, fastest-run records) go through `formatDuration(ms)`
("3d 4h 5m" / "1h 2m 5s" / "1m 5s" / "0s"), also in `numberFormat.ts`.

### 4.8 `WorkerProduction` (`src/game/workerProduction.ts`)

Extends `AttributeDefinition` and adds `workers`, `autoClicksPerSecond`,
`productionPerClick`. Derived: `workerProduction` (= `workers × productionPerWorker`),
`autoClickProduction` (= `autoClicksPerSecond × productionPerClick`), `totalProduction`
(= their sum). `assignWorker()` / `unassignWorker()` return new instances. Its
constructor defaults every argument, so passing `undefined` for `workers` (which happens
when a non-production key is used) silently yields `ExpNumber.ZERO` rather than throwing
— convenient, but do not design around it.

---

## 5. UI conventions

### 5.1 `src/App.tsx` (single screen, no sub-components extracted yet)

- Layout: `.app-shell` is a 3-column CSS grid — `sidebar` (brand, hardcoded era card,
  tab list, resource summary, cosmetic "Autosaving" footer), `world-panel` (breadcrumb
  topbar + per-tab content + notice bar), `buildings-panel` (building grid), plus a
  floating `.fab-container` with the multiplier buttons and the Pedia FAB.
- Tabs (`Tab` type + `tabs` array): `Production`, `Upgrades`, `Achievements`,
  `Army`, `Research`, `Trade`, `Settings`, `Stats`, `Dev Tools`, rendered inline via
  `{activeTab === "X" && (...)}`. **`Army` renders `components/ArmyPanel.tsx`**
  (roster + battle panel; it opens only once a battle has been revealed/won),
  **`Trade` renders `components/TradePanel.tsx`** (one market route per tradable
  resource — on/off, buy/sell and a 0–100% intensity slider; the tab opens with
  the market at `age1`),
  `Research` still renders no section at all
  (blank content area) and `Achievements` renders one
  cumulative card per milestone-chain `family` — earned tiers' rewards, live progress via
  `getNextAchievementGoal()`/`getRequirementValue()`, `locked`/`partial`/`complete`
  states — plus the singleton achievements with earned/locked states, and clicking a
  card opens its Gamepedia page;
  `Stats` renders the tracked `gameState.statistics` (clicks, play time, buildings built,
  fastest age/battle records) plus one clickable card per `derivedAttributeDefinitions`
  entry that opens that stat's Gamepedia page. The
  era card is hardcoded ("Neolithic Dawn", "Year 12", "68% to Bronze Age") — see §9.
- UI clicks are counted once per click by an `onClickCapture` handler on `<main>` that
  calls `gameState.recordUiClick()`, skipping anything inside a `[data-production-click]`
  element (the gather buttons, which the engine counts as production clicks instead).
- Game loop: one `useEffect` with `window.setInterval(..., 1000)` that calls `tick()`
  and then `autoBuyBuildings()` / `autoAssignWorkers()` when the Dev Tools toggles are
  on. Every update goes through `setGameState((current) => ...)` — keep it that way so
  ticks and clicks never race.
- Number format is the only persisted state: `localStorage` key
  `idle-civ:number-format`, default `"named"`, read/written in `try/catch`-wrapped
  effects (private-mode safety). Follow that pattern for new preferences.
- Multiplier control: `1 | 10 | 100 … 1e9 | "Max"` (`Multiplier` type); the chosen large
  value is remembered in `largeMultiplier`. `"Max"` becomes `Infinity` for worker
  actions and `getMaxAffordableBuildings()` for purchases. Gathering ignores the
  multiplier (the `+1` label is literal).
- Notices are `ReactNode`, so they can embed a link button (`className="notice-link"`)
  that switches tabs — see `buyBuilding()` for the pattern.
- Icons come from `lucide-react` only, always with explicit `size` and `strokeWidth`
  (`1.7`–`1.9`). Presentation maps (`resourcePresentation`, `buildingPresentation`,
  `summaryResources`, `productionOrder`) hold icon + tone per id.
- Accessibility is expected: `aria-label` on icon-only buttons, `role="dialog"` +
  `aria-modal` + `aria-labelledby` on the modal, `aria-pressed` on toggles,
  `role="tablist"` + `aria-selected` for tab groups, `type="button"` on every button.

### 5.2 `src/styles.css` (one global stylesheet, ~1356 lines)

- No CSS modules, no Tailwind, no styled-components: add a class here, and reuse an
  existing class when the shape already exists.
- Tokens are custom properties on `:root`: `--ink`, `--ink-soft`, `--paper`,
  `--paper-deep`, `--muted`, `--line`, `--accent`, `--accent-soft`, `--warm`. Use those
  rather than new literal colors.
- Fonts are `@import`ed from Google Fonts (Manrope, DM Mono, Playfair Display) — expect
  degraded styling offline.
- "Tone" classes drive color: `teal`, `gold`, `green`, `slate`, `amber`, `violet`,
  `red`, `orange`, `blue`, `pink`, `locked`. They are shared between `.resource-icon.*`,
  `.building-icon.*` and (light palette) `.unit-icon.*`, so adding a tone means adding
  every selector group.
- Class names are flat, lowercase, hyphenated and named after their block
  (`.gamepedia-detail-header`, `.factor-row`, `.multiplier-button`).

---

## 6. Code style and tooling invariants

Observed style (match the surrounding file; there is no formatter config to lean on):
2-space indent, double quotes, semicolons, trailing commas, ~80 column soft wrap,
one component per file with a `default export` for components and named exports for
domain symbols. Classes are used for domain definitions (declared `readonly` fields,
assigned in the constructor); helpers are `const` arrow functions.

**Indentation convention (mandatory):** All files use 2-space indentation, no tabs.
This applies to TypeScript/TSX (`.ts`, `.tsx`), JSON (`.json`), and all other source
files in the repository. Do not mix indentation styles within a file. When editing an
existing file, match its current indentation — do not reformat the whole file to a
different style. JSON data files (`data/*.json`) follow the same 2-space rule as the
rest of the codebase. For JSON files specifically: every value (object, array, or
primitive) that is followed by a comma ends its line with that comma — never put a
trailing comma after the last item in an object or array. Opening braces/brackets start
a new line for their content; closing braces/brackets go on their own line at the
indentation of the opening line. This convention exists so that indentation is consistent
across contributions and not every model changes it differently.

**JSON compactness (mandatory):** Keep JSON data files compact unless an entry genuinely
benefits from expansion. Small nested objects/arrays (e.g. a 2–3 field `requirement` or a
single-element `bonuses` entry) stay on one line: `"requirement": { "type": "population", "amount": 25 }`.
Expand only when a line would exceed ~100 characters or the structure is hard to read
(e.g. a `bonuses` array with multiple elements). When adding new entries, follow the
compact style already used by nearby entries — never run `JSON.stringify(data, null, 2)`
over a file that already has mixed compact/expanded formatting, because that silently
rewrites every short form into an expanded form and drowns the real diff. To rewrite a
JSON file cleanly, use `node` with a format that preserves the existing compact style or
hand-author each entry; do not use PowerShell `Set-Content` (it writes CRLF and corrupts
line-ending-sensitive tools like `guids.mjs`).

TypeScript hard requirements imposed by the tsconfigs:

- `verbatimModuleSyntax: true` → use `import type { X }` for type-only imports (and
  inline `type` specifiers like `import { type ReactNode }`). Do not mix value/type
  imports incorrectly.
- `erasableSyntaxOnly: true` → **no `enum`**, no `namespace`, no parameter properties
  (`constructor(private x: T)`), no `import x = require(...)`. This is exactly why the
  codebase uses string-literal union types and explicitly assigned fields.
- `noUnusedLocals` / `noUnusedParameters: true` → unused locals or parameters fail the
  build. Prefix intentionally unused parameters with `_` if ever needed.
- `noFallthroughCasesInSwitch: true`, `moduleDetection: "force"`, `noEmit: true`.
- `jsx: "react-jsx"` → no `import React` needed; import only the hooks you use.
- `tsconfig.app.json` includes only `src`; `tsconfig.node.json` covers
  `vite.config.ts` only. Code in `temp/` is **not** type-checked and must not be
  imported from `src/`.
- Note the configs do **not** enable `strict`. Null/undefined are unchecked, so add
  explicit guards; do not assume the compiler will catch a missing field.

Linting: `oxlint` with the `react`, `typescript` and `oxc` plugins and two explicit
rules (`react/rules-of-hooks: error`, `react/only-export-components: warn` with
`allowConstantExport`). `typeAware` is off. Lint must stay clean (0 warnings / 0 errors).

Formatting: `.vscode/settings.json` sets Prettier (`esbenp.prettier-vscode`, also in
`.vscode/extensions.json` recommendations) as the default formatter with
`formatOnSave`, but there is **no `.prettierrc` and no prettier dependency** — Prettier
defaults plus whatever the last editor wrote. Match the file you are editing.

Comments: JSDoc only where the intent is non-obvious (tricky maths, registry semantics,
gotchas) — see `expNumber.ts` and the JSDoc above `getMaxAffordableBuildings()`. Avoid
narration comments that restate the code.

CSS/entity note: `App.tsx` uses HTML entities (`&rarr;`) inside JSX text; keep that if
you extend those strings.

---

## 7. Commands and validation workflow

Node and npm are **vendored in the repo** (`tools/node/`, Node v22.23.2 / npm 10.9.8) and
`.vscode/settings.json` prepends them to `PATH` for integrated terminals. If `node` is
not on your `PATH`, call them explicitly:

```powershell
cd d:\work\dev\idle-civ
.\tools\node\npm.cmd run <script>
```

Available scripts (this is the whole list — there is **no `test` script**):

| Script            | Runs                                                     | When                                          |
| ----------------- | -------------------------------------------------------- | --------------------------------------------- |
| `npm run dev`     | `vite` (dev server; VS Code task binds `127.0.0.1:5173`) | interactive development                       |
| `npm run build`   | `tsc -b && vite build`                                   | **required** before declaring work done       |
| `npm run lint`    | `oxlint`                                                 | **required**, currently 0 warnings / 0 errors |
| `npm run preview` | `vite preview` (serves `dist/`)                          | checking a production build                   |

VS Code integration: task **"Idle Civ: Build"** (default build task, `$tsc` problem
matcher) and **"Idle Civ: Start Vite"** (background task), used as the `preLaunchTask` of
the **"Idle Civ: Run and Debug"** Chrome launch on `http://127.0.0.1:5173/`.

Validation ladder — do the narrowest useful thing, then the full build:

1. Re-read the owning module and one nearby usage before editing.
2. For engine changes, trace the numbers by hand (or with a scratch script) since there
   is no test runner.
3. `npm run build` — this is the real gate; TypeScript errors are build failures.
4. `npm run lint` — keep it at zero.
5. `npm run dev` + click through the affected screen when the change is visual.
6. Report: files changed, behaviour change, exact validation output, remaining risks.

### 7.1 Tool discipline — read, edit, compile in one pass

Models routinely spend 3–10 commands on a change that needs 2 rounds. The pattern that
works here: **batch everything, and never run a command to learn something this file
already tells you.**

**Reading files**

- Know which files you need? Read them **all in one parallel batch** — the file you will
  edit, one nearby usage, and the JSON payload that backs it. Do not read a 20-line
  slice at a guessed offset, see it is wrong, and guess again: read the whole file (or a
  generous range) **once**.
- Use the file-read tool for content, not shell `Get-Content` / `Select-String`.
- Search only when the location is genuinely unknown, and put **all queries in one
  call**; prefer precise regexes over broad keywords. Never re-search a file you are
  about to read anyway.

**Editing files**

- Use the edit tool with exact `old_text → new_text` chunks, and emit **all independent
  edits (different files, or non-overlapping regions of one file) in the same message**
  instead of one edit per turn.
- Never rewrite a whole file via shell heredoc/redirect, and never `sed`/PowerShell-
  replace inside tracked files.
- Do not re-read a file after every edit — the edit result confirms the change. Verify
  with the build; spot-read only the regions you are genuinely unsure about.

**Compiling / validating**

- Run both gates **in one batched command**, with output redirected (see PowerShell
  notes below) and scratch files cleaned up in the same command:

  ```powershell
  cmd /c ".\tools\node\npm.cmd run build > build_out.txt 2>&1"; cmd /c ".\tools\node\npm.cmd run lint > lint_out.txt 2>&1"; Get-Content build_out.txt -Tail 30; Get-Content lint_out.txt -Tail 10; Remove-Item build_out.txt, lint_out.txt
  ```

- `tsc` reports **all** errors at once — fix every reported error in one pass of edits,
  then rebuild once. Build-fix-build-fix loops are the main waste.
- Budget: a typical change is **one batch of reads → one batch of edits → one batched
  build + lint**. Exceeding that needs a stated reason (genuinely unknown code, a failed
  build), not a shrug.
- Do not probe the environment with commands for facts documented here: node/npm are
  vendored at `tools/node/`, the script list is above, `;` chains commands (not `&&`),
  and scratch artifacts belong in `scratch/`, never `temp/`.

**PowerShell notes:** chain commands with `;`, not `&&`. When a dev server or build
output matters, redirect to a file and read it back, because the integrated terminal
sometimes fails to capture streamed output:

```powershell
cmd /c ".\tools\node\npm.cmd run build > build_out.txt 2>&1"
Get-Content build_out.txt -Tail 30
Remove-Item build_out.txt
```

Do not leave scratch artifacts (output files, `dist/`, ad-hoc scripts) behind in the
tracked tree. `dist/` and `node_modules/` are already gitignored (`*.local` too).

Version control — **the user owns git.** Read-only git (`status`, `--no-pager log`,
`--no-pager diff`, `ls-files`) is fine and expected. Everything that changes the
repository is the user's call:

- **Never commit anything.** Do not run `git commit` yourself, ever — not to save
  work, not with a message you were given, not to "finish up". When work is ready,
  **ask the user to commit it** (and say exactly which files and why).
- **Never `git reset`** (any form) without explicit permission. If you need to set
  changes aside, **`git stash` is allowed — but you must `git stash pop` it back**
  before you finish; do not leave the user's work in a stash.
- **Never `git clean`, `git checkout --`, `git restore` (discarding), or any
  force flag** (`--amend`, `--force`, `--hard`). These destroy the user's work.
- Confirm `git status` shows nothing you introduced by accident before you finish.

**Always run git commands that may page with `--no-pager`** (e.g.
`git --no-pager log`, `git --no-pager diff`) — a paged command hangs the
non-interactive shell and aborts the run.

Tests: Vitest is installed (`npm test`, e.g. `src/game/saveSystem.test.ts` and
`src/game/dataIds.test.ts`); the offline-gain contract has a cross-language Python
check (`npm run test:cross-language`, `tools/simulation/tests/offline_gain_test.py`). Roadmap
milestones 8 and 10 still need deterministic combat and pacing tests — extend the
existing Vitest setup rather than adding another framework. Do not install any new
dependency without explaining why.

### 7.2 Simulation changes must be benchmarked before and after

> **Rule: any change under `tools/simulation/simulation.ts`, `tools/simulation/strategies.ts`,
> `tools/simulation/roi.ts`, `tools/simulation/tradeAdvisor.ts`, the engine's rate/cost/bonus paths
> (`getFactors`,
> `computeResourceRate`, `getBuildingCost`, `getResearchCostForCount`,
> `getBuildingEffects`, `activeBonuses`), or any `src/game/data/*.json` payload
> must be benchmarked against the recorded baseline both before and after. A
> simulation change is only correct if no strategy regresses.**

**Scope — which changes actually need the sweep.** The sweep is mandatory when the
edit touches **`tools/simulation/strategies.ts` (or another strategy layer in `tools/simulation/`), the
main engine** (the rate/cost/bonus paths listed above), or **`age0`** — the
opening age and the foundation every later age is measured against. A regression
there compounds through the whole campaign, so it has to be caught by measurement
rather than by argument.

**The other ages (`age1` and beyond) are explicitly out of scope.** They are still
being balanced, so their numbers move for reasons unrelated to your edit: a
before/after diff across them measures baseline drift, not your change, and the
result is uninterpretable either way. Rebalance them freely without the sweep, and
say so in the summary. When `age1` settles, this carve-out should be revisited.

Passing the unit tests is **not** sufficient evidence. The strategies are the
game's balance feedback loop, and the failure mode is silent: a cost or rate
change can make every strategy strictly worse (or strictly better) while every
assertion still passes, because the tests assert the mechanic rather than the
pacing. Never ship a tuning change on a green suite alone.

```powershell
# 1. Baseline (before the edit) — write to a scratch dir, not over the baseline.
.\tools\node\npx.cmd tsx tools\simulation\snapshot-csv.ts --horizon=7200 --interval=60 --out=sim-output\bench-before

# 2. Make the change.

# 3. After (identical horizon and interval; differing horizons are not
#    comparable and the result is meaningless).
.\tools\node\npx.cmd tsx tools\simulation\snapshot-csv.ts --horizon=7200 --interval=60 --out=sim-output\bench-after

# 4. Compare the headline columns per strategy (the list is just below).
.\tools\node\npx.cmd tsx tools\simulation\compare-bench.ts sim-output\bench-before sim-output\bench-after
```

Compare at least: `age`, `population`, `research_bought`, `battles_won`,
`total_buildings` and `army_power_total` at the final row, plus the time each
strategy first reaches `age-1`. Two rules for reading the result:

- **A regression must be intentional.** If a strategy gets worse and you did not
  mean it to, the change is wrong — widen the window, re-read the rate formula,
  and look for an unintended interaction rather than adjusting the constant
  until the number looks better.
- **Report the before/after numbers in the summary**, including the ones that
  got worse. A change that helps five strategies and quietly ruins a sixth is
  still a bug, and the summary is where that gets caught.

A single-strategy run is not enough — `tools/simulation/snapshot-csv.ts` takes strategy
names **positionally** (`tsx tools\simulation\snapshot-csv.ts balanced production ...`; there
is no `--strategy` flag), and the strategies deliberately compete for the same
resources, so an economy change that helps one usually costs another. Benchmark
**all** of them.

Every simulation artifact goes in **`sim-output/`**, which is gitignored — never
commit a snapshot. It is the default `--out` of `tools/simulation/snapshot-csv.ts`, and it is
where `npm run gen:balance` and `tools/simulation/simulate-age0-progression.mjs` write. Use a
fresh dated subdirectory per sweep (`sim-output\bench-before`, `-after`) so runs
never overwrite each other. `temp/` may contain user-owned files or source prototypes;
never use it for generated output, scratch work, or cleanup.

`sim-output/sim/` holds a 2-hour run (7 CSVs at 1-minute cadence) from the last full
sweep. Treat it as a **smoke test, not proof**: it is regenerated by hand, it
predates whatever is on the branch, and its `simulations.ods` can be mid-sync if
the workbook is open elsewhere. Always regenerate a fresh "before" run against the
current tree so the comparison is like-for-like — same `--horizon` and `--interval`
on both sides. Simulation runs themselves are deterministic and have no seed option.

---

## 8. Recipes

### 8.1 Adding a building

1. `src/game/buildings.ts` — add the key to the `BuildingKey` union **and** a
   `new BuildingDefinition(...)` entry to `buildingDefinitions`. Keep the array roughly
   in progression order, since it drives `autoBuyBuildings()` and the grid order.
2. `src/game/attributes.ts` — four edits for the matching capacity resource:
   `${key}Capacity` in the `CapacityResourceKey` union, an entry in
   `capacityDefinitions` (which feeds `attributeDefinitions`), a default in
   `emptyResourceAmounts()` (10 to match the existing convention) and a bucket in
   `emptyResourceFactors()`.
3. `src/App.tsx` — add `{ icon, tone }` to `buildingPresentation`, using a
   `lucide-react` icon and an existing tone.
4. `src/styles.css` — only if you introduced a new tone (add it for both
   `.resource-icon.<tone>` and `.building-icon.<tone>`).
5. `src/game/civilizationState.ts` — **only if** the building needs bespoke resource
   bookkeeping (like `people`/`house`/`town-hall` do). Prefer expressing behaviour as
   data in `effects`; the goal is that you need no engine edit at all.
6. Gamepedia picks it up automatically, deriving `relatedIds` from costs and effects.

### 8.2 Adding a production resource

`attributes.ts`: extend `ProductionResourceKey`, `productionDefinitions`,
`emptyResourceAmounts()`, `emptyWorkerAssignments()` and `emptyResourceFactors()`.
`App.tsx`: add to `resourcePresentation`, `productionOrder`, and `summaryResources` if it
belongs in the sidebar. `GamepediaModal.tsx`: update `factorSourceIcon()` if the new
resource appears as a factor source. `tick()` needs no change — it iterates
`producerResourceKeys`. Keep the "is it a production key?" assumption honest: capacity and
non-worker resources (like `science`) must never appear in `WorkerAssignments`.

---

## 9. Known gaps, placeholders and hazards

Read this list before "fixing" something that looks wrong — much of it is known debt
with a roadmap entry already assigned.

**Placeholders / not implemented**

- **No save/load at all.** The sidebar's "Autosaving just now" footer is cosmetic; the
  only persisted value is the number format. Any real persistence must be versioned and
  validated (roadmap Milestone 3: JSON primary, XML/Base64 interchanges, migrations,
  offline progress).
- **`Army` and `Research` tabs stay hidden until their gates fire** (the Army tab opens
  once the first battle is revealed/won; Research has no content yet). The Army tab is
  implemented (`components/ArmyPanel.tsx`): 79-unit buyable roster (current age +
  previous age), deterministic stack battles at 1 round/sec, enemy boosts, victory
  bonuses, and unit restoration after battle. The Gamepedia `unit` category holds all
  79 units (per-stat subtabs) and `combat` holds the 23 campaign battles; `research`
  still has no data.
- **Achievements are not persisted.** `earnedAchievements` lives in state like every
  other field, so it is lost on reload until the save system lands (roadmap Milestone 3).
- **Achievement checks run in `tick()`**, so an achievement whose requirement a UI action
  satisfies (a purchase, a victory) is recorded on the next tick, at most one second
  later — not synchronously with the action.
- **The era card is hardcoded** ("Neolithic Dawn", "Year 12", "68% to Bronze Age"). It
  does not match the seven-age model in the roadmap (Ancient → Modern/Space keyed on
  powers of ten). Treat it as a mock-up: do not build logic on those strings.
- **Existing but unused:** `public/icons.svg`. (`monument` has since been removed from
  `data/buildings.json`; market now produces `trade` 1/s.)
- **The bonus/upgrade system is only partially built** (§13). Implemented: the `Bonus`
  type, `attributeMultiplier`/`attributeFlat` application (production resources via
  `getFactors()` from every bonus source, capacities via `getBuildingMax()`, stats via
  the derived-attribute computations), `UpgradeDefinition` + the 64 enhancer tiers, the
  `seen` → Gamepedia reveal, the Upgrades tab, building unlock gates and
  `military`/`metalwork`, and the cost-reduction pipeline in `getBuildingCost()`
  (`costReductionPercent`/`costReductionBase`/`costReductionFactor` are used by the
  enhancer and Master Builder tiers).
  **Still unbuilt:** `attributeDrain` and `costReductionFlat` bonus data
  (the engine path exists), research/achievement/battle unlock sources (the smithy
  battle gate cannot fire yet).
- **Old units are never retired** — a unit stays owned, counted in army power and shown
  (in the roster window) forever. Unit retirement (and cost-tied spam control) is a
  planned follow-up; until then battles act only as soft checks against old-unit spam.
- **The `temp/` prototype files** (`battle.ts`, `campaign_v2.json`, `unit100-v3.json`,
  and their earlier variants) are exploration artifacts — not compiled, not linted, not
  imported from `src/`. They are superseded by the implemented slice: `src/game/battle.ts`,
  `src/game/units.ts` + `data/units.json` (79 units), and `data/encounters.json`
  (23 encounters, 7 age bosses — campaign v3 scope, with `age`/`year`/`isBoss`/
  `enemyArmy`/`enemyBoosts`).

**Engine debt and gotchas**

- **`available: boolean` is a hardcoded unlock flag.** The
  roadmap wants unlocks driven by age data instead. Do not add more hardcoded locks;
  when ages land, migrate `available` to age-driven data.
- **Building-specific conditionals already exist** in `civilizationState.ts`
  (`build()` adjusts `population`/`peopleCapacity`/`houseCapacity` for
  `people`/`house`/`town-hall`; `isBuildingAtCapacity()` and `getBuildFailureReason()`
  special-case `people`). They are known debt — express new behaviour as `effects` data.
- **The `CivilizationState` constructor mutates the `resources` object it is given**
  (it raises `peopleCapacity`/`houseCapacity` floors and recomputes `population` from the
  count of `"people"` in `builtBuildings`). Consequences: always pass a fresh object (the
  `with*` helpers do), never share a `resources` reference between states, and remember
  **population is derived from buildings**, not a freely settable resource. `workers` can
  exceed the recomputed population if construction is manipulated — verify both when
  touching construction.
- **`maxCount` on `BuildingDefinition` is not enforced**; capacities are. Adding a
  building means adding its capacity resource, or `getBuildingMax()` returns 0 and the
  building can never be built.
- **`getFactors()`/`computeResourceRate()` are only meaningful for production keys.**
  They coerce the key to `ProductionResourceKey` and read `workers[key]`; a non-production
  key only survives because `WorkerProduction`'s constructor defaults `undefined` to
  `ExpNumber.ZERO`. Do not rely on that in new code — guard the key.
- **`productionDefinitions` ⇄ `workers` ⇄ capacity keys must stay in sync** across
  `attributes.ts`. The types enforce this only partially (`ResourceKey` is a union, but
  several `Record`s are built by hand).
- **`expNumber` edge cases:** `floor`/`ceil` no-op above 1e308; `div` by zero gives
  ±`INFINITY`; `0/0` gives `NAN`; `NaN` comparisons are unordered. Overflow is a real
  hazard in cost/production formulas when exponents are combined.
- **`formatNumber` floors `|value| < 1` to `"0"`** and always shows two decimals —
  intentional, matching the historical behaviour. Do not "fix" it without checking the
  settings preview.
- **Gamepedia registration is an import side effect** that throws on duplicate IDs.
  Adding an entry whose id already exists (for example reusing a resource id for a
  building) throws at import time and blanks the app.
- **The tick is a 1-second `setInterval` in React**, not a fixed-step loop with delta
  time. Background tabs throttle it, so elapsed/offline progress is _not_ modelled yet;
  the roadmap's Milestone 3 now specifies the planned mechanic (an Offline Production
  Efficiency Factor `E_off` of 25–50% of active production, capped at 12 hours).
- **`styles.css` is one 1356-line global file** with no scoping — reuse class names
  carefully and remove dead rules when superseding them.
- **Dev Tools are player-visible** in the shipped UI (auto-clicker, dev production
  multiplier, auto-buy, auto-assign, `+1m/+1h/+1d` skips, free-buildings/free-units,
  win-next-battle, fork-run). If they should be gated for release, that is a product decision — flag
  it rather than silently hiding them. Notes on the dev-only paths: `advanceTime()` applies
  `rate × seconds` in one step (valid because no rate depends on a resource amount),
  `freeBuildings`/`freeUnits`/`freeUpgrades` skip affordability and deduction but keep capacity/unlock gates and
  keep the state-aware cost display intact, and the numeric fields
  (`components/DevNumberField.tsx`) commit on Enter/blur via `parseFlexibleNumber`
  (plain, scientific and `K/M/B`-style suffixed input). **`forkRun()`** (`App.tsx`)
  branches the run without touching it: it mints a fresh save `guid` and a fresh
  dev-log `runId`, so the fork gets its own save file name and its own
  `saves/auto/` log file while the parent's files stay exactly as they were —
  the "try another strategy from here" move. Every settlement field is carried
  over untouched. Two details it depends on: it only re-mints the log while dev
  mode is on (a log minted outside dev mode would put a dev section in a save
  that should not have one), and it resets `previousLoggedStateRef` to the
  current state so the next tick diffs from the fork point instead of logging the
  whole run as a burst of events. **Hazard, reproduced in headless
  Chrome:** never read `event.target.checked` from a control in the shell — `countUiClick`
  on `<main>` runs in the **capture** phase, so its `setGameState()` commit re-renders the
  tree and React writes the controlled `checked` value back onto the node _before_ the
  `change` handler runs. `change saw checked=false` therefore made every
  "turn this on" click read `false` (the original auto-buy checkbox bug). Dev toggles are
  now `aria-pressed` buttons whose handlers **invert React state**
  (`setFreeBuildings(!current.freeBuildings)`), never a DOM value.

---

## 10. Roadmap status snapshot

Full detail in `docs/roadmap.md`; this is orientation only.

| Milestone                                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Shared `GameObject` + `Gamepedia` registry           | **Done** (ids, descriptions, `seen`, registry, relations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1 — Data-driven definitions                              | **Partly done** — definitions are data modules under `src/game/`, but the roadmap's `src/game/data/` split and a full effect DSL are not in place, and `available` is still a boolean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2 — Ages / era progression (7 ages by powers of ten)     | **Not started** (the era card is a hardcoded mock)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3 — Save system (versioned JSON/XML/Base64 + migrations) | **Not started**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4 — Action multiplier (1 / 10 / MAX)                     | **Partly done** — the UI has 1, 10, powers of ten and Max; the engine has `getMaxAffordableBuildings()` and clamped worker commands, but no shared `getActionQuantity()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5 — Statistics                                           | **Not started**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6 — Achievements                                         | **First slice done** — `src/game/achievements.ts` + `data/achievements.json` (12 milestone records, five requirement types), `CivilizationState.checkAchievements()` evaluated at the end of `tick()`, `earnedAchievements` id list, Achievements tab, `achievement` Gamepedia category. Age-transition and click-power achievements still pending (they need ages and the `stat` family)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7 — Upgrades                                             | **First slice done** — bonus type, 64 enhancer upgrades (8 buildings × 8 tiers; primary tiers grant capacity + production, advanced tiers power + production only, plus cost reductions on tiers 3–8), Upgrades tab, unlock-gated buildings, cost-reduction engine path. Flat/drain/base bonus data and research/achievement/battle sources still pending; full model in **§13**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8 — Battle system                                        | **First slice done** — `src/game/battle.ts` (fully deterministic stack sim, no damage RNG — the seed is a battle fingerprint, battle id + army signatures, and does not change the outcome; ≤ 200 rounds; **per-unit battle orders** — `standard`/`frontline`/`backline`/`focus_weak`/`focus_strong`/`focus_counter`/`same_tag`/`protect_ranged`, unlocked with the classical ages, changing targeting and screening only, never damage/range/speed), `src/game/units.ts` + `data/units.json` (79 units, cost factor 5, per-age hp/attack scale), 23 encounters in `data/encounters.json` with enemy boosts and victory bonuses, `unitCounts` + buy/resolve paths on the engine, Army tab (`components/ArmyPanel.tsx`; per-unit order picker), unit icons vendored from game-icons.net (`public/units/`). Age-0 balance gates live in `src/game/battleAgeZero.test.ts` (8 warriors hold First Fire, a mixed army is the cheapest answer to the Wolf Pack, slingers reach naval, orders are deterministic and age-gated). Unit retirement, research-sourced unlocks and unit boosts via research are pending |
| 9 — Research tree                                        | **Not started**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 10 — Game-length simulation                              | **Not started**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Roadmap's recommended order: data modules → ages → command-style actions and result
events → statistics → saves → multipliers → upgrades/research → achievements → combat →
codecs → 10-billion campaign endpoint → interstellar loop → headless pacing simulation.

**Current priority: the first loop only** — everything through the 10-billion population
endpoint and the colony-ship launch. The interstellar/prestige loop is **deferred by
decision**, along with the prestige-bonus system and its relock semantics (§13.7).

---

## 11. Agent roles

Custom agents live in `.github/agents/`. They encode _who_ should do _what_; this file
encodes _how_ anything gets done here.

| Agent              | Scope                                                                                                                           | Tools                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Idle Civ Lead`    | Architecture, integration, review, conflict resolution, final `npm run build`; may delegate to the coder and balance agents     | read, search, edit, execute, todo, agent |
| `Idle Civ Coder`   | One narrow implementation task; smallest coherent edit; no opportunistic refactors                                              | read, search, edit, execute              |
| `Idle Civ Balance` | Balance, pacing, economics, historical research — **does not edit production code**; proposes values with rationale and sources | read, search, web                        |
| `Enter`            | Unconfigured template stub; ignore it                                                                                           | —                                        |

Working agreement for all of them: inspect the owning module and one usage before
editing; make the smallest coherent change; keep engine logic out of components; do not
invent game rules that were not requested (flag ambiguity instead); never touch user work;
validate with `npm run build` (plus `npm run lint`); report changed files, behaviour, and
validation output.

---

## 12. Definition of done

A change is done when:

1. It is the smallest coherent change that satisfies the request, in the right layer.
2. `npm run build` passes and `npm run lint` reports 0 warnings / 0 errors.
3. No unrelated files changed; no scratch artifacts or new untracked clutter left behind.
4. New content is data-driven with stable IDs, uses `ExpNumber` for anything that can
   grow, and needs no per-content branching in the engine.
5. Numbers reach the player only through `formatNumber`.
6. **A simulation change to `tools/simulation/strategies.ts`, the main engine, or `age0` is
   benchmarked before and after against the recorded baseline, and no strategy
   regresses** unless the regression is intentional and stated in the summary — see
   §7.2, which scopes the sweep to those paths (`age1` and beyond are exempt while
   they are still being balanced). A green test suite is not sufficient evidence
   for a tuning change.
7. The summary states what changed, which files, the validation output, and any remaining
   risk or follow-up (with a roadmap milestone reference when relevant).
8. Any ambiguity or product decision you had to assume is called out explicitly rather
   than silently baked in.

---

## 13. Bonuses, buyables and upgrades

> **Status: partially implemented.** In the code: the `Bonus` union and factories
> (`src/game/bonus.ts`), `attributeMultiplier` application (production resources in
> `getFactors()`, capacities in `getBuildingMax()`), the cost-reduction pipeline in
> `getBuildingCost()` (`costReductionPercent`/`costReductionFactor` are used by the
> enhancer tiers), the `UpgradeDefinition` registry with the 32 production-enhancer
> tiers (`src/game/upgrades.ts`), the Upgrades tab, and the building unlock gates.
> Still design-only: some `attributeDrain`/`costReductionFlat` data, research/units, and
> all prestige semantics (`attributeFlat` ships via the hoarder chains,
> `costReductionBase` via the Master Builder chain). Check the
> engine before assuming a symbol exists, and §13.7 for what is decided versus
> deferred. Achievements now have their own slice (§10, milestone 6) and are permanent
> records only — they never carry unlock lists.

> **Scope: the first loop comes first.** The immediate target is one playthrough — Ancient
> through the 10-billion population goal and the colony-ship launch. **Prestige is deferred
> by decision** (§13.7), but three of its constraints already shape the data: unlock lists
> must be **relockable** (hence they hang off the age), `seen` must be **permanent**, and
> achievements must be **permanent records** rather than carriers of unlocks.

### 13.1 Bonuses — the single unit of change

A **bonus** is the one data-driven primitive that should eventually express _every_
effect in the game: building effects, upgrade effects, research effects, battle rewards
and achievement rewards. Instead of adding a new bespoke effect field per feature, add a
bonus type (or a new destination), so the engine keeps a single application path.

```ts
type BonusType =
  // attribute-targeted: the destination is a resource, capacity or stat
  | "attributeFlat" // +N to the destination attribute
  | "attributeMultiplier" // ×N on the destination attribute
  | "attributeDrain" // −N per second of the destination attribute
  // buyable-targeted: the destination is a buyable (building or unit)
  | "costReductionFlat" // destination cost −N (absolute)
  | "costReductionPercent" // destination cost × (1 − N)
  | "costReductionBase" // base term ×N — <1 reduces, >1 augments
  | "costReductionFactor"; // destination cost's growth factor raised to the power N

type BonusDestination = AttributeKey | BuyableId | CostTargetPath;

type Bonus = {
  type: BonusType;
  destination: BonusDestination;
  value: ExpNumber;
};
```

Building effects may carry explicit tags in JSON. The `nopower` tag is currently
supported only on `capacityProvided` effects; it keeps that capacity grant
independent of the source building's power. Do not add tags to bonus entries.

| Bonus type             | Destination                            | Meaning                                                                                                                     | Nearest existing equivalent              |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `attributeFlat`        | attribute (resource, capacity or stat) | adds a flat amount to the attribute's accrual                                                                               | `ResourceFactors.additional`             |
| `attributeMultiplier`  | attribute (resource, capacity or stat) | multiplies the attribute's gain                                                                                             | `ResourceFactors.multiplicative`         |
| `attributeDrain`       | attribute (resource, capacity or stat) | subtracts a flat per-second amount (consumption)                                                                            | `ResourceFactors.drain`                  |
| `costReductionFlat`    | buyable                                | lowers every cost entry of the buyable by an absolute amount                                                                | **none** (new)                           |
| `costReductionPercent` | buyable                                | lowers every cost entry by a percentage                                                                                     | **none** (new)                           |
| `costReductionBase`    | buyable                                | multiplies the base term: Π(N) compounding, `< 1` discounts and `> 1` augments (absorbs the old `costMultiplier`)           | `buildingCostOverrides` precursor        |
| `costReductionFactor`  | buyable                                | raises the growth factor to the power `N`, scaling the log-growth exponent by exactly N on every building (floored at 1.01) | crude precursor: `buildingCostOverrides` |

The first three map exactly onto today's factor model, so they can reuse
`ResourceFactors` and `computeResourceRate()` (`(Σ flat) × (Π mult) − (Σ drain)`) and the
existing `addFactor()` seam. Four cost-reduction types operate on buyables. `attributeFlat`
also adds to a selected raw cost field before the four per-unit reductions, so additive
bonuses use one type across production, capacity, unit stats and cost parameters.

Cost targets are dot-separated, case-insensitive paths normalized to stable IDs:
`Market.costs.all` selects all market cost rows, `Farm.costs.wood` selects only the
farm's wood row, `allunits.costs.wood.factor` selects the wood growth factor on every
unit, and `all.costs.all.exponent` selects every buyable cost exponent. A field suffix (`base`, `factor` or `exponent`) is required when `attributeFlat` targets a
cost path. `Civilbuildings` selects `house` and `townHall`;
`Market.power` selects `marketPower`; `Wood.worker` and
`Wood.worker.efficiency` select `woodProductionPerWorker`; `productionBuilding.power`
selects the shared `buildingPower` multiplier.

Keep the path namespaces distinct: `.power` selects a building-power attribute.
`factor` and `exponent` are cost fields only when scoped beneath
`.costs.<resource>` (for example, `Market.costs.wood.factor`); bare
`Market.factor` and `Market.exponent` are invalid targets.
`.capacity` selects a building capacity attribute, and production-worker efficiency
groups use paths such as `allProduction.worker.efficiency` and
`advancedProduction.worker.efficiency`.
Cost paths may also scope unit discounts, for example
`tag.cavalry.costs.all` and `domain.ground.costs.all.factor`.

`attributeFlat` on a cost-field path is applied to the selected raw field before the
four cost reductions. A cost row whose growth `factor` is zero is disabled (its cost is zero)
until a positive factor addition activates the row; after activation, the factor retains
its normal role as the curve's growth factor. This supports an authored future cost such
as `house.costs.stone` with base 100 and factor 0, later activated by an age bonus adding
12 to `house.costs.stone.factor`.

**Stacking (decided).** Attribute bonuses stack exactly as `computeResourceRate()` already
does — **option A** (§13.7): every `attributeMultiplier` source multiplies with the others,
while every `attributeFlat` and every `attributeDrain` source **sums with equal weight**.
Building per-count bonuses are the exception: their `additiveMultiplier` contributions
**sum as percentages** (`1 + Σ count × perBuilding × power`) and never compound.
There is **no `group`/`tier` concept** and no per-source precedence: sources of an additive
type are all treated equally. Type order is **fixed** (`flat → mult → drain`), not
declaration order. If growth ever runs away, an optional `group` field is the escape
hatch — do not add it pre-emptively.

**Cost-reduction stacking (decided, §13.6).** Per buyable, the four types are collected
from all bought sources and applied per unit in the fixed order
`base → factor → percent → flat`: `base` reductions **sum** (floor 0), `factor`
values are **powers** that **multiply** as `Π(N)` (each N is a power, e.g. 0.99
means "costs grow at 99% of the default rate"; values below 0 clamp to 0 and the
resulting growth factor is floored at 1.01),
`percent` reductions **compound** as `Π(1 − N)` with each source clamped at a
0 floor, and `flat` reductions **sum** and absorb each unit's cost after the percent
step, clamped at 0 per unit. The enhancer upgrades use this: tiers 3–5 each add
`costReductionPercent` 0.5 (compounding to ÷8) and tiers 6–8 each add
`costReductionFactor` 0.99 on their building (cost growth ^0.99 per tier).

Because a bonus names its destination, and building/unit ids are Gamepedia ids, a bonus
list is also a **relation graph**: it feeds `GamepediaEntry.relatedIds` the same way
building costs and effects do today (§4.6/§4.7). Design them so the Gamepedia can render
"what modifies this resource / this building" straight from the data.

**Application order and clamping (decided).** Cost reductions apply **per unit**, in this
fixed order — `base → factor → percent → flat`:

1. `costReductionBase` — multiply the cost's `base` term by `Π(N)`. The value is the multiplier itself (floor 0): `< 1` discounts the base, `> 1` makes it dearer. This type absorbed the former `costMultiplier`, which expressed the same ×N as a separate type. Use `costReductionPercent` when a percentage is what you want to express.
2. `costReductionFactor` — raise the growth `factor` to the power `N` itself (values below 0 clamp to 0; the result is floored at 1.01). Formula: `max(1.01, baseFactor^Π(N))`, where N compounds across sources (e.g. 0.99 = costs grow at 99% of the default rate). The power scales the **log-growth exponent** by exactly N for every growth factor — `ln(F_eff)/ln(F) = N` exactly (0.900000 on F = 2.5, 8, 10, 12, 15 alike), whereas the earlier `1.01 + (F − 1.01)·N` form drifted 0.933 → 0.964 over the same range. So one number means "grow at N× the rate" wherever it lands, which is what makes it reusable from a single building to `allBuildings`. (This is a property of the exponent, not of the cost ratio: cost still scales with F at high n, since F is the per-building design knob.)
3. `costReductionPercent` — scale the resulting unit cost by `(1 − N)`.
4. `costReductionFlat` — subtract `N` from the unit cost last.

All costs **and** drains clamp at **0** — a cost may become free, a drain may never go
negative.

Per-unit was chosen over applying reductions to the bulk total because:

- Bulk-total reductions are exploitable: buying 1 at a time would collect the discount
  repeatedly while a single purchase of 100 collects it once, and "10% cheaper" would
  mean a different thing at every multiplier.
- Per unit preserves a **single** O(1) evaluator shared by buy-N and buy-MAX, which is what
  `getMaxAffordableBuildings()`'s doubling probe depends on — see §13.6.

### 13.2 Resources — the taxonomy and where each family is displayed

| Resource family                        | Members                                                                                 | Displayed in                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| population / worker (**special case**) | `population` — both the population count and the worker pool                            | sidebar summary (as `availableWorkers/population` + capacity) |
| production                             | `wood`, `food`, `gold`, `stone`                                                         | sidebar summary                                               |
| building                               | `science` (university), `military` (barracks), `metalwork` (smithy)                     | sidebar summary                                               |
| capacities                             | population max (`peopleCapacity`) and per-building max (`` `${buildingKey}Capacity` ``) | **buildings UI**, not the summary                             |
| derived                                | click power (`clickPower`), automated click power (`autoClickRate`)                     | **stats tab** and the Gamepedia                               |

Reconciliation with the code as it stands:

- Production resources are `wood`, `food`, `gold`, `stone`; the building resources
  `science`/`military`/`metalwork` all exist now (university/barracks/smithy each
  produce 1/sec via `resourceProduction`). Adding a production-style resource is recipe
  §8.2.
- Capacities are already modelled as resources (`CapacityResourceKey`), and they **keep
  their own effect/bonus representation** rather than being collapsed into a generic
  `attributeFlat`: capacity is a flat grant today but is expected to gain a **multiplier**
  variant later in the game, so the capacity door must stay open. Keep
  `capacityProvided`-style capacity grants distinct for that reason.
- "others" (click power, automated click power) get their **own Gamepedia category**
  (`stat`) and there will be an in-game **stats tab**. Two decided consequences:
  1. **Clicking a computed stat in the stats tab opens the Gamepedia on that stat's page.**
     The modal already supports this through its `focusId` prop, so wire it through the
     existing `gamepediaFocusId` state — do not add a second navigation mechanism.
  2. The **`stat` category joins the other Gamepedia categories** — production, building,
     unit, research, battle, upgrades, stat, etc. The `unit` and `stat` categories are
     now implemented (79 unit entries with per-stat subtabs; `clickPower`,
     `autoClickRate` and `armyPower` stats); `combat` holds the 23 campaign battles;
     a production-vs-building resource split remains reconciliation work.
- Implementation shape (implemented): the **attribute registry** in
  `src/game/attributes.ts` — `AttributeDefinition` with
  `family: "amount" | "capacity" | "derived"` — registered in the Gamepedia, with the
  destination covering `AttributeKey` (stored `ResourceKey`s plus derived stats) beside
  buyable ids. Then the classic click upgrades are ordinary bonuses: `+1 per click` =
  `attributeFlat` on `clickPower`, `×2 click power` = `attributeMultiplier` on
  `clickPower`, `+0.5 auto-clicks/sec` = `attributeFlat` on `autoClickRate`. Stat values
  stay **derived**, never stored.
  Caveat settled by the same decision: `clickPower` is **one global stat** scaling every
  manual click (today's per-resource `productionPerWorker` stays as resource data), and the
  auto-clicker becomes the `autoClickRate` stat rather than a bare state field.

### 13.3 Buyables

A **buyable** is anything with a `BuildingCost` list, i.e. anything the player spends
resources to acquire:

- **buildings** — the 12 existing definitions (§4.4)
- **units** — implemented (Milestone 8): the 79-unit roster in `data/units.json`, bought
  through the same evaluator (`buyUnit`/`getUnitCost`/`getMaxAffordableCount`), with no
  capacity cap (§13.3 decisions). Unit costs default to growth factor **5**; the Age-0
  Tribesman uses **4**, while the Bronze Spearman and Axeman use **3**. Those bands
  are regenerated by `tools/gen/units.mjs`, which also carries their adjusted bases.

Because both share the `BuildingCost` shape, the four cost-reduction bonus types apply
to both uniformly. Decisions for units:

- Units **do** use the buyable cost model, so they inherit cost reductions.
- Units have **no max capacity**: **nothing caps them** — as long as you can pay the cost
  you can buy them, so affordability is the only limit. (Consequence: the cost type's name
  `BuildingCost` will need generalising to something like `Cost`/`BuyableCost` once units
  land. Encountered units should not need population or slot limits either.)

### 13.4 Upgrades

An **upgrade** is a one-shot purchase that permanently applies bonuses. It is itself a
buyable (it has a `BuildingCost` list) with a purchase limit of **one**, so the buyable
cost model and the cost-reduction bonuses apply to upgrades too.

Three state flags drive the whole lifecycle:

| Flag       | Meaning                                        | Effect                                                                               |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `seen`     | the upgrade has been shown at least once       | it becomes a Gamepedia entry                                                         |
| `unlocked` | its unlock condition is satisfied              | it appears in the **Upgrades tab**                                                   |
| `bought`   | its cost has been paid and its bonuses applied | bonuses apply and it disappears from the tab (it stays in the Gamepedia as a record) |

```ts
type UpgradeDefinition = {
  id: string; // stable, kebab-case, Gamepedia id
  name: string;
  description: string;
  costs: BuildingCost[]; // limit of one purchase
  bonuses: Bonus[]; // §13.1 — may target resources or buyables
};

// Unlocks are declared on the SOURCE, which lists the ids it unlocks:
type AgeDefinition = { /* ... */ unlocks: string[] }; // upgrade + research ids
type ResearchDefinition = { /* ... */ unlocks: string[] }; // applied on completion (purchase)
type EncounterDefinition = { /* ... */ unlocks: string[] }; // applied on victory
```

Unlocks are declared **by the source**, and each source lists the ids it unlocks:

- **age** — arriving at an age unlocks its list of upgrades (and research)
- **research** — completing a research unlocks its list (completed = purchased)
- **battle** — defeating an encounter unlocks its list
- **building count** — the **building definition owns its own explicit `unlocks` list**
  plus the count threshold that gates it. Decided rule for all four sources: unlocks are
  **specific id lists**, never a generic condition/rule engine — a flexible rule system
  cannot be listed cleanly in the UI ("what unlocks this?" has to stay answerable).

**Achievements do not carry unlock lists.** Achievements never reset, but upgrades must be
**re-locked and re-unlocked on every prestige loop** (a designed-for future layer). A
relockable effect therefore cannot hang off a permanent record — it has to hang off the
**age**, which each loop re-enters. The **first** arrival at an age still fires an
achievement, but that achievement is a permanent _historical record_ ("this civilization
first reached the Iron Age"); the age itself owns the unlock.

Consequences for the three flags, under repeated prestige loops:

- Relocking touches **`unlocked`** only. `seen` is permanent (§13.7 decision 9), so a
  re-locked upgrade stays in the Gamepedia and simply disappears from the Upgrades tab
  until its age is re-entered.
- `bought` resets each loop — confirmed (§13.7 decision 4). Otherwise a re-locked upgrade
  would keep its bonuses.

That makes upgrades the join point between the economy, the research tree, encounters and
ages — so the upgrade model should be built _after_ those systems have their ids, or it
will need rework.

Two pieces of state-management guidance:

- `seen` overlaps `GameObject.seen` (§4.2), which already exists — reuse it rather than
  adding a second flag. Note that today `seen` is mutated on the **shared definition
  object** and is therefore lost on reload; `seen`/`unlocked`/`bought` must eventually be
  persisted **per upgrade id in the save** (roadmap Milestone 3), not on definitions.
- **`seen` is never reset** — not by prestige and not by a new colony loop. Once something
  has been shown to the player it stays shown, permanently, for the life of the save.
- Bonuses from bought upgrades should be **derived** from the set of bought ids when
  factors and costs are computed — do not accumulate applied values into saved state, or
  migrations and re-balancing become unsafe.
- **Open-ended milestone chains are parametric** (§13.4): the hoarder chains run past
  their authored data forever — tiers materialize on demand from the
  `openEndedHoarderChains` specs with deterministic `<family>-e<exponent>` ids, earn in
  `checkAchievements()`, resolve bonuses through `findAchievementDefinition()`, and
  register in the Gamepedia lazily via `ensureAchievementEntry()`. Tier bonuses aggregate
  into one summed `<family>-total` source in `activeBonuses()` (additive flats, identical
  math) and the pedia registers one aggregate record per family, not one per tier. Never
  author them as
  finite JSON; never reset `seen` for them.

> Resolved: **a buyable's bonus never unlocks an upgrade.** There is no `grantUpgrade`
> bonus type — bonuses only _modify_ resources /
> capacities or _reduce the cost_ of buyables. Unlocks come exclusively from the unlock
> sources described above. An upgrade's bonuses may still **target** buyables, which is
> what lets an upgrade reduce building or unit costs.

### 13.5 File layout directive: one file per type

Definitions go in **one file per type**, never one monolithic definitions module.
Expected shape once the `src/game/data/` split from roadmap Milestone 1 lands:

```text
src/game/data/
  attributes.ts     attribute definitions grouped by family:
                    resources, capacities, stats (§13.2)
  bonuses.ts        the Bonus union + factories/validators for the 7 bonus types
  buildings.ts      the buyable building definitions
  units.ts          the buyable unit definitions
  upgrades.ts       the upgrade definitions (§13.4)
  research.ts       the research tree
  achievements.ts   achievements, including age transitions
  ages.ts           the seven ages and their total-building completion thresholds
  encounters.ts     combat encounters and their rewards
```

Each file owns exactly one definition type and its registry data; shared _shapes_ (the
cost model, the bonus union) stay in the type module they belong to and are imported by
the others.

> Interpretation note: I read "one file per type" as one file per **definition/content
> type** (as above, mirroring the roadmap). If you meant one file per **bonus type**
> (seven small files) or one file per **resource family**, say so and I will rewrite this
> directive.

### 13.6 How this should land in today's code

Part of this is implemented now (bonus type, resource multipliers, enhancer upgrades,
unlock gates). The remaining seams to reuse instead of adding parallel machinery:

- `BuildingEffects` (`capacityProvided` / `additiveMultiplier` / `resourceDrain`) is the
  direct precursor of a `bonuses: Bonus[]` list. The bonus types are now named
  `attributeMultiplier` / `attributeDrain` / `attributeFlat` (the destination may be any
  attribute); `capacityProvided` **survives as its own capacity representation** rather
  than becoming an `attributeFlat`, because capacity may need a multiplier later
  (§13.2, §13.7 decision 3).
- Attribute bonuses land in the existing path: `resourceFactors` + `addFactor()` +
  `getFactors()` + `computeResourceRate()`. No new formula is needed for `attributeFlat` /
  `attributeMultiplier` / `attributeDrain`.
- Cost bonuses land in `getBuildingCost()` — **implemented**: reductions are collected
  per buyable from the bought upgrades (`collectCostReductions` in `bonus.ts`), `base`/
  `factor` rewrite the series inputs, `percent` scales every unit, and `flat` absorbs
  whole units via a short clamped-prefix loop (bounded by `count`; the closed form
  covers the remainder). The Gamepedia price panel and the purchase path both read
  `getBuildingCost()`, so they can never disagree; the definition-level
  `costAt()`/`formatCost()` remain stateless raw previews with no callers.
- **Keeping buy-N and buy-MAX O(1)** under the decided per-unit order (§13.1): the `base`
  and `factor` reductions rewrite the series inputs, so `first × (factor^count − 1) /
(factor − 1)` keeps its shape; the percent reduction scales `first` uniformly; and the
  flat reduction is `− count × N`. The only wrinkle is the per-unit clamp at 0
  (`Σ max(0, unitᵢ − N)`): skip the leading units that clamp to zero — there are at most
  `log_factor(base′ / N) + 1` of them, so a handful, findable with a log (validate the
  off-by-one numerically) or a short bounded loop — then apply the closed form to the
  remaining `count − k` units. Because every unit cost is ≥ 0 the total stays monotonic in
  `count`, so the doubling probe and binary search stay valid. Implemented choice: the
  clamp prefix uses a short bounded loop (either approach was allowed), and stateless
  `costAt()`/`formatCost()` stay raw definition previews — every player-facing price
  (building cards, Gamepedia, purchase) reads the state-aware `getBuildingCost()`.
- `buildingCostOverrides` + `upgradeBuildingCosts()` are the crude precursor for
  `costReductionBase` / `costReductionFactor`; expect them to be absorbed into, or
  replaced by, the bonus path.
- The Upgrades tab lists unlocked unbought upgrades and the Gamepedia `upgrade`
  category fills as unlocks fire (App reveals on every state change). `combat` holds
  the 24 campaign battles; `research` holds the 172 technology definitions.
- Sequencing: the roadmap's recommended order puts saves and statistics _before_
  upgrades. Do not start without agreeing the target milestone, because
  `seen`/`unlocked`/`bought` are meaningless until a save exists.

### 13.7 Decisions, and what is deferred

**Resolved** (decisions, not open points — implement them as specified):

| #   | Question                                               | Decision                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Order of application for the four cost-reduction types | `base → factor → percent → flat` (§13.1)                                                                                                                                                                                                                                                             |
| 1   | Clamp floor for costs                                  | **0** — a cost may become free                                                                                                                                                                                                                                                                       |
| 5   | Clamp floor for drains                                 | **0** — a drain may never go negative                                                                                                                                                                                                                                                                |
| 2   | Per-unit vs bulk-total cost reductions                 | **Per unit**, keeping buy-N and buy-MAX on one O(1) evaluator (§13.1, §13.6)                                                                                                                                                                                                                         |
| 3   | Is `capacityProvided` replaced by `attributeFlat`?     | **No — capacity keeps its own representation.** Flat today, but may gain a **multiplier** later, so the capacity door stays open                                                                                                                                                                     |
| 6   | Where are click power / automated click power shown?   | **Stats screen** (live) **and** somewhere in the Gamepedia                                                                                                                                                                                                                                           |
| 7   | Do units use the buyable cost model?                   | **Yes** — they receive cost-reduction bonuses                                                                                                                                                                                                                                                        |
| 7   | What caps units?                                       | **Nothing.** Affordability is the only limit; no capacity, population or slot cap                                                                                                                                                                                                                    |
| 8   | Can a buyable's bonus unlock an upgrade?               | **No.** There is no `grantUpgrade` type; bonuses only modify resources/capacities or reduce buyable costs. Unlocks come only from unlock sources                                                                                                                                                     |
| 8   | Unlock carriers                                        | **The source carries the list**: an **age** on arrival, a **research** on completion (purchase), an **encounter** on victory. **Achievements do not carry unlock lists** (they never reset, so they cannot drive relocking) — this supersedes an earlier draft that put the lists on the achievement |
| 8   | Why not let achievements carry the unlocks?            | Because prestige returns to the early ages, so unlocks must **relock and re-unlock each loop**; a permanent record cannot express that. The first arrival at an age still fires an achievement, but only as a permanent historical record                                                            |
| 9   | Is `seen` ever reset?                                  | **Never** — not on prestige, not on a new colony loop. Relocking affects `unlocked` only, so a relocked upgrade stays in the Gamepedia                                                                                                                                                               |
| 2   | Where click power / automated click power live         | **Derived attributes** in the attribute registry, own `stat` Gamepedia category, plus an in-game **stats tab** whose values open the Gamepedia page via `focusId` (§13.2)                                                                                                                            |
| 3   | Who owns building-count unlocks                        | **The building definition**, with an explicit `unlocks` list + count threshold. All unlocks are **explicit id lists**, never a generic condition/rule engine                                                                                                                                         |
| 4   | Prestige: what resets                                  | **`bought` resets every loop.** Permanent: **achievements**, **prestige bonuses** (to be defined) and `seen`                                                                                                                                                                                         |
| 5   | Implementation priority                                | **The first loop first** — prestige design is deferred (see below)                                                                                                                                                                                                                                   |

**Decided, with the rationale kept** (so it does not get silently re-litigated):

**Decision 1 — bonus stacking: option A approved.** Worked example: food has **3 farms**,
each contributing `attributeMultiplier` ×1.1 to food, plus an upgrade "Irrigation"
contributing `attributeMultiplier` ×1.25 to food.

- **A — chosen:** multiply the multipliers: `1.1 × 1.1 × 1.1 × 1.25 = 1.66375`, while every
  `attributeFlat` and every `attributeDrain` source **sums with equal weight**. The three
  types combine in the fixed order of `computeResourceRate()`:
  `(Σ flat) × (Π mult) − (Σ drain)`.
- **B — rejected:** sum within a type: `1 + (0.10 + 0.10 + 0.10 + 0.25) = 1.55`.
- **C — rejected for now:** tiers (same-type sources additive inside a named group, groups
  multiplying). It needs a `group`/`tier` field on every bonus; keep it only as the escape
  hatch if the numbers later run away.

So: no tiers, no per-source precedence, no declaration-order dependence.

**Decision 2 — click power / automated click power: the `stat` proposal was accepted.**
They are **derived attributes** (`family: "derived"`) in the attribute registry with
their own `stat` Gamepedia category, and an in-game **stats tab** whose computed values
open the Gamepedia on the matching page through the existing `focusId` prop.
`clickPower` is **one global stat** scaling every manual click; the auto-clicker becomes
the `autoClickRate` stat. Full detail in §13.2.

**Decision 3 — building-count unlocks: the building owns an explicit list.** Every unlock
source declares a specific list of ids; there is no generic condition/rule engine, because
a flexible rule system cannot be enumerated cleanly in the UI.

**Decision 4 — prestige: `bought` resets each loop.** Permanent across prestige:
**achievements**, **prestige bonuses** (definition still to come) and `seen`. Everything
else about the loop is intentionally unspecified for now.

**Deferred — do not design or implement now:**

- **Prestige mechanics and the prestige-bonus system.** The stated priority is to **finish
  the first loop first**. The only prestige constraints that bind today are: unlock lists
  must be **relockable** (so they hang off the age), and `seen` + achievements must be
  **permanent**.
- **What else resets at prestige** (resources, buildings, workers, statistics) — unstated by
  design; it belongs to the prestige design, which is not being written yet.
- **`docs/roadmap.md` reconciliation.** The roadmap's `AgeDefinition` already carries
  `unlocks` / `upgrades`, which now **matches** the decided model — the earlier
  contradiction is gone. Still to add when prestige is picked up: relock-on-prestige
  semantics and achievements-as-permanent-records. Note the roadmap currently describes
  prestige only as the "interstellar expansion" loop.
