// Research-tree layout generator: `src/game/data/research.json` →
// `src/game/data/researchLayout.json`.
//
// The player-facing tree is fixed-pixel: cards sit on a column/row grid and the
// arrows are SVG paths computed from that grid (see `src/game/researchLayout.ts`
// for the geometry and the routing rules). This tool chooses the grid.
//
// Why it exists: arrows that start and end in different columns have to cross
// the columns in between. A straight arrow cuts through whatever card sits on
// its line, so the panel routes such arrows around the cards; every detour is a
// bend the player sees. Placing each tech next to the cards it depends on keeps
// those detours rare, and that is what this search optimises:
//
//   primary   fewest same-age arrows whose straight line would cut a card
//   secondary fewest arrow/arrow crossings, then fewest columns (compactness)
//
// Per age the search is a simulated annealing over each tech's card cell
// (column + row). Columns are seeded from prerequisite depth (a prerequisite
// starts left of its dependants) with a small column budget of slack so the
// search can pull a tech next to the card that needs it — one column left, or
// into the dependant's own column a full row above it, which the panel draws as
// a straight vertical drop. Rows are free, but a column holds at most
// AGE_CARD_ROWS cards.
//
// Output invariants (the tool throws if they break):
//   - every research has a placement
//   - no two cards share a cell
//   - every same-age prerequisite sits either in a strictly earlier column, or
//     in the same column with VERTICAL_DROP_ROWS empty rows below it (and no
//     card sitting in the space the drop runs through)
//   - ages occupy disjoint, ascending column bands
//
// Run: node tools/gen/researchLayout.mjs            (rewrite the layout file)
//      node tools/gen/researchLayout.mjs --check    (audit it, write nothing)
//
// Geometry below mirrors `src/game/researchLayout.ts`; the Vitest suite
// (`src/game/researchLayout.test.ts`) checks the shipped file against the real
// module, so a mismatch surfaces there rather than silently in the browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CARD_W = 190;
const CARD_H = 100;
const COL_GAP = 100;
const COL_W = CARD_W + COL_GAP;
const ROW_H = CARD_H + 20;
const AGE_CARD_ROWS = 5;
const AGE_HEADER_H = 30;
const AGE_INSET = 32;

// Search budget. Deterministic: the same input data always yields the same
// layout, which keeps the data file reviewable in diffs.
const ITERATIONS = 100000;
const RESTARTS = 4;
const SEED = 20240920;
const COLUMN_SLACK = 2;
const HIT_WEIGHT = 1000;
const CROSS_WEIGHT = 12;
const COLUMN_WEIGHT = 40;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const researchPath = path.join(root, "src", "game", "data", "research.json");
const outputPath = path.join(root, "src", "game", "data", "researchLayout.json");
const checkOnly = process.argv.includes("--check");

const research = JSON.parse(fs.readFileSync(researchPath, "utf8"));
const byKey = new Map(research.map((tech) => [tech.key, tech]));
const ages = [...new Set(research.map((tech) => tech.age))].sort((a, b) => a - b);


/** Deterministic PRNG so repeated runs produce byte-identical output. */
const mulberry32 = (state) => () => {
  state |= 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Longest prerequisite chain inside one age: the seed column of a tech. */
const depthCache = new Map();
const sameAgeDepth = (tech) => {
  const cached = depthCache.get(tech.key);
  if (cached !== undefined) return cached;
  depthCache.set(tech.key, 0);
  const depth = tech.prerequisites.reduce((maximum, prerequisiteId) => {
    const parent = byKey.get(prerequisiteId);
    if (!parent || parent.age !== tech.age) return maximum;
    return Math.max(maximum, sameAgeDepth(parent) + 1);
  }, 0);
  depthCache.set(tech.key, depth);
  return depth;
};

/** Same-age dependency graph of one age, indexed by position in `techs`. */
const graphOf = (age) => {
  const techs = research.filter((tech) => tech.age === age);
  const index = new Map(techs.map((tech, position) => [tech.key, position]));
  const parents = techs.map(() => []);
  const children = techs.map(() => []);
  const edges = [];
  for (const tech of techs) {
    for (const prerequisiteId of tech.prerequisites) {
      const parent = byKey.get(prerequisiteId);
      if (!parent || parent.age !== age) continue;
      const from = index.get(prerequisiteId);
      const to = index.get(tech.key);
      parents[to].push(from);
      children[from].push(to);
      edges.push({ from, to });
    }
  }
  return { techs, parents, children, edges, level: techs.map(sameAgeDepth) };
};

// --- geometry (mirror of src/game/researchLayout.ts) ------------------------

const rectOf = (col, row) => {
  const left = col * COL_W + AGE_INSET;
  const top = AGE_HEADER_H + row * ROW_H;
  return { left, top, right: left + CARD_W, bottom: top + CARD_H };
};

const orientation = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const segmentsIntersect = (a, b, c, d) =>
  Math.sign(orientation(a, b, c)) !== Math.sign(orientation(a, b, d)) &&
  Math.sign(orientation(c, d, a)) !== Math.sign(orientation(c, d, b));

const segmentHitsCard = (start, end, card) => {
  const inside = (point) =>
    point.x > card.left &&
    point.x < card.right &&
    point.y > card.top &&
    point.y < card.bottom;
  if (inside(start) || inside(end)) return true;
  const corners = [
    { x: card.left, y: card.top },
    { x: card.right, y: card.top },
    { x: card.right, y: card.bottom },
    { x: card.left, y: card.bottom },
  ];
  for (let index = 0; index < 4; index += 1) {
    if (segmentsIntersect(start, end, corners[index], corners[(index + 1) % 4]))
      return true;
  }
  return false;
};

/**
 * Rows a vertical drop needs between parent and child: the panel only draws the
 * bottom-edge → top-edge arrow when a full empty row separates the two cards.
 */
const VERTICAL_DROP_ROWS = 2;

/** Arrow anchors: a card's right edge (out) and its left edge (in). */
const exitOf = (col, row) => ({
  x: col * COL_W + AGE_INSET + CARD_W,
  y: AGE_HEADER_H + row * ROW_H + CARD_H / 2,
});
const entryOf = (col, row) => ({
  x: col * COL_W + AGE_INSET,
  y: AGE_HEADER_H + row * ROW_H + CARD_H / 2,
});
/** Arrow anchors for a downward run: bottom edge (out) and top edge (in). */
const bottomExitOf = (col, row) => ({
  x: col * COL_W + AGE_INSET + CARD_W / 2,
  y: AGE_HEADER_H + row * ROW_H + CARD_H,
});
const topEntryOf = (col, row) => ({
  x: col * COL_W + AGE_INSET + CARD_W / 2,
  y: AGE_HEADER_H + row * ROW_H,
});

/**
 * Anchor pair of one edge's straight run. Mirrors `routeTechEdge()` in
 * `src/game/researchLayout.ts`: a parent and a child in the same column
 * VERTICAL_DROP_ROWS or more rows apart connect bottom-centre to top-centre;
 * every other pair connects the parent's right edge to the child's left edge.
 * Obstruction is not tested here — the cost function counts it as a hit, which
 * is what pushes the search to keep the space below the parent clear.
 */
const anchorsOf = (col, row, edge) => {
  const parentCol = col[edge.from];
  const parentRow = row[edge.from];
  const childCol = col[edge.to];
  const childRow = row[edge.to];
  if (parentCol === childCol && childRow - parentRow >= VERTICAL_DROP_ROWS)
    return [bottomExitOf(parentCol, parentRow), topEntryOf(childCol, childRow)];
  return [exitOf(parentCol, parentRow), entryOf(childCol, childRow)];
};

// --- cost -------------------------------------------------------------------

/** How many cards the straight arrow of one edge would cut. */
const edgeHitCount = (graph, col, row, edge) => {
  const [start, end] = anchorsOf(col, row, edge);
  let hits = 0;
  for (let node = 0; node < graph.techs.length; node += 1) {
    if (node === edge.from || node === edge.to) continue;
    if (segmentHitsCard(start, end, rectOf(col[node], row[node]))) hits += 1;
  }
  return hits;
};

const edgeCrossingCount = (col, row, edges) => {
  const segments = edges.map((edge) => anchorsOf(col, row, edge));
  let crossings = 0;
  for (let a = 0; a < segments.length; a += 1) {
    for (let b = a + 1; b < segments.length; b += 1) {
      if (edges[a].from === edges[b].from || edges[a].to === edges[b].to)
        continue;
      if (edges[a].from === edges[b].to || edges[a].to === edges[b].from)
        continue;
      if (
        segmentsIntersect(
          segments[a][0],
          segments[a][1],
          segments[b][0],
          segments[b][1],
        )
      )
        crossings += 1;
    }
  }
  return crossings;
};

const totalOf = (values) => values.reduce((sum, value) => sum + value, 0);

/** Feasible seed: column = deepest prerequisite + 1, rows filled top-down. */
const seedPlacement = (graph) => {
  const count = graph.techs.length;
  const col = new Array(count).fill(0);
  const row = new Array(count).fill(0);
  const cell = new Map();
  const order = [...graph.techs.keys()].sort(
    (a, b) => graph.level[a] - graph.level[b],
  );
  for (const node of order) {
    const floor =
      graph.parents[node].length > 0
        ? Math.max(...graph.parents[node].map((parent) => col[parent])) + 1
        : 0;
    let targetCol = Math.max(graph.level[node], floor);
    let targetRow = 0;
    while (cell.has(`${targetCol}:${targetRow}`)) {
      targetRow += 1;
      if (targetRow >= AGE_CARD_ROWS) {
        targetRow = 0;
        targetCol += 1;
      }
    }
    col[node] = targetCol;
    row[node] = targetRow;
    cell.set(`${targetCol}:${targetRow}`, node);
  }
  return { col, row, cell };
};

/** Simulated annealing over one age's card cells. */
const searchAge = (graph, rand, iterations, columnSlack) => {
  const { col, row, cell } = seedPlacement(graph);
  const hitCounts = graph.edges.map((edge) =>
    edgeHitCount(graph, col, row, edge),
  );
  const costOf = () =>
    HIT_WEIGHT * totalOf(hitCounts) +
    CROSS_WEIGHT * edgeCrossingCount(col, row, graph.edges) +
    COLUMN_WEIGHT * (Math.max(...col) + 1);

  const startingCost = costOf();
  let current = startingCost;
  let best = {
    col: col.slice(),
    row: row.slice(),
    cost: startingCost,
    hits: totalOf(hitCounts),
  };
  const columnLimit = Math.max(...col) + columnSlack;
  const nodesWithEdges = [...graph.techs.keys()].filter(
    (node) => graph.parents[node].length > 0 || graph.children[node].length > 0,
  );
  const recomputeAll = () => {
    for (let index = 0; index < graph.edges.length; index += 1)
      hitCounts[index] = edgeHitCount(graph, col, row, graph.edges[index]);
  };

  for (let step = 0; step < iterations; step += 1) {
    // Starts hot enough to cross a "one more hit" barrier, cools to greedy.
    const temperature = 3000 * Math.pow(0.001, step / iterations);
    const node = nodesWithEdges[Math.floor(rand() * nodesWithEdges.length)];
    const snapshot = { col: col[node], row: row[node], hits: hitCounts.slice() };
    const revert = () => {
      cell.delete(`${col[node]}:${row[node]}`);
      col[node] = snapshot.col;
      row[node] = snapshot.row;
      cell.set(`${snapshot.col}:${snapshot.row}`, node);
      hitCounts.splice(0, hitCounts.length, ...snapshot.hits);
    };
    // A prerequisite may sit in a later column, or share its dependant's column
    // as long as the vertical drop keeps its empty rows underneath; a dependant
    // may sit in an earlier column, or share the card's column below it.
    const fitsColumn = (targetCol, targetRow) =>
      graph.parents[node].every(
        (parent) =>
          col[parent] < targetCol ||
          (col[parent] === targetCol &&
            targetRow - row[parent] >= VERTICAL_DROP_ROWS),
      ) &&
      graph.children[node].every(
        (child) =>
          col[child] > targetCol ||
          (col[child] === targetCol &&
            row[child] - targetRow >= VERTICAL_DROP_ROWS),
      );
    const moveTo = (targetCol, targetRow) => {
      if (targetRow < 0 || targetRow >= AGE_CARD_ROWS) return false;
      if (!fitsColumn(targetCol, targetRow)) return false;
      if (cell.has(`${targetCol}:${targetRow}`)) return false;
      cell.delete(`${col[node]}:${row[node]}`);
      col[node] = targetCol;
      row[node] = targetRow;
      cell.set(`${targetCol}:${targetRow}`, node);
      return true;
    };

    const kind = rand();
    let moved = false;
    if (kind < 0.3) {
      moved = moveTo(snapshot.col, Math.floor(rand() * AGE_CARD_ROWS));
    } else if (kind < 0.5) {
      const targetCol = snapshot.col + (rand() < 0.5 ? -1 : 1);
      if (targetCol >= 0 && targetCol <= columnLimit)
        moved = moveTo(targetCol, snapshot.row);
    } else if (kind < 0.7) {
      // Pull the tech next to one of its dependants: either one column left —
      // a one-column arrow can never cut a card — or, half the time, into the
      // dependant's own column VERTICAL_DROP_ROWS above it, the shape the panel
      // draws as a straight vertical drop.
      if (graph.children[node].length > 0) {
        const child =
          graph.children[node][
            Math.floor(rand() * graph.children[node].length)
          ];
        if (rand() < 0.5) {
          moved = moveTo(col[child], row[child] - VERTICAL_DROP_ROWS);
        } else {
          const targetCol = col[child] - 1;
          if (targetCol >= 0 && targetCol <= columnLimit) {
            let targetRow = 0;
            while (
              targetRow < AGE_CARD_ROWS &&
              cell.has(`${targetCol}:${targetRow}`)
            )
              targetRow += 1;
            if (targetRow < AGE_CARD_ROWS) moved = moveTo(targetCol, targetRow);
          }
        }
      }
    } else {
      // Relocate anywhere in the tech's legal column window.
      const lowest =
        (graph.parents[node].length > 0
          ? Math.max(...graph.parents[node].map((parent) => col[parent])) + 1
          : 0) + (rand() < 0.5 ? 0 : -1);
      const highest =
        (graph.children[node].length > 0
          ? Math.min(...graph.children[node].map((child) => col[child])) - 1
          : columnLimit) + (rand() < 0.5 ? 0 : 1);
      const low = Math.max(0, lowest);
      const high = Math.min(columnLimit, Math.max(low, highest));
      moved = moveTo(
        low + Math.floor(rand() * (high - low + 1)),
        Math.floor(rand() * AGE_CARD_ROWS),
      );
    }
    if (!moved) continue;
    recomputeAll();
    const next = costOf();
    if (next <= current || rand() < Math.exp(-(next - current) / temperature)) {
      current = next;
      if (next < best.cost)
        best = {
          col: col.slice(),
          row: row.slice(),
          cost: next,
          hits: totalOf(hitCounts),
        };
    } else {
      revert();
      current = costOf();
    }
  }
  return best;
};

// --- assemble ---------------------------------------------------------------

/** Best of RESTARTS anneals for one age, by the shared cost function. */
const bestForAge = (graph) => {
  let best = null;
  for (let restart = 0; restart < RESTARTS; restart += 1) {
    const rand = mulberry32(SEED + restart * 7919);
    const candidate = searchAge(graph, rand, ITERATIONS, COLUMN_SLACK);
    if (!best || candidate.cost < best.cost) best = candidate;
  }
  return best;
};

const layout = new Map();
let cursor = 0;
const report = [];
for (const age of ages) {
  const graph = graphOf(age);
  const best = bestForAge(graph);
  const minimum = Math.min(...best.col);
  const width = Math.max(...best.col) - minimum + 1;
  graph.techs.forEach((tech, node) => {
    layout.set(tech.key, {
      column: best.col[node] - minimum + cursor,
      row: best.row[node],
    });
  });
  const verify = graph.edges.map((edge) =>
    edgeHitCount(graph, best.col, best.row, edge),
  );
  report.push(
    `age ${age}: ${graph.techs.length} techs, ${width} columns, ` +
      `${graph.edges.length} same-age arrows, ` +
      `${totalOf(verify)} would cut a card (routed around it)`,
  );
  cursor += width;
}
report.push(`total: ${research.length} cards, ${cursor} columns`);
/** Prerequisite pairs that share a column: drawn as straight vertical drops. */
const verticalDrops = research.reduce((count, tech) => {
  const child = layout.get(tech.key);
  return (
    count +
    tech.prerequisites.filter((prerequisiteId) => {
      const parent = layout.get(prerequisiteId);
      return parent && parent.column === child.column;
    }).length
  );
}, 0);
report.push(`${verticalDrops} vertical drops`);

// --- validate ---------------------------------------------------------------

const problems = [];
for (const tech of research) {
  if (!layout.has(tech.key)) problems.push(`no placement for ${tech.key}`);
}
const seen = new Map();
for (const [key, placement] of layout) {
  const cell = `${placement.column}:${placement.row}`;
  if (seen.has(cell))
    problems.push(`${key} shares cell ${cell} with ${seen.get(cell)}`);
  seen.set(cell, key);
  if (placement.row < 0 || placement.row >= AGE_CARD_ROWS)
    problems.push(`${key} row ${placement.row} is outside the age band`);
}
const cardsByColumn = new Map();
for (const [key, placement] of layout) {
  const cards = cardsByColumn.get(placement.column) ?? [];
  cards.push({ key, row: placement.row });
  cardsByColumn.set(placement.column, cards);
}
for (const tech of research) {
  const child = layout.get(tech.key);
  for (const prerequisiteId of tech.prerequisites) {
    const parent = layout.get(prerequisiteId);
    if (!parent) continue;
    if (parent.column > child.column) {
      problems.push(
        `${prerequisiteId} (col ${parent.column}) is not left of ` +
          `${tech.key} (col ${child.column})`,
      );
      continue;
    }
    if (parent.column !== child.column) continue;
    // Same column: legal as a vertical chain, but the drop needs its empty rows
    // and nothing sitting in the space it runs through.
    if (child.row - parent.row < VERTICAL_DROP_ROWS) {
      problems.push(
        `${prerequisiteId} (row ${parent.row}) sits ${child.row - parent.row} ` +
          `row(s) above ${tech.key} (row ${child.row}) in column ` +
          `${child.column}; the vertical drop needs ${VERTICAL_DROP_ROWS}`,
      );
      continue;
    }
    const between = (cardsByColumn.get(child.column) ?? []).filter(
      (card) => card.row > parent.row && card.row < child.row,
    );
    if (between.length > 0)
      problems.push(
        `${between.map((card) => card.key).join(", ")} sits between ` +
          `${prerequisiteId} and ${tech.key} in column ${child.column}`,
      );
  }
}
const bands = ages.map((age) => {
  const placed = research.filter((tech) => tech.age === age);
  return {
    age,
    low: Math.min(...placed.map((tech) => layout.get(tech.key).column)),
    high: Math.max(...placed.map((tech) => layout.get(tech.key).column)),
  };
});
for (let index = 1; index < bands.length; index += 1) {
  if (bands[index].low <= bands[index - 1].high)
    problems.push(
      `age ${bands[index].age} band overlaps age ${bands[index - 1].age}`,
    );
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  throw new Error(`${problems.length} layout invariant(s) broken`);
}

// --- emit -------------------------------------------------------------------

const ordered = Object.fromEntries(
  research.map((tech) => [tech.key, layout.get(tech.key)]),
);
const previous = fs.existsSync(outputPath)
  ? fs.readFileSync(outputPath, "utf8")
  : "";
const next = `${JSON.stringify(ordered, null, 2)}\n`;
if (checkOnly) {
  console.log(report.join("\n"));
  console.log(
    previous === next
      ? "layout is up to date"
      : "layout differs from research.json — rerun without --check",
  );
  if (previous !== next) process.exitCode = 1;
} else {
  fs.writeFileSync(outputPath, next, "utf8");
  console.log(report.join("\n"));
  console.log(
    previous === next
      ? `${path.relative(root, outputPath)} unchanged`
      : `wrote ${path.relative(root, outputPath)}`,
  );
}
