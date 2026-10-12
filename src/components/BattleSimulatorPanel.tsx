import { useMemo, useState } from "react";
import type { CivilizationState } from "../game/civilizationState";
import {
  simulatorCandidates,
  solveMinimumArmy,
  type SimulatorOwnedArmy,
  type SimulatorResult,
  type SimulatorTotalArmy,
} from "../game/battleSimulator";
import { encounterDefinitions } from "../game/encounters";
import { findUnitDefinition } from "../game/units";
import { findResearchDefinition, researchIdsForBattle } from "../game/research";
import { ExpNumber } from "../game/expNumber";
import { findFormationDefinition, type FormationId } from "../game/formations";
import {
  findOrderDefinition,
  type OrderId,
  DEFAULT_ORDER,
} from "../game/orders";
import type { ArmyStack } from "../game/battle";
import {
  optimizeFormations,
  type FormationAssignment,
} from "../game/formationOptimizer";

/** Whether a current army plus the proposed recruits defeats the battle. */
const winsWithStats = (
  gameState: CivilizationState,
  battleId: string,
  total: SimulatorTotalArmy,
): boolean => {
  const researchIds = researchIdsForBattle(
    encounterDefinitions.find(({ key }) => key === battleId)?.age ?? 0,
    [...total.keys()],
  );
  const stacks = [...total.entries()]
    .map(([unitId, count]) => ({
      unitId,
      count,
      stats: gameState.getUnitStatsWithResearch(unitId, researchIds),
    }))
    .filter(
      (
        stack,
      ): stack is {
        unitId: string;
        count: ExpNumber;
        stats: NonNullable<ReturnType<CivilizationState["getUnitStats"]>>;
      } => stack.stats !== undefined,
    );
  const enemy = gameState.getEnemyStacks(battleId);
  if (stacks.length === 0 || enemy.length === 0) return false;
  return gameState.simulateWithStacksOutcome(stacks, enemy) === "player";
};

/** Whether a current army with specific formations defeats the battle. */
const winsWithStatsAndFormations = (
  gameState: CivilizationState,
  battleId: string,
  total: SimulatorTotalArmy,
  formations: ReadonlyMap<string, FormationId>,
): boolean => {
  const researchIds = researchIdsForBattle(
    encounterDefinitions.find(({ key }) => key === battleId)?.age ?? 0,
    [...total.keys()],
  );
  const stacks: ArmyStack[] = [];
  for (const [unitId, count] of total) {
    const stats = gameState.getUnitStatsWithResearch(unitId, researchIds);
    if (!stats) continue;
    stacks.push({
      unitId,
      count,
      stats,
      formation: formations.get(unitId),
      order: DEFAULT_ORDER,
    });
  }
  const enemy = gameState.getEnemyStacks(battleId);
  if (stacks.length === 0 || enemy.length === 0) return false;
  return gameState.simulateWithStacksOutcome(stacks, enemy) === "player";
};

/** Whether a current army with specific formations and orders defeats the battle. */
const winsWithStatsAndFormationsAndOrders = (
  gameState: CivilizationState,
  battleId: string,
  total: SimulatorTotalArmy,
  formations: ReadonlyMap<string, FormationId>,
  orders: ReadonlyMap<string, OrderId>,
): boolean => {
  const researchIds = researchIdsForBattle(
    encounterDefinitions.find(({ key }) => key === battleId)?.age ?? 0,
    [...total.keys()],
  );
  const stacks: ArmyStack[] = [];
  for (const [unitId, count] of total) {
    const stats = gameState.getUnitStatsWithResearch(unitId, researchIds);
    if (!stats) continue;
    stacks.push({
      unitId,
      count,
      stats,
      formation: formations.get(unitId),
      order: orders.get(unitId) ?? DEFAULT_ORDER,
    });
  }
  const enemy = gameState.getEnemyStacks(battleId);
  if (stacks.length === 0 || enemy.length === 0) return false;
  return gameState.simulateWithStacksOutcome(stacks, enemy) === "player";
};

export default function BattleSimulatorPanel({
  gameState,
  fmt,
}: {
  gameState: CivilizationState;
  fmt: (n: ExpNumber | number) => string;
}) {
  const [battleId, setBattleId] = useState<string>("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [optimizedFormationsHalf, setOptimizedFormationsHalf] =
    useState<FormationAssignment | null>(null);
  const [optimizedFormations90, setOptimizedFormations90] =
    useState<FormationAssignment | null>(null);

  const battle = encounterDefinitions.find(({ key }) => key === battleId);
  const candidates = useMemo(
    () => (battle ? simulatorCandidates(battle.age) : []),
    [battle],
  );
  const ownedArmy = useMemo<SimulatorOwnedArmy>(
    () =>
      new Map(
        gameState
          .getArmyStacks()
          .map(({ unitId, count }) => [unitId, count] as const),
      ),
    [gameState],
  );
  const currentArmyKey = [
    ...[...ownedArmy.entries()].map(
      ([unitId, count]) => `${unitId}:${count.toString()}`,
    ),
    `research:${gameState.boughtResearch.join(",")}`,
  ].join("|");
  const [resultState, setResultState] = useState<{
    readonly armyKey: string;
    readonly result: SimulatorResult | null;
  } | null>(null);
  const result =
    resultState?.armyKey === currentArmyKey ? resultState.result : null;
  const failed = resultState?.armyKey === currentArmyKey && result === null;

  const selectBattle = (id: string): void => {
    const selectedBattle = encounterDefinitions.find(({ key }) => key === id);
    setBattleId(id);
    if (selectedBattle) {
      const battleCandidates = simulatorCandidates(selectedBattle.age);
      const unlockedUnits = battleCandidates
        .filter((unit) => gameState.isUnitAvailable(unit.key))
        .map((unit) => unit.key);
      setSelected(new Set(unlockedUnits));
    } else {
      setSelected(new Set());
    }
    setResultState(null);
    setOptimizedFormationsHalf(null);
    setOptimizedFormations90(null);
  };

  const toggleUnit = (unitId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
    setResultState(null);
    setOptimizedFormationsHalf(null);
    setOptimizedFormations90(null);
  };

  const reset = (): void => {
    setBattleId("");
    setSelected(new Set());
    setResultState(null);
    setOptimizedFormationsHalf(null);
    setOptimizedFormations90(null);
  };

  const run = (): void => {
    if (!battle || running) return;
    setRunning(true);
    setOptimizedFormationsHalf(null);
    setOptimizedFormations90(null);

    console.log(
      "[Battle Optimizer] Step 1: Running battle optimizer without formation research",
    );
    // Let the button paint before the synchronous search blocks the thread.
    window.setTimeout(() => {
      const units = candidates.filter((unit) => selected.has(unit.key));
      const outcome = solveMinimumArmy(
        battle.key,
        units,
        {
          getCost: (unitId, count) => gameState.getUnitCost(unitId, count),
          getResearch: (unitIds) => gameState.getResearchForUnitTypes(unitIds),
          wins: (composition) =>
            winsWithStats(gameState, battle.key, composition),
          winsWithFormations: (composition, formations) =>
            winsWithStatsAndFormations(
              gameState,
              battle.key,
              composition,
              formations,
            ),
          winsWithFormationsAndOrders: (composition, formations, orders) =>
            winsWithStatsAndFormationsAndOrders(
              gameState,
              battle.key,
              composition,
              formations,
              orders,
            ),
        },
        false, // Disable formation research in battle optimizer
        ownedArmy,
      );
      console.log("[Battle Optimizer] Step 1 complete. Result:", outcome);
      setResultState({ armyKey: currentArmyKey, result: outcome });

      // Step 2: Run half formation optimizer
      if (!outcome) {
        console.log("[Battle Optimizer] Step 2 skipped: no winning army found");
        setRunning(false);
        return;
      }

      console.log(
        "[Battle Optimizer] Step 2: Running half formation optimizer",
      );
      const playerStacksHalf: ArmyStack[] = [];
      if (outcome.totalComposition.size > 0) {
        const researchIds = researchIdsForBattle(battle.age, [
          ...outcome.totalComposition.keys(),
        ]);
        for (const [unitId, count] of outcome.totalComposition) {
          const stats = gameState.getUnitStatsWithResearch(unitId, researchIds);
          if (!stats) continue;
          const halfCount = count.div(ExpNumber.fromNumber(2)).ceil();
          if (halfCount.lte(ExpNumber.ZERO)) continue;
          playerStacksHalf.push({
            unitId,
            count: halfCount,
            stats,
            formation: outcome.formations.get(unitId),
            order: outcome.orders.get(unitId) ?? DEFAULT_ORDER,
          });
        }
      } else {
        for (const stack of gameState.getArmyStacks()) {
          const halfCount = stack.count.div(ExpNumber.fromNumber(2)).ceil();
          if (halfCount.lte(ExpNumber.ZERO)) continue;
          playerStacksHalf.push({
            ...stack,
            count: halfCount,
          });
        }
      }

      const enemy = gameState.getEnemyStacks(battle.key);
      if (playerStacksHalf.length > 0 && enemy.length > 0) {
        const currentAge = gameState.getCurrentAge();
        const ageIndex = currentAge
          ? parseInt(currentAge.key.slice(-1), 10)
          : 0;
        const availableFormations = gameState.getAvailableFormations();

        if (ageIndex >= 2 && availableFormations.length > 1) {
          const currentAssignmentsHalf: FormationAssignment = {};
          if (outcome.formations.size > 0) {
            for (const [unitId, formation] of outcome.formations) {
              currentAssignmentsHalf[unitId] = formation;
            }
          } else {
            for (const stack of playerStacksHalf) {
              currentAssignmentsHalf[stack.unitId] = gameState.getUnitFormation(
                stack.unitId,
              );
            }
          }

          const optimizationHalf = optimizeFormations(
            playerStacksHalf,
            enemy,
            currentAssignmentsHalf,
            availableFormations,
            {
              maxIterations: 100,
              maxRestarts: 5,
              convergenceThreshold: 10,
            },
          );
          console.log(
            "[Battle Optimizer] Step 2 complete. Half formations:",
            optimizationHalf.bestAssignments,
          );
          setOptimizedFormationsHalf(optimizationHalf.bestAssignments);

          // Step 3: Re-run battle optimizer with half formations locked in
          console.log(
            "[Battle Optimizer] Step 3: Re-running battle optimizer with half formations locked",
          );
          const outcome2 = solveMinimumArmy(
            battle.key,
            units,
            {
              getCost: (unitId, count) => gameState.getUnitCost(unitId, count),
              getResearch: (unitIds) =>
                gameState.getResearchForUnitTypes(unitIds),
              wins: (composition) =>
                winsWithStats(gameState, battle.key, composition),
              winsWithFormations: (composition, formations) =>
                winsWithStatsAndFormations(
                  gameState,
                  battle.key,
                  composition,
                  formations,
                ),
              winsWithFormationsAndOrders: (composition, formations, orders) =>
                winsWithStatsAndFormationsAndOrders(
                  gameState,
                  battle.key,
                  composition,
                  formations,
                  orders,
                ),
            },
            false, // Still disable formation research
            ownedArmy,
            new Map(Object.entries(optimizationHalf.bestAssignments)), // Lock in the half formations
          );
          console.log(
            "[Battle Optimizer] Step 3 complete. Result with locked formations:",
            outcome2,
          );
          setResultState({ armyKey: currentArmyKey, result: outcome2 });

          // Step 4: Run formation optimizer with army + 90% recruits
          if (!outcome2) {
            console.log(
              "[Battle Optimizer] Step 4 skipped: no winning army found",
            );
            setRunning(false);
            return;
          }

          console.log(
            "[Battle Optimizer] Step 4: Running formation optimizer with army + 90% recruits",
          );
          const playerStacks90: ArmyStack[] = [];
          if (outcome2.totalComposition.size > 0) {
            const researchIds = researchIdsForBattle(battle.age, [
              ...outcome2.totalComposition.keys(),
            ]);
            for (const [unitId, count] of outcome2.totalComposition) {
              const stats = gameState.getUnitStatsWithResearch(
                unitId,
                researchIds,
              );
              if (!stats) continue;
              // Use 90% of the count
              const count90 = count.mul(ExpNumber.fromNumber(0.9)).ceil();
              if (count90.lte(ExpNumber.ZERO)) continue;
              playerStacks90.push({
                unitId,
                count: count90,
                stats,
                formation: outcome2.formations.get(unitId),
                order: outcome2.orders.get(unitId) ?? DEFAULT_ORDER,
              });
            }
          } else {
            for (const stack of gameState.getArmyStacks()) {
              const count90 = stack.count.mul(ExpNumber.fromNumber(0.9)).ceil();
              if (count90.lte(ExpNumber.ZERO)) continue;
              playerStacks90.push({
                ...stack,
                count: count90,
              });
            }
          }

          if (playerStacks90.length > 0 && enemy.length > 0) {
            const currentAge = gameState.getCurrentAge();
            const ageIndex = currentAge
              ? parseInt(currentAge.key.slice(-1), 10)
              : 0;
            const availableFormations = gameState.getAvailableFormations();

            if (ageIndex >= 2 && availableFormations.length > 1) {
              const currentAssignments90: FormationAssignment = {};
              if (outcome2.formations.size > 0) {
                for (const [unitId, formation] of outcome2.formations) {
                  currentAssignments90[unitId] = formation;
                }
              } else {
                for (const stack of playerStacks90) {
                  currentAssignments90[stack.unitId] =
                    gameState.getUnitFormation(stack.unitId);
                }
              }

              const optimization90 = optimizeFormations(
                playerStacks90,
                enemy,
                currentAssignments90,
                availableFormations,
                {
                  maxIterations: 100,
                  maxRestarts: 5,
                  convergenceThreshold: 10,
                },
              );
              console.log(
                "[Battle Optimizer] Step 4 complete. 90% formations:",
                optimization90.bestAssignments,
              );
              setOptimizedFormations90(optimization90.bestAssignments);

              // Step 5: If formations changed, re-run battle optimizer with new formations
              const formationsChanged =
                JSON.stringify(optimization90.bestAssignments) !==
                JSON.stringify(optimizationHalf.bestAssignments);
              if (formationsChanged) {
                console.log(
                  "[Battle Optimizer] Step 5: Formations changed, re-running battle optimizer",
                );
                const outcome3 = solveMinimumArmy(
                  battle.key,
                  units,
                  {
                    getCost: (unitId, count) =>
                      gameState.getUnitCost(unitId, count),
                    getResearch: (unitIds) =>
                      gameState.getResearchForUnitTypes(unitIds),
                    wins: (composition) =>
                      winsWithStats(gameState, battle.key, composition),
                    winsWithFormations: (composition, formations) =>
                      winsWithStatsAndFormations(
                        gameState,
                        battle.key,
                        composition,
                        formations,
                      ),
                    winsWithFormationsAndOrders: (
                      composition,
                      formations,
                      orders,
                    ) =>
                      winsWithStatsAndFormationsAndOrders(
                        gameState,
                        battle.key,
                        composition,
                        formations,
                        orders,
                      ),
                  },
                  false,
                  ownedArmy,
                  new Map(Object.entries(optimization90.bestAssignments)),
                );
                console.log(
                  "[Battle Optimizer] Step 5 complete. Final result:",
                  outcome3,
                );
                setResultState({ armyKey: currentArmyKey, result: outcome3 });
              } else {
                console.log(
                  "[Battle Optimizer] Step 5 skipped: formations unchanged",
                );
              }
            } else {
              console.log(
                "[Battle Optimizer] Step 4 skipped: formations not available",
              );
            }
          } else {
            console.log(
              "[Battle Optimizer] Step 4 skipped: no army to optimize",
            );
          }
        } else {
          console.log(
            "[Battle Optimizer] Step 2 skipped: formations not available",
          );
        }
      } else {
        console.log("[Battle Optimizer] Step 2 skipped: no army to optimize");
      }

      setRunning(false);
    }, 30);
  };

  return (
    <section className="dev-tools-panel" aria-label="Battle simulator">
      <div className="dev-tools-heading">
        <h3>Battle simulator</h3>
        <p className="dev-tools-copy">
          Starts with the army you already own, then finds the cheapest
          additional recruits that win. Unit stats use current and required
          research bonuses; recruit costs use your current discounts. The enemy
          uses prior-age and unlock research plus its encounter boosts.
        </p>
      </div>
      <label className="dev-tools-label" htmlFor="battle-simulator-battle">
        Battle
      </label>
      <select
        id="battle-simulator-battle"
        className="dev-tools-select"
        value={battleId}
        onChange={(event) => selectBattle(event.target.value)}
      >
        <option value="">Select a battle…</option>
        {encounterDefinitions.map((encounter) => (
          <option key={encounter.key} value={encounter.key}>
            [age {encounter.age}] {encounter.name}
          </option>
        ))}
      </select>
      {battle && (
        <>
          <p className="dev-tools-copy">
            Enemy:{" "}
            {battle.enemyArmy
              .map(
                ({ unitId, count }) =>
                  `${findUnitDefinition(unitId)?.name ?? unitId} ×${count}`,
              )
              .join(", ")}
          </p>
          {ownedArmy.size > 0 && (
            <p className="battle-simulator-current">
              Already bought:{" "}
              {[...ownedArmy.entries()]
                .map(
                  ([unitId, count]) =>
                    `${findUnitDefinition(unitId)?.name ?? unitId} ×${fmt(count)}`,
                )
                .join(", ")}
            </p>
          )}
          <div className="dev-tools-label">
            Additional units the solver may recommend (your current army is
            always included)
          </div>
          <div className="battle-simulator-units">
            {candidates.map((unit) => {
              const ownedCount = ownedArmy.get(unit.key);
              return (
                <div
                  key={unit.key}
                  className="battle-simulator-unit"
                  onClick={() => toggleUnit(unit.key)}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(unit.key)}
                    readOnly
                  />
                  <span>
                    {unit.name} <small>age {unit.age}</small>
                    {ownedCount && ownedCount.gt(ExpNumber.ZERO) && (
                      <small>· owned {fmt(ownedCount)}</small>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="battle-simulator-actions">
            <button
              type="button"
              className="dev-tools-toggle"
              disabled={running}
              onClick={run}
            >
              <span>{running ? "Simulating…" : "Find minimum army"}</span>
            </button>
            <button type="button" className="dev-tools-toggle" onClick={reset}>
              <span>Reset</span>
            </button>
          </div>
        </>
      )}
      {failed && (
        <p className="dev-tools-copy">No winning army with these units.</p>
      )}
      {result && (
        <div className="battle-simulator-result">
          <h4>
            {result.composition.size === 0
              ? `Your current army wins ${battle?.name}`
              : `Missing units for ${battle?.name}`}
          </h4>
          {result.composition.size > 0 ? (
            <>
              <p className="battle-simulator-subheading">Recruit these units</p>
              <ul>
                {[...result.composition].map(([unitId, count]) => (
                  <li key={unitId}>
                    {findUnitDefinition(unitId)?.name ?? unitId} ×{fmt(count)}
                  </li>
                ))}
              </ul>
              <p className="battle-simulator-subheading">
                Minimum winning army
              </p>
              <ul>
                {[...result.totalComposition].map(([unitId, count]) => (
                  <li key={unitId}>
                    {findUnitDefinition(unitId)?.name ?? unitId} ×{fmt(count)}
                  </li>
                ))}
              </ul>
              <p className="battle-simulator-subheading">
                Additional resource cost
              </p>
              <ul>
                {result.totalCost.map(({ resource, base }) => (
                  <li key={resource}>
                    {resource}: {fmt(base)}
                  </li>
                ))}
              </ul>
              {result.research.ids.length > 0 && (
                <>
                  <p className="battle-simulator-subheading">
                    Research needed for new unit types
                  </p>
                  <ul>
                    {result.research.ids.map((researchId) => (
                      <li key={researchId}>
                        {findResearchDefinition(researchId)?.name ?? researchId}
                      </li>
                    ))}
                  </ul>
                  {result.research.costs.map(({ resource, base }) => (
                    <p key={resource}>
                      Additional research cost ({resource}): {fmt(base)}
                    </p>
                  ))}
                </>
              )}
              <p>Additional military (optimized): {fmt(result.military)}</p>
              {result.formations.size > 0 && (
                <>
                  <p className="battle-simulator-subheading">
                    Recommended formations
                  </p>
                  <ul>
                    {[...result.formations].map(([unitId, formation]) => (
                      <li key={unitId}>
                        {findUnitDefinition(unitId)?.name ?? unitId}:{" "}
                        {findFormationDefinition(formation)?.name ?? formation}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {result.orders.size > 0 && (
                <>
                  <p className="battle-simulator-subheading">
                    Recommended targeting orders
                  </p>
                  <ul>
                    {[...result.orders].map(([unitId, order]) => (
                      <li key={unitId}>
                        {findUnitDefinition(unitId)?.name ?? unitId}:{" "}
                        {findOrderDefinition(order)?.name ?? order}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <p>
              No additional units needed. Your current army wins the simulation.
            </p>
          )}
        </div>
      )}
      {optimizedFormationsHalf && (
        <div className="battle-simulator-result">
          <h4>
            Optimized formations for{" "}
            {result && result.totalComposition.size > 0
              ? "½ of simulator's recommended army"
              : "½ of current army"}
          </h4>
          <p className="battle-simulator-subheading">
            Formation assignments (age{" "}
            {gameState.getCurrentAge()?.key.slice(-1)})
          </p>
          <ul>
            {Object.entries(optimizedFormationsHalf).map(
              ([unitId, formation]) => (
                <li key={unitId}>
                  {findUnitDefinition(unitId)?.name ?? unitId}:{" "}
                  {findFormationDefinition(formation)?.name ?? formation}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
      {optimizedFormations90 && (
        <div className="battle-simulator-result">
          <h4>
            Optimized formations for{" "}
            {result && result.totalComposition.size > 0
              ? "90% of simulator's recommended army"
              : "90% of current army"}
          </h4>
          <p className="battle-simulator-subheading">
            Formation assignments (age{" "}
            {gameState.getCurrentAge()?.key.slice(-1)})
          </p>
          <ul>
            {Object.entries(optimizedFormations90).map(
              ([unitId, formation]) => (
                <li key={unitId}>
                  {findUnitDefinition(unitId)?.name ?? unitId}:{" "}
                  {findFormationDefinition(formation)?.name ?? formation}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
