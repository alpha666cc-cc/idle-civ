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
2. Run balance checks or simulation tests.
3. Review the resulting progression and production rates.
4. Run the application build.

## Milestone 2: Save system

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

## Milestone 3: Action multiplier

Add a shared action quantity mode:

- `1`
- `10`
- `MAX`

Use it for gathering, assigning workers, buying repeated buildings, and similar actions. The engine should expose a calculation such as:

```ts
getActionQuantity(action: Action, mode: ActionQuantityMode): number;
```

The UI should use a segmented control. `MAX` must calculate the affordable and capacity-limited quantity without partially applying an invalid action.

## Milestone 4: Statistics

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

## Milestone 5: Achievements

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

## Milestone 6: Upgrades

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

## Milestone 7: Battle system

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

Define minimum damage, armor interaction, attack cooldown, range rules, and target selection. Add deterministic tests for melee, ranged, armor, and defeated units before adding animations.

## Milestone 8: Research tree

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

Use original names, descriptions, and artwork. The structure can evoke classic 4X progression without copying Civilization 2's exact technology tree, text, or assets.

## Long-term loop: From Earth to the stars

The first major civilization loop has two clear end goals:

1. Reach a population of **10 billion people**.
2. Develop and launch a colony ship to reach another colonizable solar system.

Suggested phases:

- **Settlement:** establish food, housing, production, research, and population systems.
- **Planetary civilization:** scale cities, administration, industry, science, military, and infrastructure toward 10 billion people.
- **Spacefaring civilization:** unlock orbital industry, advanced propulsion, life support, generation ships, and colony preparation.
- **Interstellar launch:** construct the colony ship, meet its resource and population requirements, then complete the first-loop expedition.

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
2. Introduce command-style engine actions and result events.
3. Add statistics from those events.
4. Add JSON saves and migrations.
5. Add action multipliers.
6. Add upgrades and research prerequisites.
7. Add achievements.
8. Add battle simulation and unit tests.
9. Add XML and Base64 codecs.
10. Add cloud/portal-specific persistence only after the local save contract is stable.
11. Add the 10-billion population campaign endpoint.
12. Add spacefaring research, colony ship construction, and the interstellar expansion loop.

## Design cautions

- Keep definition IDs stable because saves, achievements, and statistics will reference them.
- Never use display names as save identifiers.
- Keep balance data separate from mechanics and rendering.
- Version every save format.
- XML and Base64 should encode the same canonical save model; they should not create separate gameplay representations.
- Add tests for cost scaling, production factors, drains, capacity, save migration, and MAX actions before expanding content.
