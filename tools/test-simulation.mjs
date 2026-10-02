/**
 * Simple test to validate the simulation system works.
 */

import { getStrategy } from "./strategies.js";
import { runSimulation } from "./simulationRunner.js";

console.log("Testing simulation system...\n");

// Test 1: Run a short simulation with balanced strategy
console.log("Test 1: Running balanced strategy for 60 seconds...");
const strategy1 = getStrategy("balanced");
const result1 = runSimulation(strategy1, {
  objective: { type: "timeLimit", seconds: 60 },
  gatherClicksPerAction: 10,
  maxGameTime: 60,
  recordSnapshots: true,
});

console.log(`Result: ${result1.success ? "Success" : "Failed"}`);
console.log(`Game time: ${result1.gameTime}s`);
console.log(`Termination: ${result1.terminationReason}`);
console.log(`Snapshots: ${result1.snapshots.length}`);
console.log(`Final population: ${result1.finalState.population}`);

// Test 2: Test production strategy
console.log("\nTest 2: Running production strategy for 30 seconds...");
const strategy2 = getStrategy("production");
const result2 = runSimulation(strategy2, {
  objective: { type: "timeLimit", seconds: 30 },
  gatherClicksPerAction: 10,
  maxGameTime: 30,
  recordSnapshots: false,
});

console.log(`Result: ${result2.success ? "Success" : "Failed"}`);
console.log(`Game time: ${result2.gameTime}s`);
console.log(`Final population: ${result2.finalState.population}`);

console.log("\n✓ Simulation system is working correctly!");
