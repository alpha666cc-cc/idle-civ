import { useEffect, useMemo, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { Castle, Check, FlaskConical, Lock } from "lucide-react";
import type { CivilizationState } from "../game/civilizationState";
import { ageDefinitions } from "../game/ages";
import {
  buildingDefinitions,
  type BuildingKey,
} from "../game/buildings";
import { researchDefinitions, type ResearchDefinition } from "../game/research";
import { unitDefinitions } from "../game/units";
import { ExpNumber } from "../game/expNumber";
import type { Bonus } from "../game/bonus";

type Props = {
  gameState: CivilizationState;
  setGameState: (
    update: (current: CivilizationState) => CivilizationState,
  ) => void;
  fmt: (value: ExpNumber | number) => string;
  onOpenGamepedia: (id: string) => void;
};

// Layout geometry (px). Fixed sizes keep the SVG arrow overlay computable
// without measuring the DOM.
const CARD_W = 236;
const CARD_H = 96;
const COL_GAP = 56;
const COL_W = CARD_W + COL_GAP;
const ROW_H = CARD_H + 16;
const BAR_H = 46;

const COLS = 2; // civilian | military

type PlacedTech = {
  research: ResearchDefinition;
  col: number;
  row: number;
};

type AgeBar = { ageIndex: number; y: number };

type Layout = {
  placed: PlacedTech[];
  bars: AgeBar[];
  edges: { path: string; key: string }[];
  height: number;
};

/** Stable per-tech prerequisite depth, so parents always sit above children. */
const depthOf = (() => {
  const depths = new Map<string, number>();
  const byKey = new Map(researchDefinitions.map((r) => [r.key, r]));
  const visit = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const research = byKey.get(id);
    const value =
      research && research.prerequisites.length > 0
        ? 1 + Math.max(...research.prerequisites.map(visit))
        : 0;
    depths.set(id, value);
    return value;
  };
  researchDefinitions.forEach((research) => visit(research.key));
  return depths;
})();

const buildLayout = (): Layout => {
  const placed: PlacedTech[] = [];
  const rowByKey = new Map<string, number>();
  const occupied = new Set<string>();
  let nextRow = 0;
  let lastAge = -1;

  // Ages in order; within an age, prerequisite depth first keeps parents above
  // children, so every arrow points right, down or down-left.
  const techs = [...researchDefinitions].sort(
    (a, b) =>
      a.age - b.age || (depthOf.get(a.key) ?? 0) - (depthOf.get(b.key) ?? 0),
  );

  for (const research of techs) {
    if (research.age !== lastAge) {
      lastAge = research.age;
      nextRow += 1; // the age bar consumes one row slot before its techs
    }
    const col = research.category === "military" ? 1 : 0;
    let row = nextRow;
    for (const prerequisite of research.prerequisites) {
      const parentRow = rowByKey.get(prerequisite);
      if (parentRow !== undefined) row = Math.max(row, parentRow + 1);
    }
    while (occupied.has(`${col}:${row}`)) row += 1;
    occupied.add(`${col}:${row}`);
    nextRow = Math.max(nextRow, row + 1);
    rowByKey.set(research.key, row);
    placed.push({ research, col, row });
  }

  const barRows = new Map<number, number>();
  for (const { research, row } of placed) {
    const current = barRows.get(research.age);
    if (current === undefined || row < current) barRows.set(research.age, row);
  }
  const bars: AgeBar[] = [...barRows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ageIndex, row]) => ({
      ageIndex,
      y: Math.max(0, row * ROW_H - BAR_H),
    }));

  const edges = placed.flatMap(({ research, col, row }) =>
    research.prerequisites.map((prerequisiteId) => {
      const parent = placed.find(
        (candidate) => candidate.research.key === prerequisiteId,
      );
      const key = `${prerequisiteId}->${research.key}`;
      if (!parent) return { path: "", key };
      const x1 = parent.col * COL_W + CARD_W / 2;
      const y1 = parent.row * ROW_H + CARD_H;
      const x2 = col * COL_W + CARD_W / 2;
      const y2 = row * ROW_H;
      const path =
        parent.col === col
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} L ${x1} ${y2 - 12} L ${x2} ${y2 - 12} L ${x2} ${y2}`;
      return { path, key };
    }),
  );

  return {
    placed,
    bars,
    edges,
    height: Math.max(...placed.map(({ row }) => row)) * ROW_H + CARD_H + BAR_H,
  };
};

const buildingNames = new Map(
  buildingDefinitions.map((building) => [building.key, building.name]),
);
const unitNames = new Map(unitDefinitions.map((unit) => [unit.id, unit.name]));

/** Unit-stat bonus destinations in player words. */
const unitStatLabels: Record<string, string> = {
  "tag.infantry.hp": "infantry health",
  "tag.ranged.attack": "ranged attack",
  "tag.armored.attack": "cavalry attack",
  "tag.armored.speed": "cavalry speed",
  "tag.naval.attack": "ship attack",
  "tag.naval.hp": "ship hulls",
  "unitAll.hp": "all unit health",
  "unitAll.attack": "all unit attack",
};

const destinationLabel = (destination: string): string => {
  if (destination === "all-production") return "all production";
  const named =
    buildingNames.get(destination as BuildingKey) ??
    unitNames.get(destination);
  return named ?? destination;
};

const describeBonus = (bonus: Bonus): string => {
  const destination = String(bonus.destination);
  const stat = unitStatLabels[destination];
  const value = bonus.value.toNumber();
  if (stat) {
    return bonus.type === "attributeMultiplier"
      ? `×${value} ${stat}`
      : `+${value} ${stat}`;
  }
  const label = destinationLabel(destination);
  switch (bonus.type) {
    case "attributeMultiplier":
      return `×${value} ${label}`;
    case "attributeFlat":
      return `+${value} ${label}`;
    case "costReductionPercent":
      return `${Math.round(value * 100)}% cheaper ${label}`;
    case "costReductionFactor":
      return `${label} cost scaling −${value}`;
    case "costReductionBase":
      return `${label} base cost ÷${Math.round(1 / Math.max(value, 1e-9))}`;
    case "costReductionFlat":
      return `${label} cost −${value}`;
    case "attributeDrain":
      return `${label} upkeep −${value}/s`;
    default:
      return `${bonus.type} ${label}`;
  }
};

/** One research card: icon, name, effects, cost, buy button. */
const ResearchCard = ({
  research,
  gameState,
  setGameState,
  fmt,
  onOpenGamepedia,
}: {
  research: ResearchDefinition;
  gameState: CivilizationState;
  setGameState: Props["setGameState"];
  fmt: Props["fmt"];
  onOpenGamepedia: Props["onOpenGamepedia"];
}) => {
  const bought = gameState.isResearchBought(research.key);
  const unlocked = gameState.isResearchUnlocked(research.key);
  const affordable = gameState.hasResourcesForResearch(research.key);
  const cost = gameState.getResearchCost(research.key)[0];
  const state = bought
    ? "bought"
    : unlocked
      ? affordable
        ? "ready"
        : "expensive"
      : "locked";
  const effects = research.bonuses.map(describeBonus);
  const Icon: LucideIcon =
    research.category === "military" ? Castle : FlaskConical;

  return (
    <div className={`research-card research-card-${state}`}>
      <div className="research-card-title">
        <Icon size={16} strokeWidth={1.7} aria-hidden />
        <button
          type="button"
          className="research-card-name"
          onClick={() => onOpenGamepedia(research.key)}
        >
          {research.name}
        </button>
        {bought && <Check size={14} strokeWidth={2} aria-hidden />}
        {!bought && !unlocked && <Lock size={14} strokeWidth={1.7} aria-hidden />}
      </div>
      <ul className="research-card-effects">
        {effects.slice(0, 2).map((effect, index) => (
          <li key={index}>{effect}</li>
        ))}
        {effects.length > 2 && <li>+{effects.length - 2} more</li>}
        {effects.length === 0 && <li className="muted">No engine effect yet</li>}
      </ul>
      <div className="research-card-footer">
        <span className="research-card-cost">
          {fmt(cost ? cost.base : ExpNumber.ZERO)}
        </span>
        <button
          type="button"
          className={`research-buy research-buy-${state}`}
          aria-label={
            bought
              ? `${research.name} researched`
              : unlocked
                ? `Research ${research.name}`
                : `${research.name} is locked`
          }
          disabled={bought || !unlocked}
          onClick={() =>
            setGameState((current) => current.buyResearch(research.key))
          }
        >
          {bought ? "Done" : unlocked ? "Research" : "Locked"}
        </button>
      </div>
    </div>
  );
};
export default function ResearchPanel({
  gameState,
  setGameState,
  fmt,
  onOpenGamepedia,
}: Props) {
  const layout = useMemo(buildLayout, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const boughtCount = gameState.boughtResearch.length;

  // Default scroll: the highest row holding an unresearched tech sits on the
  // second visible row from the top. Re-runs when the bought set changes.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const firstUnbought = layout.placed
      .filter(({ research }) => !gameState.isResearchBought(research.key))
      .sort((a, b) => a.row - b.row)[0];
    container.scrollTop = firstUnbought
      ? Math.max(0, firstUnbought.row * ROW_H - ROW_H)
      : 0;
    // The bought count is the trigger; layout is stable and gameState is read
    // through the engine methods.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, boughtCount]);

  const ageName = (ageIndex: number): string =>
    ageDefinitions.find(({ key }) => key === `age-${ageIndex}`)?.name ??
    `Age ${ageIndex}`;

  return (
    <section className="research-panel" aria-label="Research tree">
      <div className="research-heading">
        <div>
          <p className="eyebrow">Science</p>
          <h3>Technology tree</h3>
        </div>
        <p className="research-progress">
          {gameState.boughtResearch.length} / {researchDefinitions.length}{" "}
          researched
        </p>
      </div>
      <div className="research-scroll" ref={scrollRef}>
        <div
          className="research-tree"
          style={{ width: COLS * COL_W, height: layout.height }}
        >
          <svg
            className="research-edges"
            width={COLS * COL_W}
            height={layout.height}
            aria-hidden
          >
            <defs>
              <marker
                id="research-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="research-arrow-head" />
              </marker>
            </defs>
            {layout.edges.map(
              (edge) =>
                edge.path && (
                  <path
                    key={edge.key}
                    d={edge.path}
                    className="research-edge"
                    markerEnd="url(#research-arrow)"
                  />
                ),
            )}
          </svg>
          {layout.bars.map((bar) => (
            <div
              key={`bar-${bar.ageIndex}`}
              className={`research-age-bar research-age-${bar.ageIndex}`}
              style={{ top: bar.y, height: BAR_H }}
            >
              <span>{ageName(bar.ageIndex)}</span>
            </div>
          ))}
          {layout.placed.map(({ research, col, row }) => (
            <div
              key={research.key}
              className="research-slot"
              style={{
                left: col * COL_W,
                top: row * ROW_H,
                width: CARD_W,
                height: CARD_H,
              }}
            >
              <ResearchCard
                research={research}
                gameState={gameState}
                setGameState={setGameState}
                fmt={fmt}
                onOpenGamepedia={onOpenGamepedia}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}


