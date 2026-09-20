import { describe, expect, it } from "vitest";
import researchData from "./data/research.json";
import layoutData from "./data/researchLayout.json";
import {
  AGE_CARD_ROWS,
  routeTechEdge,
  segmentHitsCard,
  techRect,
  type Point,
  type TechPlacement,
} from "./researchLayout";

/**
 * The research tree ships as a fixed-pixel grid (`data/researchLayout.json`)
 * that the player-facing panel renders verbatim. These tests hold the layout to
 * the promises the panel relies on: a complete grid, one card per cell, every
 * arrow flowing left to right, age bands that never overlap, and — the reason
 * the layout exists at all — no arrow running through somebody else's card.
 */

type TechData = { key: string; age: number; prerequisites: string[] };
type LayoutPosition = { column: number; row: number };

const techs = researchData as TechData[];
const layout = layoutData as Record<string, LayoutPosition>;

const placements = new Map<string, TechPlacement>(
  techs.map((tech) => [
    tech.key,
    { col: layout[tech.key].column, row: layout[tech.key].row, age: tech.age },
  ]),
);
const nodes = [...placements.values()];

/** Placement of a research; throws when the layout is incomplete. */
const at = (key: string): TechPlacement => {
  const placement = placements.get(key);
  if (!placement) throw new Error(`layout has no placement for ${key}`);
  return placement;
};

/** Flatten an SVG path ("M x y L x y …") into straight segments. */
const pathSegments = (path: string): [Point, Point][] => {
  const numbers = path.match(/-?[\d.]+/g)?.map(Number) ?? [];
  const segments: [Point, Point][] = [];
  for (let index = 0; index + 3 < numbers.length; index += 2)
    segments.push([
      { x: numbers[index], y: numbers[index + 1] },
      { x: numbers[index + 2], y: numbers[index + 3] },
    ]);
  return segments;
};

const edges = techs.flatMap((tech) => {
  const child = placements.get(tech.key);
  if (!child) return [];
  return tech.prerequisites.flatMap((prerequisiteId) => {
    const parent = placements.get(prerequisiteId);
    if (!parent) return [];
    return [{ key: `${prerequisiteId}->${tech.key}`, parent, child }];
  });
});

describe("research tree layout", () => {
  it("places every research, and nothing else", () => {
    expect(techs.length).toBeGreaterThan(0);
    expect(Object.keys(layout).sort()).toEqual(
      techs.map((tech) => tech.key).sort(),
    );
  });

  it("gives every card its own grid cell inside the five-row band", () => {
    const cells = new Map<string, string>();
    const clashes: string[] = [];
    for (const [key, { col, row }] of placements) {
      if (row < 0 || row >= AGE_CARD_ROWS)
        clashes.push(`${key} sits in row ${row}`);
      const cell = `${col}:${row}`;
      const occupant = cells.get(cell);
      if (occupant) clashes.push(`${key} shares cell ${cell} with ${occupant}`);
      cells.set(cell, key);
    }
    expect(clashes).toEqual([]);
  });

  it("keeps every prerequisite left of its dependant", () => {
    const backwards = edges
      .filter(({ parent, child }) => parent.col >= child.col)
      .map(({ key }) => key);
    expect(backwards).toEqual([]);
  });

  it("keeps age bands ascending and non-overlapping", () => {
    const bands = [...new Set(techs.map((tech) => tech.age))]
      .sort((a, b) => a - b)
      .map((age) => {
        const columns = techs
          .filter((tech) => tech.age === age)
          .map((tech) => at(tech.key).col);
        return { age, low: Math.min(...columns), high: Math.max(...columns) };
      });
    for (let index = 1; index < bands.length; index += 1)
      expect(bands[index].low, `age ${bands[index].age}`).toBeGreaterThan(
        bands[index - 1].high,
      );
  });

  it("routes every arrow clear of every other card", () => {
    const crossings: string[] = [];
    for (const { key, parent, child } of edges) {
      const route = routeTechEdge(parent, child, nodes);
      for (const [start, end] of pathSegments(route.path))
        for (const candidate of nodes) {
          if (candidate === parent || candidate === child) continue;
          if (segmentHitsCard(start, end, techRect(candidate)))
            crossings.push(`${key} cuts through ${candidate.age}/${candidate.col}`);
        }
    }
    expect(crossings).toEqual([]);
  });

  it("draws nearly every same-age arrow straight", () => {
    const elbows = edges
      .filter(({ parent, child }) => parent.age === child.age)
      .filter(({ parent, child }) => !routeTechEdge(parent, child, nodes).straight)
      .map(({ key }) => key);
    // The generator leaves a few structurally forced detours; a rise here means
    // the layout needs regenerating with `node tools/gen/researchLayout.mjs`.
    expect(elbows.length).toBeLessThanOrEqual(6);
  });
});
