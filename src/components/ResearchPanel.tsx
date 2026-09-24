import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Castle, Check, FlaskConical, Lock } from "lucide-react";
import type { CivilizationState } from "../game/civilizationState";
import { ageDefinitions } from "../game/ages";
import { buildingDefinitions, type BuildingKey } from "../game/buildings";
import { researchDefinitions, type ResearchDefinition } from "../game/research";
import { unitDefinitions } from "../game/units";
import { ExpNumber } from "../game/expNumber";
import type { Bonus } from "../game/bonus";
import {
  AGE_CARD_ROWS,
  AGE_HEADER_H,
  AGE_INSET,
  CARD_H,
  CARD_W,
  COL_GAP,
  COL_W,
  ROW_H,
  routeTechEdge,
} from "../game/researchLayout";
import researchLayout from "../game/data/researchLayout.json";

type Props = {
  gameState: CivilizationState;
  setGameState: (
    update: (current: CivilizationState) => CivilizationState,
  ) => void;
  fmt: (value: ExpNumber | number) => string;
  onOpenGamepedia: (id: string) => void;
};

// Card geometry and arrow routing live in the domain layer (researchLayout.ts)
// so the SVG arrow overlay stays computable without measuring the DOM.
const AGE_GAP_COLS = 0;

type PlacedTech = {
  research: ResearchDefinition;
  col: number;
  row: number;
};

type AgeBar = { ageIndex: number; x: number; width: number; height: number };

type Layout = {
  placed: PlacedTech[];
  bars: AgeBar[];
  edges: { path: string; key: string; crossAge: boolean }[];
  width: number;
  height: number;
};

type LayoutOverride = { key: string; column: number; row: number };
type LayoutPosition = Omit<LayoutOverride, "key">;
type LayoutSource = LayoutOverride[] | Record<string, LayoutPosition>;

const normalizeLayout = (source: LayoutSource): LayoutOverride[] =>
  Array.isArray(source)
    ? source
    : Object.entries(source).map(([key, position]) => ({ key, ...position }));

const layoutOverrides = new Map(
  normalizeLayout(researchLayout).map((entry) => [entry.key, entry]),
);

const buildLayout = (): Layout => {
  const placed: PlacedTech[] = [];
  const ageCounts = new Map<number, number>();
  const byKey = new Map(
    researchDefinitions.map((research) => [research.key, research]),
  );
  const hasCompleteFixedLayout = researchDefinitions.every((research) =>
    layoutOverrides.has(research.key),
  );
  const localDepth = new Map<string, number>();

  const getLocalDepth = (research: ResearchDefinition): number => {
    const cached = localDepth.get(research.key);
    if (cached !== undefined) return cached;
    const override = layoutOverrides.get(research.key)?.column;
    if (override !== undefined) {
      localDepth.set(research.key, override);
      return override;
    }
    const depth = research.prerequisites.reduce(
      (maximum, prerequisiteId) => {
        const prerequisite = byKey.get(prerequisiteId);
        if (!prerequisite || prerequisite.age !== research.age) return maximum;
        return Math.max(maximum, getLocalDepth(prerequisite) + 1);
      },
      layoutOverrides.get(research.key)?.column ?? 0,
    );
    localDepth.set(research.key, depth);
    return depth;
  };

  // Depth is horizontal: prerequisites always sit to the left of their children.
  const techs = [...researchDefinitions].sort(
    (a, b) => a.age - b.age || getLocalDepth(a) - getLocalDepth(b),
  );

  for (const research of techs) {
    ageCounts.set(research.age, (ageCounts.get(research.age) ?? 0) + 1);
  }

  const ageOffsets = new Map<number, number>();
  let nextColumn = 0;
  let bars: AgeBar[] = [];
  if (hasCompleteFixedLayout) {
    for (const research of researchDefinitions) {
      const position = layoutOverrides.get(research.key)!;
      placed.push({ research, col: position.column, row: position.row });
    }
    for (const ageIndex of [...ageCounts.keys()].sort((a, b) => a - b)) {
      const agePlacements = placed.filter(
        ({ research }) => research.age === ageIndex,
      );
      const minimum = Math.min(...agePlacements.map(({ col }) => col));
      const maximum = Math.max(...agePlacements.map(({ col }) => col));
      bars.push({
        ageIndex,
        x: minimum * COL_W,
        width: (maximum - minimum + 1) * COL_W - COL_GAP + AGE_INSET * 2,
        height: AGE_HEADER_H + AGE_CARD_ROWS * ROW_H,
      });
    }
  } else
    for (const ageIndex of [...ageCounts.keys()].sort((a, b) => a - b)) {
      const ageTechs = techs.filter((research) => research.age === ageIndex);
      const levels = new Map<number, number>();
      for (const research of ageTechs) {
        levels.set(
          getLocalDepth(research),
          (levels.get(getLocalDepth(research)) ?? 0) + 1,
        );
      }
      const columnCount =
        Math.max(
          0,
          ...[...levels.entries()].map(
            ([level, count]) => level + Math.ceil(count / AGE_CARD_ROWS) - 1,
          ),
        ) + 1;
      ageOffsets.set(ageIndex, nextColumn);
      bars.push({
        ageIndex,
        x: nextColumn * COL_W,
        width: columnCount * COL_W - COL_GAP + AGE_INSET * 2,
        height: AGE_HEADER_H + AGE_CARD_ROWS * ROW_H,
      });
      nextColumn += columnCount + AGE_GAP_COLS;
    }

  const rowByKey = new Map<string, number>();
  if (!hasCompleteFixedLayout)
    for (const ageIndex of [...ageCounts.keys()].sort((a, b) => a - b)) {
      const ageTechs = techs.filter((research) => research.age === ageIndex);
      const levelPositions = new Map<number, number>();
      const occupied = new Set<string>();
      for (const research of ageTechs) {
        const level = getLocalDepth(research);
        const position = levelPositions.get(level) ?? 0;
        levelPositions.set(level, position + 1);
        const parentRows = research.prerequisites
          .map((id) => rowByKey.get(id))
          .filter((row): row is number => row !== undefined);
        const preferredRow =
          layoutOverrides.get(research.key)?.row ??
          (parentRows.length > 0
            ? Math.round(
                parentRows.reduce((sum, row) => sum + row, 0) /
                  parentRows.length,
              )
            : position % AGE_CARD_ROWS);
        let row = Math.min(AGE_CARD_ROWS - 1, preferredRow);
        let overflowColumn = Math.floor(position / AGE_CARD_ROWS);
        while (occupied.has(`${level + overflowColumn}:${row}`)) {
          row += 1;
          if (row >= AGE_CARD_ROWS) {
            row = 0;
            overflowColumn += 1;
          }
        }
        occupied.add(`${level + overflowColumn}:${row}`);
        rowByKey.set(research.key, row);
        placed.push({
          research,
          col: (ageOffsets.get(research.age) ?? 0) + level + overflowColumn,
          row,
        });
      }
    }

  if (!hasCompleteFixedLayout) {
    // Row collision resolution can add overflow columns. Repack age bands from
    // the measured placement so one age can never overlap the next age.
    let correctedOffset = 0;
    for (const bar of bars) {
      const agePlacements = placed.filter(
        ({ research }) => research.age === bar.ageIndex,
      );
      const oldOffset = ageOffsets.get(bar.ageIndex) ?? 0;
      const localColumnCount =
        Math.max(...agePlacements.map(({ col }) => col - oldOffset)) + 1;
      const shift = correctedOffset - oldOffset;
      for (const placement of agePlacements) placement.col += shift;
      bar.x = correctedOffset * COL_W;
      bar.width = localColumnCount * COL_W - COL_GAP + AGE_INSET * 2;
      correctedOffset += localColumnCount + AGE_GAP_COLS;
    }
  }

  // Cards are mapped once and routed by identity, so the router can exclude the
  // two endpoint cards of an arrow while inspecting every other card.
  const nodes = placed.map(({ research, col, row }) => ({
    col,
    row,
    age: research.age,
  }));
  const indexByKey = new Map(
    placed.map(({ research }, index) => [research.key, index]),
  );
  const edges = placed.flatMap(({ research }, childIndex) =>
    research.prerequisites.map((prerequisiteId) => {
      const key = `${prerequisiteId}->${research.key}`;
      const parentIndex = indexByKey.get(prerequisiteId);
      if (parentIndex === undefined) return { path: "", key, crossAge: false };
      const route = routeTechEdge(
        nodes[parentIndex],
        nodes[childIndex],
        nodes,
      );
      return { path: route.path, key, crossAge: route.crossAge };
    }),
  );

  return {
    placed,
    bars,
    edges,
    width:
      (Math.max(...placed.map(({ col }) => col)) + 1) * COL_W + AGE_INSET * 2,
    height: AGE_HEADER_H + AGE_CARD_ROWS * ROW_H,
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
  if (destination.endsWith("Capacity")) {
    return `${buildingNames.get(destination.slice(0, -8) as BuildingKey) ?? destination.slice(0, -8)} capacity`;
  }
  const named =
    buildingNames.get(destination as BuildingKey) ?? unitNames.get(destination);
  return named ?? destination;
};

const describeBonus = (bonus: Bonus, fmt: Props["fmt"]): string => {
  const destination = String(bonus.destination);
  const stat = unitStatLabels[destination];
  const value = fmt(bonus.value);
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
    case "costReductionPercent": {
      const percent = fmt(bonus.value.mul(ExpNumber.fromNumber(100)));
      return `${percent}% cheaper ${label}`;
    }
    case "costReductionFactor":
      return `${label} cost scaling −${value}`;
    case "costReductionBase": {
      const divisor = ExpNumber.ONE.div(
        ExpNumber.max(bonus.value, ExpNumber.fromNumber(1e-9)),
      );
      return `${label} base cost ÷${fmt(divisor)}`;
    }
    case "costReductionFlat":
      return `${label} cost −${value}`;
    case "attributeDrain":
      return `${label} upkeep −${value}/s`;
    default:
      return `${bonus.type} ${label}`;
  }
};

const describeEffects = (
  research: ResearchDefinition,
  fmt: Props["fmt"],
): string[] => {
  const buildingReductions = research.bonuses.filter(
    (bonus) =>
      bonus.type.startsWith("costReduction") &&
      buildingNames.has(String(bonus.destination) as BuildingKey),
  );
  const effects = research.bonuses
    .filter((bonus) => !buildingReductions.includes(bonus))
    .map((bonus) => describeBonus(bonus, fmt));
  if (buildingReductions.length === 0) return effects;
  const coversEveryBuilding = buildingReductions.length === buildingNames.size;
  const firstReduction = buildingReductions[0];
  const samePercent = buildingReductions.every(
    (bonus) =>
      bonus.type === "costReductionPercent" &&
      bonus.value.eq(firstReduction.value),
  );
  const summary =
    coversEveryBuilding && samePercent
      ? `All building costs −${fmt(
          firstReduction.value.mul(ExpNumber.fromNumber(100)),
        )}%`
      : "Building costs reduced";
  return [summary, ...effects];
};

/** One research card: icon, name, effects, buy button. */
const ResearchCard = ({
  research,
  gameState,
  setGameState,
  fmt,
  onOpenGamepedia,
  highlighted,
  selected,
  onSelect,
}: {
  research: ResearchDefinition;
  gameState: CivilizationState;
  setGameState: Props["setGameState"];
  fmt: Props["fmt"];
  onOpenGamepedia: Props["onOpenGamepedia"];
  highlighted: boolean;
  selected: boolean;
  onSelect: () => void;
}) => {
  const bought = gameState.isResearchBought(research.key);
  const unlocked = gameState.isResearchUnlocked(research.key);
  const affordable = gameState.hasResourcesForResearch();
  const state = bought
    ? "bought"
    : unlocked
      ? affordable
        ? "ready"
        : "expensive"
      : "locked";
  const unlocks = research.unlocks.map(
    (unitId) => unitNames.get(unitId) ?? unitId,
  );
  const conversions = research.conversions.map(
    ({ from, to, ratio }) =>
      `Converts ${unitNames.get(from) ?? from} → ${unitNames.get(to) ?? to} (${ratio}:1)`,
  );
  const effects = [
    ...(unlocks.length > 0
      ? [
          `Unlocks ${unlocks.slice(0, 2).join(", ")}${
            unlocks.length > 2 ? ` +${unlocks.length - 2} more` : ""
          }`,
        ]
      : []),
    ...conversions,
    ...describeEffects(research, fmt),
  ];
  const Icon: LucideIcon =
    research.category === "military" ? Castle : FlaskConical;

  return (
    <div
      className={`research-card research-card-${state} ${
        selected ? "research-card-selected" : ""
      } ${highlighted ? "research-card-related" : "research-card-dimmed"}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
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
        {!bought && !unlocked && (
          <Lock size={14} strokeWidth={1.7} aria-hidden />
        )}
      </div>
      <ul className="research-card-effects">
        {effects.slice(0, 2).map((effect, index) => (
          <li key={index}>{effect}</li>
        ))}
        {effects.length === 0 && (
          <li className="muted">No engine effect yet</li>
        )}
      </ul>
      <div className="research-card-footer">
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const boughtCount = gameState.boughtResearch.length;
  const nextResearchCost = gameState.getResearchNextCost()[0];

  const relatedKeys = useMemo(() => {
    if (!selectedKey) return new Set<string>();
    const byKey = new Map(
      researchDefinitions.map((research) => [research.key, research]),
    );
    const related = new Set<string>([selectedKey]);
    const visitParents = (key: string): void => {
      for (const parent of byKey.get(key)?.prerequisites ?? []) {
        if (related.has(parent)) continue;
        related.add(parent);
        visitParents(parent);
      }
    };
    const visitChildren = (key: string): void => {
      for (const child of researchDefinitions) {
        if (!child.prerequisites.includes(key) || related.has(child.key))
          continue;
        related.add(child.key);
        visitChildren(child.key);
      }
    };
    visitParents(selectedKey);
    visitChildren(selectedKey);
    return related;
  }, [selectedKey]);

  // Default scroll: the highest row holding an unresearched tech sits on the
  // second visible row from the top. Re-runs when the bought set changes.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const firstUnbought = layout.placed
      .filter(({ research }) => !gameState.isResearchBought(research.key))
      .sort((a, b) => a.row - b.row)[0];
    container.scrollLeft = firstUnbought
      ? Math.max(0, firstUnbought.col * COL_W - COL_W)
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
          <h3>Technology tree</h3>
        </div>
        <p
          className="research-global-cost"
          title="Current science / cost of the next research"
        >
          <FlaskConical size={13} strokeWidth={1.7} aria-hidden />
          {fmt(gameState.resources.science)} / {fmt(nextResearchCost.base)}
        </p>
        <p className="research-progress">
          {gameState.boughtResearch.length} / {researchDefinitions.length}{" "}
          researched
        </p>
      </div>
      <div
        className="research-scroll"
        ref={scrollRef}
        onWheel={(event) => {
          const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
          if (delta === 0) return;
          event.preventDefault();
          event.currentTarget.scrollLeft += delta;
        }}
      >
        <div
          className="research-tree"
          style={{ width: layout.width, height: layout.height }}
          onClick={() => setSelectedKey(null)}
        >
          <svg
            className="research-edges"
            width={layout.width}
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
                <path
                  d="M 0 0 L 10 5 L 0 10 z"
                  className="research-arrow-head"
                />
              </marker>
            </defs>
            {layout.edges.map(
              (edge) =>
                edge.path && (
                  <path
                    key={edge.key}
                    d={edge.path}
                    className={`research-edge ${
                      edge.crossAge ? "research-edge-cross-age" : ""
                    } ${
                      selectedKey &&
                      edge.key.split("->").every((key) => relatedKeys.has(key))
                        ? "research-edge-related"
                        : selectedKey
                          ? "research-edge-dimmed"
                          : ""
                    }`}
                    markerEnd="url(#research-arrow)"
                  />
                ),
            )}
          </svg>
          {layout.bars.map((bar) => (
            <div
              key={`bar-${bar.ageIndex}`}
              className={`research-age-bar research-age-${bar.ageIndex}`}
              style={{
                left: bar.x,
                top: 0,
                width: bar.width,
                height: bar.height,
              }}
            >
              <span>{ageName(bar.ageIndex)}</span>
            </div>
          ))}
          {layout.placed.map(({ research, col, row }) => (
            <div
              key={research.key}
              className="research-slot"
              style={{
                left: col * COL_W + AGE_INSET,
                top: AGE_HEADER_H + row * ROW_H,
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
                highlighted={!selectedKey || relatedKeys.has(research.key)}
                selected={selectedKey === research.key}
                onSelect={() => setSelectedKey(research.key)}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
