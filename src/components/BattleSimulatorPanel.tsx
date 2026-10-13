import { useMemo } from "react";
import type { CivilizationState } from "../game/civilizationState";
import {
  simulatorCandidates,
  type SimulatorOwnedArmy,
  type SimulatorResult,
} from "../game/battleSimulator";
import { encounterDefinitions } from "../game/encounters";
import { findUnitDefinition } from "../game/units";
import { findResearchDefinition } from "../game/research";
import { ExpNumber } from "../game/expNumber";
import { findFormationDefinition } from "../game/formations";
import { findOrderDefinition } from "../game/orders";

export type SimulatorPanelState = {
  battleId: string;
  selected: ReadonlySet<string>;
  running: boolean;
  /** Phase label emitted by the worker, e.g. "Optimising formations…" */
  phase: string;
  armyKey: string;
  result: SimulatorResult | null;
  /** true when the last completed run returned null (no winning army found) */
  failed: boolean;
};

export type SimulatorPanelActions = {
  selectBattle: (id: string) => void;
  toggleUnit: (unitId: string) => void;
  run: () => void;
  cancel: () => void;
  reset: () => void;
};

type Props = {
  gameState: CivilizationState;
  setGameState: (update: (current: CivilizationState) => CivilizationState) => void;
  fmt: (n: ExpNumber | number) => string;
  simState: SimulatorPanelState;
  simActions: SimulatorPanelActions;
};

export default function BattleSimulatorPanel({
  gameState,
  setGameState,
  fmt,
  simState,
  simActions,
}: Props) {
  const { battleId, selected, running, phase, result, failed } = simState;
  const { selectBattle, toggleUnit, run, cancel, reset } = simActions;

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

  return (
    <section className="dev-tools-panel" aria-label="Battle simulator">
      <div className="dev-tools-heading">
        <h3>Battle simulator</h3>
        <p className="dev-tools-copy">
          Starts with the army you already own, then finds the cheapest
          additional recruits that win. Unit stats use current and required
          research bonuses; recruit costs use your current discounts. The enemy
          uses prior-age and unlock research plus its encounter boosts. Runs in
          the background — you can keep playing while it works.
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
            {running && (
              <button
                type="button"
                className="dev-tools-toggle"
                onClick={cancel}
              >
                <span>Cancel</span>
              </button>
            )}
            <button type="button" className="dev-tools-toggle" onClick={reset}>
              <span>Reset</span>
            </button>
          </div>
          {running && phase && (
            <p className="battle-simulator-progress">{phase}</p>
          )}
        </>
      )}
      {failed && !running && (
        <p className="dev-tools-copy">No winning army with these units.</p>
      )}
      {result && (() => {
        const tacticsMatch =
          [...result.formations.entries()].every(
            ([unitId, form]) => gameState.getUnitFormation(unitId) === form,
          ) &&
          [...result.orders.entries()].every(
            ([unitId, ord]) => gameState.getUnitOrder(unitId) === ord,
          );
        return (
          <div className={`battle-simulator-result${running ? " result-preliminary" : ""}`}>
            <h4>
              {running && "⏳ "}
              {result.composition.size === 0
                ? tacticsMatch
                  ? `Your current army wins ${battle?.name}`
                  : `Your current army can win ${battle?.name}`
                : `Missing units for ${battle?.name}`}
              {running && " (preliminary)"}
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
                {result.totalCost.length > 0 && (
                  <>
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
                  </>
                )}
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
                {result.military.gt(ExpNumber.ZERO) && (
                  <p>Additional military (optimized): {fmt(result.military)}</p>
                )}
              </>
            ) : (
              <>
                <p>
                  No additional units needed.
                </p>
                {!tacticsMatch && (
                  <p className="battle-simulator-warning">
                    ⚠️ Your active formations/orders currently result in defeat or stalemate. Apply the recommended tactics below to win!
                  </p>
                )}
              </>
            )}
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
          {(result.formations.size > 0 || result.orders.size > 0) && (
            <div className="battle-simulator-apply">
              <button
                type="button"
                className="dev-tools-toggle"
                onClick={() =>
                  setGameState((current) =>
                    current.applyFormationSnapshot(
                      Object.fromEntries(result.orders),
                      Object.fromEntries(result.formations),
                    ),
                  )
                }
                title="Apply the simulator's recommended formations and targeting orders to your army"
              >
                Apply formation to army
              </button>
            </div>
          )}
          </div>
        );
      })()}
    </section>
  );
}
