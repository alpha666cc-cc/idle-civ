against the sum of passive production and the modeled gather clicks per second.

# Game Simulation System

A headless simulation engine for balance testing and strategy optimization in the idle-civ game.

## Overview

The simulation system allows you to:

- Run automated game simulations with configurable strategies
- Test different gameplay approaches (balanced, production-focused, military-focused, etc.)
- Compare multiple strategies in parallel
- Run evolutionary tournaments to find optimal strategies
- Record detailed snapshots at game milestones (ages, battles)
- Test balance changes without manual gameplay

## Architecture

### Core Components

- **simulation.ts**: Main simulation engine that runs headless games
- **strategies.ts**: Pre-built strategies for decision-making
- **simulationRunner.ts**: Simplified interface for running simulations
- **strategyComparison.ts**: Multi-strategy comparison and evolution system

### Strategy Types

- **cheapest**: Always buy the cheapest legal purchase
- **balanced**: Equal focus on production and military
- **production**: Maximize resource generation, minimal military
- **military**: Early military investment, aggressive battles
- **fast-age**: Push population growth to age up quickly
- **economy**: Maximize gold and trade production
- **speedrun**: Buy the highest time-adjusted ROI purchase for fast progression
- **trader**: Bank trade power at the market and route it to the settlement's
  largest imbalance

### Trade Routes

Trade power is a reserve nothing else spends, so a strategy that never opens a route
banks it forever. `tools/tradeAdvisor.ts` is how a strategy spends it, through the
real `CivilizationState.setTradeRoute()` — the same price, spread and per-tick drain
rows the Trade tab produces. Its policy: **point the route at the resource whose
stock has drifted furthest from what the settlement's own production justifies, and
size it to the flow it should move rather than to the reserve it could liquidate.**

- Each tradable resource gets a _buffer_ of 600 seconds of its own net production.
  Below it the resource is a shortage (buy), above it a surplus (sell). A resource
  the settlement produces nothing of is sized against the slowest thing it does make.
- Candidates are ranked in **gold** (`units × goldPerResource`, times the spread on
  the buying side), because units of food and units of science are not comparable and
  gold is the currency every price is quoted in.
- A **sell** route moves one second of inflow, so a surplus drains as fast as it
  builds; a **buy** route replaces the shortfall it found over a fixed window. A
  resource with no production is never sold — a leftover stock is dead weight.
- Every rate is read with the settlement's own route rows put back, so a route cannot
  consume the production it is judged on and then decide it has none.
- The intensity is quantised onto the same logarithmic slider stops the Trade tab
  uses, so it only moves when the target flow moves by a factor of √10.

Trade is opt-in per strategy: `BaseStrategy.getTradeProfile()` returns `null` by
default, which is why the other seven strategies behave exactly as they did before
routes existed. The `trader` strategy opts in with the full reserve. The market
unlocks in the Iron Age, so every strategy's route is dormant until then, and an
empty reserve never gets a route at all rather than holding a slot on a dead one.
`tools/snapshot-csv.ts` records `trade_power`, `trade_power_rate`,
`trade_routes_active` and one `route.<resource>` cell per snapshot, so a sweep can
tell "no route was opened" from "a route opened that moved nothing".

### ROI Evaluation and Speedrun Planning

`tools/roi.ts` is a headless-only evaluator for every buyable kind: buildings,
research, upgrades, and units. It does not duplicate balance data. For each legal
candidate it applies the real domain transition to a resource-rich immutable probe,
then measures log-scaled marginal gains in production, capacity, population,
military power, unit unlocks, and building-cost savings. Upgrades receive a
configurable preference multiplier because enhancer effects are intentionally
large; the default is 4.

The time component is an estimated acquisition wait. Missing resources are valued
against the larger of passive production and the modeled gather clicks per second.
Candidates with no positive income are unreachable, and a candidate whose best
missing resource is gatherable produces a gather action instead of a purchase. The
comparison score is:

```text
timeAdjustedRoi = benefit / (1 + estimatedWaitSeconds)
```

The `speedrun` strategy preserves the campaign gates and then uses the best
non-unit ROI action before the battle-simulator advisor's recruitment fallback.
The order is: real battle launch, required battle preparation, the ROI purchase
(or a gather action for its missing cost), the advisor's unit/research fallback, and
finally the existing legacy heuristics. Unit recruitment stays with the battle
simulator because army composition is battle-specific rather than a single
economy ROI. `getRoiCandidates()` can still include units for analysis;
`getBestRoiAction(..., { includeUnits: false })` matches the strategy policy.

Example:

```bash
# Run the ROI-first strategy for 10 simulated minutes
npm run simulate -- --strategy speedrun --max-time 600

# Compare the literal cheapest baseline with ROI planning
npm run simulate:compare -- --strategies cheapest,speedrun --max-time 600
```

### Battle-Aware Planning

The battle-aware strategies (`balanced`, `production`, `military`, `fast-age`, and
`economy`) use the shared minimum-army simulator before their legacy research and
unit heuristics. The plan starts with the army already owned, uses current recruit
discounts, and applies the research bonuses the next battle can use. A strategy buys
one simulator-recommended recruit (or the first available unlock research) and
re-plans after the purchase. If a recommendation is not affordable yet, it gathers
the missing resource.

The simulator is advisory, not the campaign battle: `simulateEncounter()` remains
the only gate for launching a battle. If the advisor is optimistic or its bounded
search cannot find a plan, the strategy falls back to its existing purchase logic and
continues buying/re-planning. The `cheapest` strategy intentionally remains a literal
cheapest-purchase baseline and does not use the military advisor.

## Usage

### Running a Single Simulation

```bash
# Run balanced strategy for 1 hour
npm run simulate -- --strategy balanced --max-time 3600

# Reach age1 with production strategy
npm run simulate -- --strategy production --objective ageReach --age age1

# Build 5 farms with military strategy
npm run simulate -- --strategy military --objective buildingCount --building farm --target 5

# Win first battle with fast-age strategy
npm run simulate -- --strategy fast-age --objective battleVictory --battle age0_1_first_fire
```

### Comparing Multiple Strategies

```bash
# Compare all strategies for 1 hour
npm run simulate:compare -- --max-time 3600

# Compare specific strategies to reach age1
npm run simulate:compare -- --strategies balanced,production --objective ageReach --age age1

# Run evolutionary tournament for 5 generations
npm run simulate:compare -- --generations 5 --top 2 --max-time 1800
```

### CLI Options

#### Single Simulation (`npm run simulate`)

- `--strategy <name>`: Strategy to use (default: balanced)
- `--objective <type>`: Objective type (buildingCount, ageReach, battleVictory, timeLimit)
- `--target <value>`: Target value for objective (default: 3600)
- `--building <key>`: Building key for buildingCount objective
- `--age <id>`: Age ID for ageReach objective (e.g., age1)
- `--battle <id>`: Encounter ID for battleVictory objective
- `--max-time <seconds>`: Maximum simulation time (default: 3600)
- `--actions-per-second <n>`: Strategy actions per simulated second (default: 5)
- `--seed <number>`: Random seed (default: 42)
- `--output <file>`: Output file for results (JSON)
- `--no-snapshots`: Disable snapshot recording
- `--verbose`: Enable verbose per-action logging (gathered amounts, builds, worker moves, battles)

#### Strategy Comparison (`npm run simulate:compare`)

- `--strategies <names>`: Comma-separated strategy names (default: all)
- `--objective <type>`: Objective type (default: timeLimit)
- `--target <value>`: Target value for objective (default: 3600)
- `--building <key>`: Building key for buildingCount objective
- `--age <id>`: Age ID for ageReach objective
- `--battle <id>`: Encounter ID for battleVictory objective
- `--max-time <seconds>`: Maximum simulation time (default: 3600)
- `--actions-per-second <n>`: Strategy actions per simulated second (default: 5)
- `--seed <number>`: Random seed (default: 42)
- `--output <file>`: Output file for results (JSON)
- `--generations <number>`: Number of evolutionary generations (default: 1)
- `--top <number>`: Top N strategies to keep per generation (default: 2)
- `--no-snapshots`: Disable snapshot recording

## Simulation Mechanics

### Action Model

- **Five actions per tick by default** — each simulated second starts with five action
  slots, executes up to five normal strategy actions, then advances the engine with one
  `tick()`. `--actions-per-second <n>` changes the slot count.
- **Gather consumes the remaining budget** — when the strategy chooses `gather`, that
  action consumes every remaining slot before the tick. With the default five slots, one
  gather decision performs one gather action and then advances the tick.
- **Gather actions model 10 clicks** — each gather execution loops the engine's
  `gather(resource)` `gatherClicksPerAction` times (default 10), adding ten
  `computeClickGain()` amounts and counting ten production clicks (toward click
  achievements, e.g. the 100-click milestone); the gathered amount is logged.
- **Actions include**: gather resources, assign workers, build buildings, launch battles

### Milestones

Snapshots are automatically recorded at:

- Age entry (when the ordered age transition is completed)
- Battle victories
- Regular intervals (every 5 minutes for long simulations)

### Objectives

The simulation can terminate based on:

- **buildingCount**: Build N of a specific building
- **ageReach**: Enter a specific age
- **battleVictory**: Win a specific battle
- **timeLimit**: Run for a specified duration

## Programmatic Usage

You can also use the simulation system programmatically:

```typescript
import { getStrategy } from "./tools/strategies.js";
import { runSimulation } from "./tools/simulationRunner.js";

const strategy = getStrategy("balanced");
const result = runSimulation(strategy, {
  seed: 42,
  objective: { type: "timeLimit", seconds: 3600 },
  gatherClicksPerAction: 10,
  actionsPerSecond: 5,
  maxGameTime: 3600,
  recordSnapshots: true,
});

console.log(`Final population: ${result.finalState.population}`);
console.log(`Buildings: ${result.snapshots}`);
```

## Creating Custom Strategies

To create a custom strategy, implement the `SimulationStrategy` interface:

```typescript
import type {
  SimulationStrategy,
  SimulationAction,
  SimulationContext,
} from "./simulation.js";
import { CivilizationState } from "../src/game/civilizationState.js";

class MyCustomStrategy implements SimulationStrategy {
  name = "my-custom";
  description = "My custom strategy description";

  decideAction(
    state: CivilizationState,
    context: SimulationContext,
  ): SimulationAction | null {
    // Your decision logic here
    return { type: "build", building: "farm", count: 1 };
  }

  onMilestone?(event: MilestoneEvent, state: CivilizationState): void {
    // Optional: React to milestones
  }
}
```

## Balance Testing Workflow

1. **Define objective**: What do you want to test? (e.g., reach age1 in under 10 minutes)
2. **Choose strategies**: Select relevant strategies or create custom ones
3. **Run simulations**: Execute with desired configuration
4. **Analyze results**: Review snapshots, production rates, building counts
5. **Iterate**: Adjust game balance based on findings

## Notes

- The simulation system is React-free and runs entirely in the domain layer
- All simulations are deterministic based on the seed
- The engine respects all game rules (capacity limits, costs, unlocks)
- Units are never lost in battles (armies are restored post-battle)
- The system uses the same `CivilizationState` as the live game

## Future Enhancements

- [ ] Strategy mutation and crossover for true evolutionary algorithms
- [ ] More sophisticated AI-based strategies
- [ ] Automatic balance tuning based on simulation results
- [ ] Visualization of simulation timelines
- [ ] Integration with CI/CD for balance regression testing
