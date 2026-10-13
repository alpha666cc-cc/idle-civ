import { useEffect, useRef, useState } from "react";
import { BookmarkCheck, BookmarkPlus, Lock, Swords, X } from "lucide-react";
import type { CivilizationState } from "../game/civilizationState";
import {
  armyPower,
  battleOrderHints,
  battleOrderLabels,
  type BattleOrder,
  type BattleSimulation,
  type StackSnapshot,
} from "../game/battle";
import { findFormationDefinition, type FormationId } from "../game/formations";
import { ExpNumber } from "../game/expNumber";
import {
  findUnitDefinition,
  unitStatKeys,
  unitStatLabels,
} from "../game/units";
import { unitIcon, unitTone } from "./unitIcons";

type Multiplier = number | "Max";

/** Units to buy at the current multiplier, clamped to affordability (≥ 1 so
 * the card always previews the price of the next unit and its failure reason). */
const purchaseQuantity = (
  multiplier: Multiplier,
  maxAffordable: number,
): number => {
  const wanted =
    multiplier === "Max" ? maxAffordable : Math.min(multiplier, maxAffordable);
  return Math.max(wanted, 1);
};

type Props = {
  gameState: CivilizationState;
  setGameState: (
    update: (current: CivilizationState) => CivilizationState,
  ) => void;
  multiplier: Multiplier;
  fmt: (n: ExpNumber | number) => string;
  onOpenGamepedia: (id: string) => void;
  activeBattle: {
    battleId: string;
    sim: BattleSimulation;
    startTime: number;
  } | null;
  setActiveBattle: React.Dispatch<
    React.SetStateAction<{
      battleId: string;
      sim: BattleSimulation;
      startTime: number;
    } | null>
  >;
  battleRoundIndex: number;
  setBattleRoundIndex: React.Dispatch<React.SetStateAction<number>>;
};

/** An army column entry: unit, name, and the count still standing. */
const ArmySide = ({
  snapshots,
  fmt,
  onOpenGamepedia,
}: {
  snapshots: readonly StackSnapshot[];
  fmt: (n: ExpNumber | number) => string;
  onOpenGamepedia: (id: string) => void;
}) => (
  <>
    {snapshots.map((snapshot) => {
      const unit = findUnitDefinition(snapshot.unitId);
      const tags = unit?.tags ?? [];
      const icon = unitIcon(snapshot.unitId, tags);
      const tone = unitTone(tags);
      return (
        <article key={snapshot.unitId} className="unit-card unit-card-battle">
          <div className="unit-card-head">
            <span className={`unit-icon ${tone}`}>
              {icon.kind === "vendored" ? (
                <span
                  className="unit-icon-svg"
                  style={{
                    WebkitMaskImage: `url(${icon.url})`,
                    maskImage: `url(${icon.url})`,
                  }}
                />
              ) : (
                <icon.Icon size={22} strokeWidth={1.8} />
              )}
            </span>
            <button
              type="button"
              className="unit-name"
              onClick={() => onOpenGamepedia(snapshot.unitId)}
            >
              {unit?.name ?? snapshot.unitId}
            </button>
            <span className="unit-count">×{fmt(snapshot.count)}</span>
          </div>
        </article>
      );
    })}
  </>
);

/**
 * The Army tab (Milestone 8): roster column (icon, #bought, next-buy cost,
 * effective stats) on the left, the next battle's enemy army on the right, the
 * battle button between them. Battles play back one round per second and are
 * resolved on the final round; owned units are never consumed (no deaths).
 */
export default function ArmyPanel({
  gameState,
  setGameState,
  multiplier,
  fmt,
  onOpenGamepedia,
  activeBattle,
  setActiveBattle,
  battleRoundIndex,
  setBattleRoundIndex,
}: Props) {
  const roundIndexRef = useRef(battleRoundIndex);
  const activeRef = useRef<{
    battleId: string;
    sim: BattleSimulation;
    startTime: number;
  } | null>(null);

  // Sync ref with props
  useEffect(() => {
    activeRef.current = activeBattle;
    roundIndexRef.current = battleRoundIndex;
  }, [activeBattle, battleRoundIndex]);

  /** Saved formation/order snapshot for the Save ↔ Reload toolbar. */
  const [savedSnapshot, setSavedSnapshot] = useState<{
    orders: Partial<Record<string, BattleOrder>>;
    formations: Partial<Record<string, FormationId>>;
  } | null>(null);

  const saveSnapshot = () => {
    setSavedSnapshot({
      orders: { ...gameState.unitOrders },
      formations: { ...gameState.unitFormations },
    });
  };

  const reloadSnapshot = () => {
    if (!savedSnapshot) return;
    setGameState((current) =>
      current.applyFormationSnapshot(savedSnapshot.orders, savedSnapshot.formations),
    );
  };

  const battle = gameState.getNextBattle();
  const roster = gameState.getRosterUnits();
  const sim =
    activeBattle !== null && battle?.key === activeBattle.battleId
      ? activeBattle.sim
      : null;

  const playerPower = gameState.getArmyPower();
  const enemyStacks = battle ? gameState.getEnemyStacks(battle.key) : [];
  const enemyPower = enemyStacks.length > 0 ? armyPower(enemyStacks) : null;

  const shown =
    sim !== null
      ? sim.rounds[Math.min(battleRoundIndex, sim.rounds.length - 1)]
      : null;
  const battleDone = sim !== null && battleRoundIndex >= sim.rounds.length;

  const startBattle = () => {
    if (!battle) return;
    if (sim !== null && !battleDone) return;
    if (sim !== null && sim.outcome === "player") return;
    const result = gameState.simulateEncounter(battle.key);
    if (!result) return;
    const debugFileName = `battle-debug-${battle.key}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const debugUrl = `${window.location.origin}/__battle-debug/${debugFileName}`;
    void fetch("/__battle-debug", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: debugFileName,
        text: JSON.stringify(result, null, 2),
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        console.log(
          `[battle debug] saved to saves/auto/battle/${debugFileName}`,
        );
        console.log(
          `%c[battle debug] open JSON: ${debugUrl}`,
          "color: #1683d8; text-decoration: underline;",
        );
      })
      .catch((error: unknown) => {
        console.error(
          "[battle debug] could not save JSON on the Vite server",
          error,
        );
      });
    console.groupCollapsed(`[battle debug] ${battle.key}: ${result.outcome}`);
    for (const round of result.rounds) {
      console.groupCollapsed(
        `Round ${round.round} · distance ${round.distance}`,
      );
      console.table(
        round.attacks.map((attack) => ({
          attacker: `${attack.attackerSide.toUpperCase()} · ${attack.attackerId}`,
          attackerPosition: attack.attackerPosition,
          reachable: attack.reachableTargets
            .map(
              (unitId) =>
                `${attack.reachableTargetSide.toUpperCase()} · ${unitId}`,
            )
            .join(", "),
          target: `${attack.targetSide.toUpperCase()} · ${attack.targetId}`,
          targetPosition: attack.targetPosition,
          damagedUnits: [
            ...(attack.targetDamage.gt(ExpNumber.fromNumber(0))
              ? [
                  {
                    side: attack.targetSide.toUpperCase(),
                    unit: attack.targetId,
                    countToAlive: `${attack.targetAliveBefore} → ${attack.targetAliveAfter}`,
                    damage: `${attack.targetDamage}`,
                  },
                ]
              : []),
            ...attack.screening.map((screen) => ({
              side: screen.side.toUpperCase(),
              unit: screen.unitId,
              countToAlive: `${screen.aliveBefore} → ${screen.aliveAfter}`,
              damage: `${screen.damage}`,
            })),
          ],
          intendedDamage: `${attack.intendedDamage}`,
        })),
      );
      console.groupEnd();
    }
    console.groupEnd();
    // oxlint-disable-next-line react/purity
    const startTime = Date.now();
    roundIndexRef.current = 0;
    setBattleRoundIndex(0);
    setActiveBattle({ battleId: battle.key, sim: result, startTime });
  };

  const cancelBattle = () => {
    setActiveBattle(null);
    setBattleRoundIndex(0);
    roundIndexRef.current = 0;
  };

  // One round per second; the win is recorded when the final round ends.
  // Uses time-based advancement to continue even when tab is inactive.
  useEffect(() => {
    if (activeRef.current === null || sim === null) return;
    if (roundIndexRef.current >= sim.rounds.length) return;

    const startTime = activeRef.current.startTime;

    const timer = window.setInterval(() => {
      const elapsedMs = Date.now() - startTime;
      const targetRound = Math.min(
        Math.floor(elapsedMs / 1000),
        sim.rounds.length,
      );

      if (targetRound > roundIndexRef.current) {
        roundIndexRef.current = targetRound;
        setBattleRoundIndex(targetRound);
        if (targetRound >= sim.rounds.length && sim.outcome === "player") {
          setGameState((current) =>
            current.resolveBattle(activeRef.current!.battleId, sim),
          );
        }
      }
    }, 100); // Check every 100ms to catch up if tab was inactive

    return () => window.clearInterval(timer);
  }, [sim, setGameState, setBattleRoundIndex]);

  return (
    <div className="army-layout">
      <section className="army-column" aria-label="Unit roster">
        <h3 className="army-column-title">Roster</h3>
        {roster.length > 0 && (
          <div className="formation-snapshot-bar">
            <button
              type="button"
              className="formation-snapshot-btn"
              onClick={saveSnapshot}
              title="Save current orders and formations as a preset"
            >
              <BookmarkPlus size={14} strokeWidth={1.8} />
              Save formation
            </button>
            <button
              type="button"
              className="formation-snapshot-btn"
              disabled={savedSnapshot === null}
              onClick={reloadSnapshot}
              title={
                savedSnapshot === null
                  ? "No formation saved yet"
                  : "Restore saved orders and formations"
              }
            >
              <BookmarkCheck size={14} strokeWidth={1.8} />
              Reload
            </button>
          </div>
        )}
        {roster.length === 0 && (
          <p className="army-empty">
            No units available yet — win the first battle to open recruiting.
          </p>
        )}
        {roster.map((unit) => {
          const maxAffordable = gameState.getMaxAffordableUnits(unit.key);
          const wanted = purchaseQuantity(multiplier, maxAffordable);
          const cost = gameState.getUnitCost(unit.key, wanted);
          const reason = gameState.getUnitFailureReason(unit.key, wanted);
          const icon = unitIcon(unit.key, unit.tags);
          const tone = unitTone(unit.tags);
          const currentAge = gameState.getCurrentAge();
          const ageIndex = currentAge
            ? parseInt(currentAge.key.slice(-1), 10)
            : 0;
          const formations = gameState.getAvailableFormations();
          const formation = gameState.getUnitFormation(unit.key);
          const orders = gameState.getAvailableOrders();
          const order = gameState.getUnitOrder(unit.key);
          return (
            <article key={unit.key} className="unit-card">
              <div className="unit-card-head">
                <span className={`unit-icon ${tone}`}>
                  {icon.kind === "vendored" ? (
                    <span
                      className="unit-icon-svg"
                      style={{
                        WebkitMaskImage: `url(${icon.url})`,
                        maskImage: `url(${icon.url})`,
                      }}
                    />
                  ) : (
                    <icon.Icon size={22} strokeWidth={1.8} />
                  )}
                </span>
                <button
                  type="button"
                  className="unit-name"
                  onClick={() => onOpenGamepedia(unit.key)}
                  aria-label={`Open ${unit.name} in the Gamepedia`}
                >
                  {unit.name}
                </button>
                <span className="unit-count" aria-label="Units owned">
                  ×{fmt(gameState.getUnitCount(unit.key))}
                </span>
              </div>

              {ageIndex >= 2 && formations.length > 1 && (
                <label className="unit-order">
                  <span className="unit-order-label">Formation</span>
                  <select
                    className="unit-order-select"
                    value={formation}
                    onChange={(event) =>
                      setGameState((current) =>
                        current.setUnitFormation(
                          unit.key,
                          event.target.value as FormationId,
                        ),
                      )
                    }
                    aria-label={`Formation for ${unit.name}`}
                  >
                    {formations.map((option) => {
                      const def = findFormationDefinition(option);
                      return (
                        <option key={option} value={option}>
                          {def?.name ?? option}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}

              {ageIndex >= 3 && orders.length > 1 && (
                <label className="unit-order">
                  <span className="unit-order-label">Targeting</span>
                  <select
                    className="unit-order-select"
                    value={order}
                    onChange={(event) =>
                      setGameState((current) =>
                        current.setUnitOrder(
                          unit.key,
                          event.target.value as BattleOrder,
                        ),
                      )
                    }
                    aria-label={`Targeting order for ${unit.name}`}
                    title={battleOrderHints[order]}
                  >
                    {orders.map((option) => (
                      <option key={option} value={option}>
                        {battleOrderLabels[option]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className="unit-buy"
                disabled={reason !== null}
                onClick={() =>
                  setGameState((current) => current.buyUnit(unit.key, wanted))
                }
              >
                {reason === "locked" ? (
                  <>
                    <Lock size={13} strokeWidth={1.8} /> Locked
                  </>
                ) : (
                  `Recruit ${wanted > 1 ? `${wanted} ` : ""}· ${cost
                    .map(({ resource, base }) => `${fmt(base)} ${resource}`)
                    .join(", ")}`
                )}
              </button>
              {gameState.getUnitStats(unit.key) && (
                <dl className="unit-stats">
                  {unitStatKeys.map((key) => {
                    const stats = gameState.getUnitStats(unit.key)!;
                    return (
                      <div key={key} className="unit-stat">
                        <dt>{unitStatLabels[key]}</dt>
                        <dd>
                          {key === "armor"
                            ? `${Math.round(stats.armor * 100)}%`
                            : fmt(stats[key])}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </article>
          );
        })}
        {sim !== null && shown !== null && (
          <div className="army-in-battle">
            <h4 className="army-in-battle-title">In battle</h4>
            <ArmySide
              snapshots={shown.player}
              fmt={fmt}
              onOpenGamepedia={onOpenGamepedia}
            />
          </div>
        )}
      </section>

      <div className="army-center">
        <div className="army-power">
          <span>Your army</span>
          <strong className="tone-green">{fmt(playerPower)}</strong>
        </div>
        <div className="battle-actions">
          <button
            type="button"
            className="battle-button"
            disabled={
              !battle ||
              (sim !== null && (!battleDone || sim.outcome === "player"))
            }
            onClick={startBattle}
          >
            <Swords size={20} strokeWidth={1.8} />
            {sim === null
              ? battle
                ? `To battle: ${battle.name}`
                : "Campaign complete"
              : battleDone
                ? sim.outcome === "player"
                  ? "Victory!"
                  : sim.outcome === "enemy"
                    ? "Defeat — try again"
                    : "Stalemate — try again"
                : `Round ${battleRoundIndex + 1} / ${sim.rounds.length}`}
          </button>
          {sim !== null && !battleDone && (
            <button
              type="button"
              className="battle-cancel-button"
              onClick={cancelBattle}
              title="Cancel battle"
            >
              <X size={16} strokeWidth={1.8} />
              Cancel
            </button>
          )}
        </div>
        <div className="army-power">
          <span>Enemy army</span>
          <strong className="tone-red">
            {enemyPower === null ? "—" : fmt(enemyPower)}
          </strong>
        </div>
      </div>

      <section className="army-column" aria-label="Enemy army">
        <h3 className="army-column-title">
          {battle ? battle.name : "No battle"}
        </h3>
        {battle && (
          <button
            type="button"
            className="battle-info"
            onClick={() => onOpenGamepedia(battle.key)}
          >
            {battle.isBoss ? "Age boss" : "Skirmish"} · year {battle.year} ·{" "}
            {battle.enemyUnitCount} enemies — details
          </button>
        )}
        {shown ? (
          <ArmySide
            snapshots={shown.enemy}
            fmt={fmt}
            onOpenGamepedia={onOpenGamepedia}
          />
        ) : (
          <ArmySide
            snapshots={enemyStacks.map((stack) => ({
              unitId: stack.unitId,
              side: "enemy",
              count: stack.count,
              hpPool: stack.count,
              position: 20,
            }))}
            fmt={fmt}
            onOpenGamepedia={onOpenGamepedia}
          />
        )}
        {!battle && <p className="army-empty">Every battle has been won.</p>}
      </section>
    </div>
  );
}
