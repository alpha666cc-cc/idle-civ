import { useMemo, useState } from "react";
import type { CivilizationState } from "../game/civilizationState";
import {
  simulatorCandidates,
  solveMinimumArmy,
  type SimulatorArmy,
  type SimulatorResult,
} from "../game/battleSimulator";
import { encounterDefinitions } from "../game/encounters";
import { findUnitDefinition } from "../game/units";
import { researchIdsForBattle } from "../game/research";
import type { BuildingCost } from "../game/buildings";
import { ExpNumber } from "../game/expNumber";

/** Cost of `count` units from scratch through the engine's series evaluator. */
const costFromScratch = (
  gameState: CivilizationState,
  unitId: string,
  count: number,
): BuildingCost[] => {
  const unit = findUnitDefinition(unitId);
  if (!unit) return [];
  const parameters = gameState.getUnitCostParameters(unitId);
  return gameState.costSeriesFrom(parameters, count);
};

/** Whether a composition defeats the battle using engine stats + sim. */
const winsWithStats = (
  gameState: CivilizationState,
  battleId: string,
  composition: SimulatorArmy,
): boolean => {
  const researchIds = researchIdsForBattle(
    encounterDefinitions.find(({ key }) => key === battleId)?.age ?? 0,
    [...composition.keys()],
  );
  const stacks = [...composition.entries()]
    .filter(([, count]) => count > 0)
    .map(([unitId, count]) => ({
      unitId,
      count: ExpNumber.fromNumber(count),
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
  const sim = gameState.simulateWithStacks(battleId, stacks, enemy);
  return sim.outcome === "player";
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
  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [failed, setFailed] = useState(false);

  const battle = encounterDefinitions.find(({ key }) => key === battleId);
  const candidates = useMemo(
    () => (battle ? simulatorCandidates(battle.age) : []),
    [battle],
  );

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
    setResult(null);
    setFailed(false);
  };

  const toggleUnit = (unitId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
    setResult(null);
    setFailed(false);
  };

  const reset = (): void => {
    setBattleId("");
    setSelected(new Set());
    setResult(null);
    setFailed(false);
  };

  const run = (): void => {
    if (!battle || selected.size === 0 || running) return;
    setRunning(true);
    setFailed(false);
    // Let the button paint before the synchronous search blocks the thread.
    window.setTimeout(() => {
      const units = candidates.filter((unit) => selected.has(unit.key));
      const outcome = solveMinimumArmy(battle.key, units, {
        getCost: (unitId, count) => costFromScratch(gameState, unitId, count),
        wins: (composition) =>
          winsWithStats(gameState, battle.key, composition),
      });
      setResult(outcome);
      setFailed(outcome === null);
      setRunning(false);
    }, 30);
  };

  return (
    <section className="dev-tools-panel" aria-label="Battle simulator">
      <div className="dev-tools-heading">
        <h3>Battle simulator</h3>
        <p className="dev-tools-copy">
          Minimum-military-cost winning army for one battle. Player units use
          current and required research bonuses with your cost reductions; the
          enemy uses prior-age and unlock research plus its encounter boosts.
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
              .map((stack) => `${stack.unitId} ×${stack.count}`)
              .join(", ")}
          </p>
          <div className="dev-tools-label">
            Units (unlocked selected by default; added units receive required
            research)
          </div>
          <div className="battle-simulator-units">
            {candidates.map((unit) => (
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
                </span>
              </div>
            ))}
          </div>
          <div className="battle-simulator-actions">
            <button
              type="button"
              className="dev-tools-toggle"
              disabled={selected.size === 0 || running}
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
          <h4>Minimum army for {battle?.name}</h4>
          <ul>
            {[...result.composition].map(([unitId, count]) => (
              <li key={unitId}>
                {findUnitDefinition(unitId)?.name ?? unitId} ×{count}
              </li>
            ))}
          </ul>
          <ul>
            {result.totalCost.map(({ resource, base }) => (
              <li key={resource}>
                {resource}: {fmt(base)}
              </li>
            ))}
          </ul>
          <p>Military (optimized): {fmt(result.military)}</p>
        </div>
      )}
    </section>
  );
}
