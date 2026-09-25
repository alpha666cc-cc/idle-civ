# Idle Civ Roadmap

## Direction

Keep the simulation engine independent from React. Game definitions should be data-driven so balance changes do not require editing simulation code.

## Milestone 0: Shared game objects and Gamepedia

Every definition should inherit from a shared `GameObject` containing:

- A stable unique ID for saves, references, analytics, and authentication.
- A human-readable description.
- A future extension point for tags, icon IDs, and localization keys.

Create a central `Gamepedia` registry that indexes resources, capacities, buildings, upgrades, research, and combat definitions. Details screens should resolve references through Gamepedia so users can click from a resource to its production sources, buildings, upgrades, and research effects.

```text
src/game/
  gameObject.ts
  gamepedia.ts
  data/
    attributes.ts
    production.ts
    buildings.ts
    upgrades.ts
    research.ts
    combat.ts
    ages.ts
```

Use stable IDs rather than display names. Gamepedia relationships should be data-driven and should support lookup, search, related entries, and missing-reference validation.

## Milestone 1: Data-driven definitions

Move balance and content definitions into `src/game/data/`, with one module per content type:

```text
src/game/data/
  attributes.ts
  production.ts
  buildings.ts
  upgrades.ts
  research.ts
  combat.ts
  ages.ts
  achievements.ts
```

Each definition should contain data and effects, for example:

```ts
type BuildingDefinition = {
  id: string;
  name: string;
  costs: BuildingCost[];
  maxCount: number;
  effects: BuildingEffect[];
};
```

The engine should consume these definitions through typed registries. It should not contain building-specific conditionals such as `if (buildingKey === "farm")`.

Balance workflow:

1. Change values in the data files.
2. Run balance checks or simulation tests (see Milestone 10 for the automated game-length run).
3. Review the resulting progression and production rates.
4. Run the application build.

## Milestone 2: Ages and era progression

Define seven ages that frame the campaign from the first family to the interstellar launch. An age is entered when population crosses the next power of ten, from 10^0 (1) to 10^10 (10 billion). The opening age is deliberately compressed to a thousand population so the early game moves fast; each later age stays at roughly one order of magnitude:

- **Ancient:** 1 – 1,000 population — fast opening age, merging the Prehistoric, Stone Age, and Bronze Age starts
- **Iron Age:** 1,000 – 10,000
- **Classical:** 10,000 – 1,000,000
- **Middle Ages:** 1,000,000 – 10,000,000
- **Renaissance:** 10,000,000 – 100,000,000
- **Industrial:** 100,000,000 – 1,000,000,000
- **Modern / Space:** 1,000,000,000 – 10,000,000,000

With seven ages, crossing from one million to ten million population is the Middle Ages — the exact midpoint age — and the colony ship launches near the end of the final age.

Design:

- Define each age as data with a stable ID, name, and population threshold. The research tree `era` field and any age-gated content reference these IDs:

```ts
type AgeDefinition = {
  id: string;
  name: string;
  populationThreshold: number;
  unlocks?: string[]; // buildings or combat units unlocked by this age
  upgrades?: string[]; // upgrades or research made available
  encounters?: string[]; // two regular battles + an age-end boss (see Milestone 8)
};
```

- Compute the current age as the highest threshold reached; do not persist an age counter in the save. Keep ages data-driven so the engine has no era-specific conditionals.
- Make building availability age-driven data instead of the current hard-coded `available` boolean; `canBuild` then reflects the current age.
- Emit age-transition events so statistics and achievements can record them and the game-length simulation (see Milestone 10) can report time-to-age.
- Expect **23 battles across the campaign** — two regular fights plus an age-end boss per age (five battles in Modern/Space); see Milestone 8 and the campaign prototype. The first is a wolf in the opening Ancient age whose defeat expands the town-hall count beyond its default cap of 10; each age-end boss unlocks the next age.
- Format large populations readably (1.2M, 3.4B) as values pass a million; 10 billion stays well inside `Number.MAX_SAFE_INTEGER`.

## Milestone 3: Save system

Create a versioned save model independent of the UI:

```ts
type SaveGame = {
  version: number;
  savedAt: string;
  state: CivilizationSaveState;
};
```

Support three interchange formats:

- JSON: primary/debug format, readable and easiest to migrate.
- XML: compatibility/export format for experimentation and external tooling.
- Base64: compact transport format, preferably Base64-encoded JSON rather than an undocumented binary format.

Recommended API:

```ts
interface SaveCodec {
  encode(save: SaveGame): string;
  decode(value: string): SaveGame;
}
```

The save system should include migrations by version, validation, corruption handling, and offline-progress timestamps. Do not trust imported saves without validation.

### Offline generation rate (E_off) — crucial idle mechanic

Offline progress must not let players skip whole ages by leaving the game overnight. All
offline gains use an **Offline Production Efficiency Factor** (`E_off`), a fraction of the
active production speed:

- **Base offline efficiency:** `E_off = 25%–50%` of the active production rate. The
  opening value — and any later progression within that band (upgrades, prestige bonuses)
  — is a Balance-agent decision.
- **Offline max cap:** credit offline progress for at most **12 hours** of elapsed time,
  matching the expected overnight pause and preventing multi-day bank-and-skip strategies.

Mechanics when a save is loaded:

1. Compute `elapsed = now − savedAt` (the save model already carries `savedAt`) and clamp
   it to the 12-hour cap.
2. Credit each resource with `elapsed × computeResourceRate(resource) × E_off`, using the
   same rate formula as the live tick, so citizens keep draining food while the player is
   away. An open Balance question: whether drains should apply at full strength offline or
   be scaled by `E_off` alongside production.
3. Age transitions triggered by offline population growth must emit the same events live
   transitions do, so statistics and time-to-age reporting stay honest (see Milestones 2,
   5, and 10).

## Milestone 4: Action multiplier

Add a shared action quantity mode:

- `1`
- `10`
- `MAX`

Use it for gathering, assigning workers, buying repeated buildings, and similar actions. The engine should expose a calculation such as:

```ts
getActionQuantity(action: Action, mode: ActionQuantityMode): number;
```

The UI should use a segmented control. `MAX` must calculate the affordable and capacity-limited quantity without partially applying an invalid action.

## Milestone 5: Statistics

Track lifetime and session statistics separately from current resources:

- Resources gathered by type
- Resources spent by type
- Buildings constructed by type
- Workers assigned and unassigned
- Total play time
- Manual clicks and auto-clicks
- Research and upgrades completed
- Offline progress gained

Statistics should be event-driven or updated through engine commands, not inferred from rendered UI.

## Milestone 6: Achievements

Define achievements as data:

```ts
type AchievementDefinition = {
  id: string;
  title: string;
  description: string;
  requirement: AchievementRequirement;
  reward?: AchievementReward;
};
```

Track unlocked IDs in the save state. Achievement checks should run after domain events and remain deterministic. Avoid embedding achievement rules in React components.

## Milestone 7: Upgrades

Define upgrades as data that modify resources, buildings, production, costs, capacities, or combat:

```ts
type UpgradeDefinition = {
  id: string;
  name: string;
  costs: BuildingCost[];
  prerequisites: string[];
  effects: EffectDefinition[];
};
```

Upgrades should be stored by stable ID and applied through the same factor system used by buildings. Avoid upgrade-specific conditionals in the engine.

## Milestone 8: Battle system

Add a deterministic combat model for units and encounters. Initial unit stats:

- Hit points
- Attack
- Range
- Armor
- Movement or position, if ranged combat needs distance

Keep combat separate from the economic tick. A battle simulation should accept unit snapshots and return events/results:

```ts
type UnitDefinition = {
  id: string;
  hp: number;
  attack: number;
  range: number;
  armor: number;
};
```

Encounter pacing is settled by the campaign prototype (`temp/campaign_v2.json`, trimmed
into `src/game/data/encounters.json`): **23 encounters — two regular battles plus one
age-end boss for each of the six earlier ages, and five battles (4 + final boss) in
Modern/Space**. The first encounter is a wolf (`age0_1_first_fire`) in the opening
Ancient age; defeating it expands the town-hall count beyond the default cap of 10. Each
victory applies a data-driven reward (bonuses, unlocks, enemy boosts on the same bonus
channel as upgrades). **Implemented (first battle slice):** unit definitions
(`src/game/units.ts` + `data/units.json`, hp/attack scaled ×8 per age; unit cost factor
  5 except the Age-0 Tribesman ×4 and Bronze Spearman/Axeman ×3),
a deterministic seeded stack/hp-pool simulation (`src/game/battle.ts`, ≤ 200 rounds with
an explicit stalemate outcome), `armyPower = attack × accuracy × √(hp ÷ (1 − armor))`
summed over stacks, and an Army tab that buys units and plays battles back at one round
per second. The `popMin`/`popMax` per-battle windows below were **dropped in the
implemented data** (battle entrance currently follows victory order only) — reintroduce
them only if the pacing simulation needs a finer gate. Unit availability inside an age
is deliberately **not** an encounter concern: new units arrive through the research tree
(Milestone 9) and as battle rewards, via the standard explicit unlock id lists. The
curated unit roster lives in `src/game/data/units.json` (79 units across the seven
ages). Encounters are data-driven with stable IDs, an age reference, a historical year,
enemy unit snapshots, and deterministic rewards applied to the state:

```ts
type EnemyStack = { unitId: string; count: number; label?: string };

type EncounterDefinition = {
  id: string;
  name: string;
  age: number; // 0-based age index; age-end bosses gate the next age
  year: number; // historical year, shown on the Gamepedia battle page
  isBoss: boolean;
  historical?: string; // short original blurb, Gamepedia battle page
  enemyArmy: EnemyStack[]; // authored enemy stacks (soft balance checks)
  enemyBoosts: Bonus[]; // fake-research boosts balancing later ages
  bonuses: Bonus[]; // victory rewards (same bonus channel as upgrades)
  unlocks: string[]; // explicit unlock id list, fired on victory
};
```

The game-length simulation should resolve encounters as they unlock so pacing estimates include combat.

## Gameplay pacing reference — a 7-day first loop (for balancing, not a target)

The length of the first loop is an *emergent property*, not a design parameter. This
matrix is a **playstyle reference for the Balance agent**, not a plan and not a target.
It assumes an **active-time-dominant** player who spends only a few minutes per session
and otherwise lets the game sit (the 12-hour offline cap from the Milestone 3
`E_off` mechanic is why the idle split works like this).

| Age | Population window | Active play per age | Idle/real-wait per age | Night pauses | Cumulative real-world |
| --- | --- | --- | --- | --- | --- |
| 1 · Ancient | 1 → 1,000 | 30 min | 15 min | — | 45 min |
| 2 · Iron | 1,000 → 10,000 | 20 min | 1 h 10 min | — | ~2.25 h |
| 3 · Classical | 10,000 → 1,000,000 | 30 min | 3 h 30 min | +1 night (12 h cap) | ~16 h (end of Day 1) |
| 4 · Middle Ages | 1,000,000 → 10,000,000 | 40 min | 11 h 20 min | +1 night | ~40 h (Day 2 → 3) |
| 5 · Renaissance | 10,000,000 → 100,000,000 | 50 min | 23 h 10 min | +1 night | ~64 h (Day 3 → 4) |
| 6 · Industrial | 100,000,000 → 1,000,000,000 | 60 min | 35 h 00 min | +2 nights (24 h) | ~124 h (Day 5 → 6) |
| 7 · Modern/Space | 1,000,000,000 → 10,000,000,000 | 70 min | 42 h 50 min (cap of 12 h/day baked into the idle column) | +3 nights | ends ~Day 7 |

Reading the matrix:

- Active time per age grows by **10 minutes after Age 3**, holding total real-world time
  near 7 days. This is the one tuning dial for play pace; everything else follows.
- The idle columns assume the Milestone 3 **offline efficiency `E_off` (25–50%)** and the
  **12-hour offline cap** — change `E_off` and the idle column collapses or stretches, and
  the total loop length changes accordingly. So `E_off` is the *second* pacing dial.
- The population windows here are the **age boundaries from the roadmap's 7-age model**, not
  the per-battle `popMin`/`popMax` windows from `temp/campaign_v2.json` (those are a separate
  pacing layer for battle entrance, handled by Milestone 8 and the pacing simulation).
- Wolves (the `age0_1_first_fire` encounter) indirectly affect this only by being a potential
  session-loss event; the model above doesn't yet credit that. If wolves block ~1 night of
  progress, add roughly one pause somewhere in Ages 2–4.

Notes for the Balance agent:

- This is a *scenario*, not the plan. The priority is that the loop feels right for a
  first-time player, with the 10-billion goal as the first-loop end — not that it fit on
  seven calendar days.
- Active time per age and `E_off` are the two cross-cutting pacing dials. Pacing tests
  (Milestone 10) should verify that the walker reaches 10 billion in a plausible session
  budget without requiring the player to babysit the game through middle ages.


Define minimum damage, armor interaction, attack cooldown, range rules, and target selection. Add deterministic tests for melee, ranged, armor, and defeated units before adding animations.

## Milestone 9: Research tree

Create a branching technology tree inspired by broad civilization progression:

- Food gathering and settled agriculture
- Pottery, weaving, and storage
- Animal domestication and transport
- Metallurgy and toolmaking
- Writing, administration, and mathematics
- Navigation, engineering, and organized warfare

Research is a globally priced, one-shot technology tree: the first purchase costs 100
science and purchase `n` costs `100 × 10^(√n − 1)`. A research definition stores its
stable id, name, age, category, prerequisites, bonuses, unit unlocks/conversions and
ignored-effect report—not an individual price. Age-0 includes Torsion Physics, so the
Ancient roster reaches its final Catapult before the Iron Age.

Use original names, descriptions, and artwork. The structure can evoke classic 4X progression without copying Civilization 2's exact technology tree, text, or assets.

## Milestone 10: Game-length simulation

Run the engine headlessly at accelerated speed while a simulated player issues the same actions the UI would — buying buildings, assigning and unassigning workers, gathering, and researching — to estimate expected game length and progression pacing before players ever see it.

Goals:

- Expected game length to each campaign goal (10 billion population, colony ship launch).
- Time-to-milestone curves: age transitions, first buildings, era/tech unlocks, and population milestones.
- Production and resource series over time to spot stalls, capacity walls, and dead ends.
- A bottleneck report naming which resources or capacities limited progress at each phase.

Design:

- Reuse the same engine and command/event layer the UI drives through `CivilizationState.tick()`; do not reimplement game rules in the simulation.
- Model the simulated player as a policy that converts the current state into actions. A policy approximates reasonable player behavior, for example assigning every idle worker before buying, buying the next affordable building, and keeping food/wood production ahead of drains:

```ts
type SimulationAction = {
  type: "buy" | "assign" | "unassign" | "gather" | "research";
  target: string;
  quantity?: number;
};

type SimulationPolicy = {
  name: string;
  decide(state: CivilizationState): SimulationAction[];
};

type SimulationResult = {
  policy: string;
  ticksToGoal: number;
  estimatedMinutes: number;
  milestones: Array<{ label: string; tick: number }>;
  series: Array<{ tick: number; population: number; resources: ResourceAmounts }>;
  bottlenecks: string[];
};
```

- Support multiple policies (passive, balanced, aggressive) so the report is a range of playstyles, not a single number.
- Runs must be deterministic: a fixed policy, no randomness, or a seeded RNG, so balance changes produce comparable reports.
- Advance many ticks per real second. If one engine tick represents one second of game time, convert ticks to the reported estimated game length in real minutes.
- Expose as a CLI/CI step so the Milestone 1 balance workflow ("Run balance checks or simulation tests") stays automated.
- Add regression tests asserting a fresh game reaches campaign goals within expected tick bounds, so balance edits that silently lengthen or break progression fail CI.

This milestone depends on command-style actions (Recommended order #3), statistics, saves, action multipliers, upgrades, research, and the campaign endpoints before it fully covers the loop.

## Long-term loop: From Earth to the stars

The first major civilization loop has two clear end goals:

1. Reach a population of **10 billion people**.
2. Develop and launch a colony ship to reach another colonizable solar system.

Suggested phases:

- **Settlement:** establish food, housing, production, research, and population systems.
- **Planetary civilization:** scale cities, administration, industry, science, military, and infrastructure toward 10 billion people.
- **Spacefaring civilization:** unlock orbital industry, advanced propulsion, life support, generation ships, and colony preparation.
- **Interstellar launch:** construct the colony ship, meet its resource and population requirements, then complete the first-loop expedition.

These phases can be mapped onto the seven ages from Milestone 2 to set pacing targets for each population range.

The colony ship should be a long-term project with multiple requirements rather than a single resource purchase:

- Ship structure and materials
- Propulsion technology
- Closed-loop life support
- Population selection and crew
- Food, water, and energy reserves
- Navigation and destination research

Completing the expedition can begin a new colony loop or prestige layer. The next system should inherit selected discoveries, technologies, or civilization bonuses while introducing new local constraints and content.

Balance target: reaching 10 billion should be a substantial campaign milestone, while the colony ship should require a final research and production phase after the population goal rather than arriving immediately when the target is reached.

## Recommended order

1. Refactor definitions into data modules.
2. Define the seven-age progression with population thresholds.
3. Introduce command-style engine actions and result events.
4. Add statistics from those events.
5. Add JSON saves and migrations.
6. Add action multipliers.
7. Add upgrades and research prerequisites.
8. Add achievements.
9. Add battle simulation and unit tests.
10. Add XML and Base64 codecs.
11. Add cloud/portal-specific persistence only after the local save contract is stable.
12. Add the 10-billion population campaign endpoint.
13. Add spacefaring research, colony ship construction, and the interstellar expansion loop.
14. Add headless game-length simulation that runs the engine at accelerated speed with simulated UI actions (buying, assigning, gathering, researching) and reports expected game length and pacing.

## Design cautions

- Keep definition IDs stable because saves, achievements, and statistics will reference them.
- Never use display names as save identifiers.
- Keep balance data separate from mechanics and rendering.
- Version every save format.
- XML and Base64 should encode the same canonical save model; they should not create separate gameplay representations.
- Add tests for cost scaling, production factors, drains, capacity, save migration, and MAX actions before expanding content.
- Keep game-length simulation runs deterministic so pacing reports stay comparable across balance changes.
