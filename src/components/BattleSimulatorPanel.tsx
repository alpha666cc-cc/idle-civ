import { useMemo, useState } from "react";
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
import type { ResourceKey } from "../game/attributes";
import { findFormationDefinition } from "../game/formations";
import { findOrderDefinition } from "../game/orders";

const formationEffectSummary = (formationId: string): string => {
  const formation = findFormationDefinition(formationId);
  if (!formation) return "";
  const effects: string[] = [];
  const statNames: Record<string, string> = {
    "unitAll.hp": "HP",
    "unitAll.attack": "attack",
    "unitAll.accuracy": "accuracy",
  };
  for (const bonus of formation.statBonuses ?? []) {
    const change = Math.round(Math.abs(bonus.multiplier - 1) * 100);
    if (change === 0) continue;
    const sign = bonus.multiplier > 1 ? "+" : "-";
    effects.push(`${sign}${change}% ${statNames[bonus.attribute] ?? bonus.attribute}`);
  }
  for (const rule of formation.damageTakenVs ?? []) {
    const change = Math.round(Math.abs(rule.multiplier - 1) * 100);
    if (change === 0) continue;
    effects.push(
      rule.multiplier < 1
        ? `${change}% less damage from ${rule.tag}`
        : `+${change}% damage from ${rule.tag}`,
    );
  }
  if (formation.movementSpeed !== 1) {
    effects.push(`${formation.movementSpeed}× movement speed`);
  }
  return effects.join(", ");
};

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
  error: string;
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
  const { battleId, selected, running, phase, result, failed, error } = simState;
  const { selectBattle, toggleUnit, run, cancel, reset } = simActions;
  const [selectedPlanSelection, setSelectedPlanSelection] = useState({
    key: "",
    index: 0,
  });
  const planSelectionKey = `${battleId}|${simState.armyKey}`;
  const selectedPlanIndex =
    selectedPlanSelection.key === planSelectionKey
      ? selectedPlanSelection.index
      : 0;

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
          Shows the first winning setup as soon as it is found, then exhaustively
          checks lower-military-cost armies and available tactics to prove the
          cheapest winning plan for the selected units. Unit stats use current
          and required research bonuses; recruit costs use your current
          discounts. The enemy uses prior-age and unlock research plus its
          encounter boosts. Runs in the background — you can keep playing while
          it works.
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
              <span>
                {running ? "Searching…" : "Find proven winning plan"}
              </span>
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
          {error && <p className="battle-simulator-warning">{error}</p>}
        </>
      )}
      {failed && !running && (
        <p className="dev-tools-copy">No winning army with these units.</p>
      )}
      {result && (() => {
        const plans = [result, ...(result.alternatives ?? [])];
        const safePlanIndex = Math.min(selectedPlanIndex, plans.length - 1);
        const plan = plans[safePlanIndex] ?? result;
        const planCosts = new Map<ResourceKey, ExpNumber>();
        for (const { resource, base } of [
          ...plan.totalCost,
          ...plan.research.costs,
        ]) {
          planCosts.set(
            resource,
            (planCosts.get(resource) ?? ExpNumber.ZERO).add(base),
          );
        }
        const tacticsMatch =
          [...plan.formations.entries()].every(
            ([unitId, form]) => gameState.getUnitFormation(unitId) === form,
          ) &&
          [...plan.orders.entries()].every(
            ([unitId, ord]) => gameState.getUnitOrder(unitId) === ord,
          );
        return (
          <div className={`battle-simulator-result${running ? " result-preliminary" : ""}`}>
            {plans.length > 1 && (
              <>
                <label
                  className="dev-tools-label"
                  htmlFor="battle-simulator-plan"
                >
                  Winning plans found
                </label>
                <select
                  id="battle-simulator-plan"
                  className="dev-tools-select"
                  value={safePlanIndex}
                  onChange={(event) => {
                    setSelectedPlanSelection({
                      key: planSelectionKey,
                      index: Number(event.target.value),
                    });
                  }}
                >
                  {plans.map((candidate, index) => {
                    const costs = new Map<ResourceKey, ExpNumber>();
                    for (const { resource, base } of [
                      ...candidate.totalCost,
                      ...candidate.research.costs,
                    ]) {
                      costs.set(
                        resource,
                        (costs.get(resource) ?? ExpNumber.ZERO).add(base),
                      );
                    }
                    const costSummary = [...costs]
                      .map(([resource, cost]) => `${resource} ${fmt(cost)}`)
                      .join(" · ");
                    return (
                      <option key={index} value={index}>
                        Plan {index + 1} · {costSummary || "no recruit cost"}
                      </option>
                    );
                  })}
                </select>
              </>
            )}
            <h4>
              {result.searchStats?.proofStatus === "proven"
                ? `Proven lowest-military-cost winner for ${battle?.name}`
                : result.searchStats?.proofStatus === "cancelled"
                  ? `Winning setup for ${battle?.name} (search stopped; not proven)`
                  : result.searchStats?.proofStatus === "failed"
                    ? `Winning setup for ${battle?.name} (proof failed)`
                    : `Winning setup for ${battle?.name} (best so far)`}
            </h4>
            {result.searchStats && (
              <p className="dev-tools-copy">
                {result.searchStats.proofStatus === "proven"
                  ? `Proof complete: checked ${result.searchStats.armyCompositionsTested ?? 0} army compositions and ${result.searchStats.tacticalSetupsTested ?? 0} formation/order setups. This is the lowest military-cost winner for the selected unit roster and available tactics.`
                  : result.searchStats.proofStatus === "cancelled"
                    ? `Search stopped after checking ${result.searchStats.armyCompositionsTested ?? 0} army compositions and ${result.searchStats.tacticalSetupsTested ?? 0} formation/order setups. This is the best plan found so far, not a proven optimum.`
                    : result.searchStats.proofStatus === "failed"
                      ? "The current plan is a verified win, but the search could not certify it as the lowest-cost option."
                      : `Exhaustive proof in progress: checked ${result.searchStats.armyCompositionsTested ?? 0} army compositions and ${result.searchStats.tacticalSetupsTested ?? 0} formation/order setups. The displayed winning plan may improve.`}
              </p>
            )}
            {plan.composition.size > 0 ? (
              <>
                <p className="battle-simulator-subheading">Recruit these units</p>
                <ul>
                  {[...plan.composition].map(([unitId, count]) => (
                    <li key={unitId}>
                      {findUnitDefinition(unitId)?.name ?? unitId} ×{fmt(count)}
                    </li>
                  ))}
                </ul>
                <p className="battle-simulator-subheading">
                  Winning army configuration
                </p>
                <ul>
                  {[...plan.totalComposition].map(([unitId, count]) => (
                    <li key={unitId}>
                      {findUnitDefinition(unitId)?.name ?? unitId} ×{fmt(count)}
                    </li>
                  ))}
                </ul>
                {planCosts.size > 0 && (
                  <>
                    <p className="battle-simulator-subheading">
                      Total required resources (recruits + research)
                    </p>
                    <ul>
                      {[...planCosts.entries()].map(([resource, cost]) => {
                        const stock = gameState.getAttributeValue(resource);
                        const shortfall = ExpNumber.max(
                          ExpNumber.ZERO,
                          cost.sub(stock),
                        );
                        const rate = gameState.computeResourceRate(resource);
                        const wait =
                          shortfall.isZero
                            ? "available from current stock"
                            : rate.gt(ExpNumber.ZERO)
                              ? `${fmt(shortfall.div(rate))}s at current net production`
                              : "no positive net production";
                        return (
                          <li key={resource}>
                            {resource}: {fmt(cost)} · stock {fmt(stock)} ·{" "}
                            {fmt(rate)}/s · {wait}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
                {plan.research.ids.length > 0 && (
                  <>
                    <p className="battle-simulator-subheading">
                      Research needed for new unit types
                    </p>
                    <ul>
                      {plan.research.ids.map((researchId) => (
                        <li key={researchId}>
                          {findResearchDefinition(researchId)?.name ?? researchId}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {plan.military.gt(ExpNumber.ZERO) && (
                  <p>Additional military: {fmt(plan.military)}</p>
                )}
              </>
            ) : (
              <>
                <p>No additional units are required with these tactics.</p>
                {!tacticsMatch && (
                  <p className="battle-simulator-warning">
                    Apply these tactics to use the verified winning setup.
                  </p>
                )}
              </>
            )}
          {plan.formations.size > 0 && (
            <>
              <p className="battle-simulator-subheading">
                Formation setup for this plan
              </p>
              <p className="dev-tools-copy">
                Every listed setup is checked as a win with these exact units,
                formations, and orders. Military cost is the optimization
                objective; other resource costs are shown for planning.
              </p>
              <ul>
                {[...plan.formations].map(([unitId, formation]) => {
                  const effects = formationEffectSummary(formation);
                  return (
                    <li key={unitId}>
                      {findUnitDefinition(unitId)?.name ?? unitId}:{" "}
                      {findFormationDefinition(formation)?.name ?? formation}
                      {effects && <small> — {effects}</small>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {plan.orders.size > 0 && (
            <>
              <p className="battle-simulator-subheading">
                Recommended targeting orders
              </p>
              <ul>
                {[...plan.orders].map(([unitId, order]) => (
                  <li key={unitId}>
                    {findUnitDefinition(unitId)?.name ?? unitId}:{" "}
                    {findOrderDefinition(order)?.name ?? order}
                  </li>
                ))}
              </ul>
            </>
          )}
          {(plan.formations.size > 0 || plan.orders.size > 0) && (
            <div className="battle-simulator-apply">
              <button
                type="button"
                className="dev-tools-toggle"
                onClick={() =>
                  setGameState((current) =>
                    current.applyFormationSnapshot(
                      Object.fromEntries(plan.orders),
                      Object.fromEntries(plan.formations),
                    ),
                  )
                }
                title="Apply the selected plan's formations and targeting orders to your army"
              >
                Apply selected tactics
              </button>
            </div>
          )}
          </div>
        );
      })()}
    </section>
  );
}
