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

- **balanced**: Equal focus on production and military
- **production**: Maximize resource generation, minimal military
- **military**: Early military investment, aggressive battles
- **fast-age**: Push population growth to age up quickly
- **economy**: Maximize gold and trade production

## Usage

### Running a Single Simulation

```bash
# Run balanced strategy for 1 hour
npm run simulate -- --strategy balanced --max-time 3600

# Reach age-1 with production strategy
npm run simulate -- --strategy production --objective ageReach --age age-1

# Build 5 farms with military strategy
npm run simulate -- --strategy military --objective buildingCount --building farm --target 5

# Win first battle with fast-age strategy
npm run simulate -- --strategy fast-age --objective battleVictory --battle age0_1_first_fire
```

### Comparing Multiple Strategies

```bash
# Compare all strategies for 1 hour
npm run simulate:compare -- --max-time 3600

# Compare specific strategies to reach age-1
npm run simulate:compare -- --strategies balanced,production --objective ageReach --age age-1

# Run evolutionary tournament for 5 generations
npm run simulate:compare -- --generations 5 --top 2 --max-time 1800
```

### CLI Options

#### Single Simulation (`npm run simulate`)

- `--strategy <name>`: Strategy to use (default: balanced)
- `--objective <type>`: Objective type (buildingCount, ageReach, battleVictory, timeLimit)
- `--target <value>`: Target value for objective (default: 3600)
- `--building <key>`: Building key for buildingCount objective
- `--age <id>`: Age ID for ageReach objective (e.g., age-1)
- `--battle <id>`: Encounter ID for battleVictory objective
- `--actions <rate>`: Actions per second (default: 10)
- `--skip <seconds>`: Skip interval in seconds (default: 60)
- `--max-time <seconds>`: Maximum simulation time (default: 3600)
- `--seed <number>`: Random seed (default: 42)
- `--output <file>`: Output file for results (JSON)
- `--no-snapshots`: Disable snapshot recording

#### Strategy Comparison (`npm run simulate:compare`)

- `--strategies <names>`: Comma-separated strategy names (default: all)
- `--objective <type>`: Objective type (default: timeLimit)
- `--target <value>`: Target value for objective (default: 3600)
- `--building <key>`: Building key for buildingCount objective
- `--age <id>`: Age ID for ageReach objective
- `--battle <id>`: Encounter ID for battleVictory objective
- `--actions <rate>`: Actions per second (default: 10)
- `--skip <seconds>`: Skip interval in seconds (default: 60)
- `----max-time <seconds>`: Maximum simulation time (default: 3600)
- `--seed <number>`: Random seed (default: 42)
- `--output <file>`: Output file for results (JSON)
- `--generations <number>`: Number of evolutionary generations (default: 1)
- `--top <number>`: Top N strategies to keep per generation (default: 2)
- `--no-snapshots`: Disable snapshot recording

## Simulation Mechanics

### Action Model

- **First age**: 10 actions/second (granular decisions)
- **Later ages**: Batch actions → skip 1 minute → repeat
- **Actions include**: gather resources, assign workers, build buildings, launch battles

### Milestones

Snapshots are automatically recorded at:
- Age entry (when population thresholds are reached)
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
  actionRate: 10,
  skipInterval: 60,
  maxGameTime: 3600,
  recordSnapshots: true,
});

console.log(`Final population: ${result.finalState.population}`);
console.log(`Buildings: ${result.snapshots}`);
```

## Creating Custom Strategies

To create a custom strategy, implement the `SimulationStrategy` interface:

```typescript
import type { SimulationStrategy, SimulationAction, SimulationContext } from "./simulation.js";
import { CivilizationState } from "../src/game/civilizationState.js";

class MyCustomStrategy implements SimulationStrategy {
  name = "my-custom";
  description = "My custom strategy description";

  decideAction(state: CivilizationState, context: SimulationContext): SimulationAction | null {
    // Your decision logic here
    return { type: "build", building: "farm", count: 1 };
  }

  onMilestone?(event: MilestoneEvent, state: CivilizationState): void {
    // Optional: React to milestones
  }
}
```

## Balance Testing Workflow

1. **Define objective**: What do you want to test? (e.g., reach age-1 in under 10 minutes)
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
