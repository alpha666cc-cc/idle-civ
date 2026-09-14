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
    resources.ts
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
  resources.ts
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
  encounters?: string[]; // one or two battles expected this age (see Milestone 8)
};
```

- Compute the current age as the highest threshold reached; do not persist an age counter in the save. Keep ages data-driven so the engine has no era-specific conditionals.
- Make building availability age-driven data instead of the current hard-coded `available` boolean; `canBuild` then reflects the current age.
- Emit age-transition events so statistics and achievements can record them and the game-length simulation (see Milestone 10) can report time-to-age.
- Expect one or two battles per age (see Milestone 8 for encounter pacing). The first is a wolf in the opening Ancient age whose defeat expands the town-hall count beyond its default cap of 10.
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

Encounter pacing: expect one or two battles per age — seven to fourteen encounters across the whole campaign — aligned with the age definitions (see Milestone 2). The first encounter is a wolf in the opening Ancient age; defeating it expands the town-hall count beyond the default cap of 10. Each later battle follows the same pattern: a victory applies a data-driven reward such as a raised building cap, an upgrade, or a research unlock, so combat acts as a pacing gate alongside the age population thresholds. Encounters should be data-driven with stable IDs, an age reference, enemy unit snapshots, and deterministic rewards applied to the save:

```ts
type EncounterDefinition = {
  id: string;
  age: string; // age definition ID (see Milestone 2)
  enemies: UnitDefinition[];
  rewards: EffectDefinition[]; // e.g. raise the town-hall maxCount cap
};
```

The game-length simulation should resolve encounters as they unlock so pacing estimates include combat.

Define minimum damage, armor interaction, attack cooldown, range rules, and target selection. Add deterministic tests for melee, ranged, armor, and defeated units before adding animations.

## Milestone 9: Research tree

Create a branching technology tree inspired by broad civilization progression:

- Food gathering and settled agriculture
- Pottery, weaving, and storage
- Animal domestication and transport
- Metallurgy and toolmaking
- Writing, administration, and mathematics
- Navigation, engineering, and organized warfare

Each technology should define stable IDs, prerequisites, research cost, era, and effects:

```ts
type ResearchDefinition = {
  id: string;
  name: string;
  era: string;
  prerequisites: string[];
  scienceCost: number;
  effects: EffectDefinition[];
};
```

The `era` field references an age definition from Milestone 2.

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
