/**
 * Geometry for the research tree (roadmap Milestone 9).
 *
 * The panel draws cards on a fixed pixel grid and overlays an SVG with one path
 * per prerequisite arrow, so every coordinate has to be computable without
 * measuring the DOM. That geometry lives here — React-free and unit-testable —
 * while `components/ResearchPanel.tsx` only renders it.
 *
 * Arrow invariant: a routed arrow never runs through a card other than the two
 * it connects. A straight line is used whenever it is clear; otherwise a
 * same-age arrow detours through the empty 20px corridor between two card rows
 * (and the 100px gap between two card columns), and a cross-age arrow detours
 * through the empty header lane above the cards. `researchLayout.test.ts`
 * asserts the invariant for the shipped layout.
 */

export type Point = { x: number; y: number };

export type CardRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** One card on the grid: column and row inside its age band, plus its age. */
export type TechPlacement = {
  col: number;
  row: number;
  age: number;
};

export const CARD_W = 190;
export const CARD_H = 100;
export const COL_GAP = 100;
export const COL_W = CARD_W + COL_GAP;
export const ROW_H = CARD_H + 20;
export const AGE_CARD_ROWS = 5;
export const AGE_HEADER_H = 30;
export const AGE_INSET = 32;

/** Horizontal run-off used when an arrow leaves a card sideways. */
const EDGE_INSET = 18;
/** Inset for the shared header lane that cross-age arrows travel along. */
const LANE_INSET = 14;

/** Card box of a placement, in tree pixel coordinates. */
export const techRect = ({ col, row }: TechPlacement): CardRect => {
  const left = col * COL_W + AGE_INSET;
  const top = AGE_HEADER_H + row * ROW_H;
  return { left, top, right: left + CARD_W, bottom: top + CARD_H };
};

/** Right-edge anchor of a card: where an outgoing arrow starts. */
export const techExit = ({ col, row }: TechPlacement): Point => ({
  x: col * COL_W + AGE_INSET + CARD_W,
  y: AGE_HEADER_H + row * ROW_H + CARD_H / 2,
});

/** Left-edge anchor of a card: where an incoming arrow ends (arrow head). */
export const techEntry = ({ col, row }: TechPlacement): Point => ({
  x: col * COL_W + AGE_INSET,
  y: AGE_HEADER_H + row * ROW_H + CARD_H / 2,
});

/**
 * Centre of the empty corridor below card row `rowIndex`. Corridors are the
 * 20px bands between two rows (plus the 20px band under the last row), so a
 * horizontal run along one of them can never touch a card.
 */
export const corridorY = (rowIndex: number): number =>
  AGE_HEADER_H + rowIndex * ROW_H - (ROW_H - CARD_H) / 2;

const orientation = (a: Point, b: Point, c: Point): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const segmentsIntersect = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
): boolean => {
  const firstA = orientation(firstStart, firstEnd, secondStart);
  const firstB = orientation(firstStart, firstEnd, secondEnd);
  const secondA = orientation(secondStart, secondEnd, firstStart);
  const secondB = orientation(secondStart, secondEnd, firstEnd);
  return (
    Math.sign(firstA) !== Math.sign(firstB) &&
    Math.sign(secondA) !== Math.sign(secondB)
  );
};

/** True when the segment runs through the card's interior or edges. */
export const segmentHitsCard = (
  start: Point,
  end: Point,
  card: CardRect,
): boolean => {
  const inside = (point: Point): boolean =>
    point.x > card.left &&
    point.x < card.right &&
    point.y > card.top &&
    point.y < card.bottom;
  if (inside(start) || inside(end)) return true;
  const corners: Point[] = [
    { x: card.left, y: card.top },
    { x: card.right, y: card.top },
    { x: card.right, y: card.bottom },
    { x: card.left, y: card.bottom },
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const next = corners[(index + 1) % corners.length];
    if (segmentsIntersect(start, end, corners[index], next)) return true;
  }
  return false;
};

export type TechEdgeRoute = {
  path: string;
  crossAge: boolean;
  /** True when the straight line was clear and no detour was needed. */
  straight: boolean;
};

/**
 * Route one prerequisite arrow. `placements` is every card in the tree,
 * including `parent` and `child`; the two endpoint cards are ignored when
 * looking for obstacles. Pass the objects from the layout array so the
 * identity comparison excludes exactly those two.
 */
export const routeTechEdge = (
  parent: TechPlacement,
  child: TechPlacement,
  placements: readonly TechPlacement[],
): TechEdgeRoute => {
  const start = techExit(parent);
  const end = techEntry(child);
  const crossAge = parent.age !== child.age;
  const blocked = placements.some(
    (candidate) =>
      candidate !== parent &&
      candidate !== child &&
      segmentHitsCard(start, end, techRect(candidate)),
  );
  if (!blocked)
    return { path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, crossAge, straight: true };

  if (crossAge) {
    const laneY = AGE_HEADER_H / 2;
    return {
      path:
        `M ${start.x} ${start.y} L ${start.x + LANE_INSET} ${start.y} ` +
        `L ${start.x + LANE_INSET} ${laneY} L ${end.x - LANE_INSET} ${laneY} ` +
        `L ${end.x - LANE_INSET} ${end.y} L ${end.x} ${end.y}`,
      crossAge,
      straight: false,
    };
  }

  // Same age: drop into the corridor nearest the parent (or above the child
  // when the child sits lower), cross sideways there, then step into the card.
  const lane =
    parent.row < child.row
      ? child.row
      : parent.row > child.row
        ? parent.row
        : Math.min(parent.row + 1, AGE_CARD_ROWS);
  const laneY = corridorY(lane);
  return {
    path:
      `M ${start.x} ${start.y} L ${start.x + EDGE_INSET} ${start.y} ` +
      `L ${start.x + EDGE_INSET} ${laneY} L ${end.x - LANE_INSET} ${laneY} ` +
      `L ${end.x - LANE_INSET} ${end.y} L ${end.x} ${end.y}`,
    crossAge,
    straight: false,
  };
};
