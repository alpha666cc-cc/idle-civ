// Research-tree converter: `temp/tech tree-v3-effects.json` → `src/game/data/research.json`.
//
// The source file is human-authored and not strict JSON: objects and array
// elements are sometimes written without the separating comma, and some arrays
// carry a trailing comma. `repairJson()` applies those repairs in a fixed order;
// a structural check (unique ids, every tech with age/effects) then guards
// against a garbled parse silently emitting a short file.
//
// Mapping (user ruling):
//   cost small → ÷2, medium → ÷100, large/big → −0.01 cost scaling
//   production small → ×2, medium → ×10, large → ×100 (no food doubling yet)
//   unit_stat_boost small → ×1.25, large → ×1.5 (multiplier)
//   unlock_unit → the definition's `unlocks` list (not a bonus)
//   convert_unit / unitConversions → the definition's `conversions` list, at
//     CONVERSION_RATIO_DEFAULT (10:1) unless the override table names the pair
//   Unsupported types are kept per entry under `ignored` with a machine-readable
//   reason — never silently dropped.
//
// Research prices are global engine state, not per-tech JSON costs. Preserve
// live fields such as GUIDs when converting the source tree.
//
// Run: node tools/gen/techtree.mjs [--expect=N]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

/** Point this at a future v4 file to regenerate the tree. */
const sourcePath = path.join(root, "temp", "tech tree-v3-effects.json");
const outputPath = path.join(root, "src", "game", "data", "research.json");
const reportPath = path.join(root, "temp", "techtree-flags.txt");

/** Preserve live data fields, including GUIDs, during regeneration. */
const existingByKey = new Map(
  (existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, "utf8"))
    : []
  ).map((tech) => [tech.key, tech]),
);

/**
 * Sanity guard: the tree is expected to hold this many techs. A short file means
 * the parser lost entries — update the number deliberately when content changes.
 * `--expect=N` overrides it for one-off experiments.
 */
const expectArg = process.argv.find((argument) => argument.startsWith("--expect="));
const expectedTechCount = expectArg
  ? Number(expectArg.split("=")[1])
  : 172;


// ---------------------------------------------------------------------------
// Vocabulary read from the live game data
// ---------------------------------------------------------------------------

const units = JSON.parse(
  readFileSync(path.join(root, "src", "game", "data", "units.json"), "utf8"),
);
const buildings = JSON.parse(
  readFileSync(path.join(root, "src", "game", "data", "buildings.json"), "utf8"),
);
const unitIds = new Set(units.map((unit) => unit.id));
const buyableUnitIds = new Set(
  units.filter((unit) => (unit.costs ?? []).length > 0).map((unit) => unit.id),
);
const buildingKeys = new Set(buildings.map((building) => building.key));

/** production_multiplier target → engine resource key (trade is a resource now). */
const productionTargetResource = {
  food: "food",
  wood: "wood",
  stone: "stone",
  gold: "gold",
  science: "science",
  metalwork: "metalwork",
  trade: "trade",
};

/**
 * The source spells building targets both ways (`town_hall` and `town-hall`), so
 * every building lookup goes through this normaliser.
 */
const canonicalBuilding = (target) => String(target).replaceAll("_", "-");

/** Building key producing a resource (for production_multiplier targets). */
const buildingResource = {
  farm: "food",
  "lumber-yard": "wood",
  quarry: "stone",
  "gold-mine": "gold",
  market: "gold",
  smithy: "metalwork",
};

/** Capacity bonus tiers; a capacity multiplier is `attributeMultiplier` on `<key>Capacity`. */
// Capacity tier magnitudes mirror the production-multiplier tiers (small ×2,
// medium ×10, large ×100); a multiplier on a capacity resource is retroactive —
// getBuildingMax() applies it on top of the stock granted at build time.
const capacityTier = { x2: 2, small: 2, medium: 10, large: 100 };

/** Cost-reduction group names, with and without the `_units` suffix. */
const unitGroupIds = () => ({
  all: [...buyableUnitIds],
  military: [...buyableUnitIds],
  ranged: units.filter((u) => u.tags.includes("ranged")).map((u) => u.id),
  cavalry: units
    .filter((u) => u.tags.includes("armored") && u.domain === "ground")
    .map((u) => u.id),
  naval: units
    .filter((u) => u.tags.includes("naval") || u.domain === "naval")
    .map((u) => u.id),
  siege: units.filter((u) => u.tags.includes("anti-armor")).map((u) => u.id),
});

const lookupUnitGroup = (ids, target) =>
  ids[target] ?? ids[String(target).replace(/_units$/, "")];

/** Unit-stat target → engine bonus destination grammar. */
const unitStatTargets = {
  infantry_hp: "tag.infantry.hp",
  infantry_attack: "tag.infantry.attack",
  ranged_attack: "tag.ranged.attack",
  cavalry_attack: "tag.armored.attack",
  cavalry_speed: "tag.armored.speed",
  ship_attack: "tag.naval.attack",
  naval_defense: "tag.naval.hp",
  melee_defense: "unitAll.hp",
  unit_hp: "unitAll.hp",
  army_defense: "unitAll.hp",
  army_attack: "unitAll.attack",
  army_power: "unitAll.attack",
};

/**
 * Conversion rate: how many obsolete units buy one replacement. Flat for now —
 * the future per-pair conversion table goes in `conversionRatioOverrides`, and
 * the chosen number is written into the data so the engine never hardcodes it.
 */
const CONVERSION_RATIO_DEFAULT = 10;
const conversionRatioOverrides = {};

/** Tier values per effect type (user ruling; medium reserved for a future file). */
const tierValue = {
  production_multiplier: { small: 2, medium: 10, large: 100 },
  cost_reduction: { small: 0.5, medium: 0.99, large: 0.01 },
  building_cost_reduction: { small: 0.5, medium: 0.99, large: 0.01 },
  unit_cost_reduction: { small: 0.5, medium: 0.99, large: 0.01 },
  unit_stat_boost: { small: 1.25, medium: 1.5, large: 1.5 },
  click_power: { small: 1, medium: 5, large: 10 },
};

// ---------------------------------------------------------------------------
// Lenient parse
// ---------------------------------------------------------------------------

/**
 * Repairs the hand-authored source into strict JSON. Order matters: trailing
 * commas are removed first, then each "value on one line, next value on the
 * following line without a comma" pattern gets its comma. Anything still
 * unparseable throws with the offending window printed.
 */
const repairJson = (text) => {
  const repaired = text
    // 1. `"x",` immediately before `}` or `]` — a trailing comma.
    .replace(/,+(\s*[}\]])/g, "$1")
    // 2. `}` then a newline then `{`.
    .replace(/}\s*\n(\s*)\{/g, "},\n$1{")
    // 3. `}` then a newline then a key.
    .replace(/}\s*\n(\s*)"/g, '},\n$1"')
    // 4. `]` then a newline then a key.
    .replace(/](\s*)\n(\s*)"/g, '],\n$2"')
    // 5. a scalar (string / number / boolean / null) then a newline then a key.
    .replace(/([0-9"]|true|false|null)(\s*)\n(\s*)"/g, "$1,\n$3");
  try {
    return JSON.parse(repaired);
  } catch (error) {
    const position = /position (\d+)/.exec(error.message)?.[1];
    const window = position
      ? repaired.slice(Math.max(0, Number(position) - 160), Number(position) + 80)
      : "(no position)";
    throw new Error(
      `Cannot parse ${path.basename(sourcePath)}: ${error.message}\n${window}`,
    );
  }
};

const techs = repairJson(readFileSync(sourcePath, "utf8"));
console.log(`parsed ${techs.length} techs from ${path.basename(sourcePath)}`);

// Structural guard: a garbled parse must never silently ship a short tree.
if (techs.length !== expectedTechCount) {
  throw new Error(
    `Expected ${expectedTechCount} techs, parsed ${techs.length} — ` +
      `fix the source or pass --expect=<count> deliberately.`,
  );
}
const seenTechIds = new Set();
for (const tech of techs) {
  if (typeof tech.id !== "string" || tech.id.length === 0) {
    throw new Error("Parsed a tech without an id.");
  }
  if (seenTechIds.has(tech.id)) throw new Error(`Duplicate tech id: ${tech.id}`);
  seenTechIds.add(tech.id);
  if (typeof tech.age !== "number" || !Array.isArray(tech.effects)) {
    throw new Error(`Tech ${tech.id} is missing its age or effects array.`);
  }
}



// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

const unitGroups = unitGroupIds();
const report = [];
const flag = (tech, effect, reason) => {
  report.push(
    `${tech.id}: IGNORED ${effect.type} -> ${effect.target} (${effect.value}) — ${reason}`,
  );
};

/**
 * Conversion pairs for one tech: the structured `unitConversions` array plus any
 * `convert_unit` effect written as `target → value` unit ids, deduped. The rate
 * is the flat default today and the future per-pair table plugs in here.
 */
const conversionsOf = (tech) => {
  const pairs = [];
  const add = (from, to) => {
    if (!unitIds.has(from) || !unitIds.has(to) || from === to) return false;
    if (pairs.some((pair) => pair.from === from && pair.to === to)) return true;
    pairs.push({ from, to });
    return true;
  };
  for (const conversion of tech.unitConversions ?? []) {
    if (!add(conversion.fromUnitId, conversion.toUnitId)) {
      flag(
        tech,
        {
          type: "unitConversions",
          target: String(conversion.fromUnitId),
          value: String(conversion.toUnitId),
        },
        "unresolvable conversion pair",
      );
    }
  }
  for (const effect of tech.effects ?? []) {
    if (effect.type !== "convert_unit") continue;
    if (add(effect.target, effect.value)) continue;
    // Legacy tier wording (`value: "small"`) — the structured array carries the pair.
    const covered = (tech.unitConversions ?? []).some(
      (conversion) => conversion.fromUnitId === effect.target,
    );
    if (!covered) flag(tech, effect, "unresolved conversion (no structured pair)");
  }
  return pairs.map((pair) => ({
    from: pair.from,
    to: pair.to,
    ratio:
      conversionRatioOverrides[`${pair.from}->${pair.to}`] ??
      CONVERSION_RATIO_DEFAULT,
  }));
};

const convertEffect = (tech, effect) => {
  const { type, target, value: tier } = effect;
  if (type === "unlock_unit") {
    if (!unitIds.has(target)) flag(tech, effect, "unknown unit id");
    return null; // carried via `unlocks`, not a bonus
  }
  if (type === "convert_unit") {
    return null; // carried via `conversions`, not a bonus
  }
  if (type === "production_multiplier" || type === "global_production") {
    if (target === "house" || target === "town_hall") {
      flag(tech, effect, "capacity-adjacent — user review");
      return null;
    }
    if (target === "all") {
      return {
        type: "attributeMultiplier",
        destination: "all-production",
        value: String(tierValue.production_multiplier[tier]),
      };
    }
    const resource =
      productionTargetResource[target] ??
      buildingResource[canonicalBuilding(target)];
    if (!resource) {
      flag(tech, effect, "unmappable production target");
      return null;
    }
    return {
      type: "attributeMultiplier",
      destination: resource,
      value: String(tierValue.production_multiplier[tier]),
    };
  }
  if (type === "building_capacity") {
    const value = capacityTier[tier];
    if (value === undefined) {
      flag(tech, effect, "capacity tier not defined (use x2)");
      return null;
    }
    const keys =
      target === "all"
        ? [...buildingKeys].map((key) => `${key}Capacity`)
        : buildingKeys.has(canonicalBuilding(target))
          ? [`${canonicalBuilding(target)}Capacity`]
          : null;
    if (!keys) {
      flag(tech, effect, "unmappable capacity target");
      return null;
    }
    return keys.map((destination) => ({
      type: "attributeMultiplier",
      destination,
      value: String(value),
    }));
  }
  if (type === "cost_reduction" || type === "building_cost_reduction" || type === "unit_cost_reduction") {
    const value = tierValue[type][tier];
    if (type === "building_cost_reduction") {
      if (target === "all") {
        return [...buildingKeys].map((key) => ({
          type: "costReductionPercent",
          destination: key,
          value: String(value),
        }));
      }
      if (buildingKeys.has(canonicalBuilding(target))) {
        return {
          type: "costReductionPercent",
          destination: canonicalBuilding(target),
          value: String(value),
        };
      }
      flag(tech, effect, "unmappable building target");
      return null;
    }
    if (target === "dock" || target === "enhancers") {
      flag(tech, effect, "no such buyable (dock / enhancer cost path)");
      return null;
    }
    const ids = lookupUnitGroup(unitGroups, target);
    if (ids) {
      return ids.map((id) => ({
        type: "costReductionPercent",
        destination: id,
        value: String(value),
      }));
    }
    if (!unitIds.has(target)) {
      flag(tech, effect, "unknown unit id");
      return null;
    }
    return { type: "costReductionPercent", destination: target, value: String(value) };
  }
  if (type === "unit_stat_boost") {
    const destination = unitStatTargets[target];
    if (!destination) {
      flag(tech, effect, "unmappable unit-stat target");
      return null;
    }
    return {
      type: "attributeMultiplier",
      destination,
      value: String(tierValue.unit_stat_boost[tier]),
    };
  }
  if (type === "click_power") {
    if (target === "all") {
      return { type: "attributeFlat", destination: "clickPower", value: String(tierValue.click_power[tier]) };
    }
    if (target === "auto_click") {
      return { type: "attributeFlat", destination: "autoClickRate", value: String(tierValue.click_power[tier] / 2) };
    }
    flag(tech, effect, "unknown click_power target");
    return null;
  }
  if (type === "resource_capacity") {
    flag(tech, effect, "no resource storage cap");
    return null;
  }
  const noSystem = {
    research_speed: "research purchase is instant; no speed mechanic",
    offline_cap: "offline tuning not research-driven",
    offline_efficiency: "offline tuning not research-driven",
    special_ability: "no such mechanic",
    upkeep_reduction: "no upkeep drain on population",
    population_growth: "population is derived from citizens",
    worker_efficiency: "no per-worker efficiency attribute",
    enhancer_scaling: "enhancer cost path does not read reductions",
  };
  if (noSystem[type]) {
    flag(tech, effect, noSystem[type]);
    return null;
  }
  flag(tech, effect, "unknown effect type");
  return null;
};


// Order and cost basis are deliberately the SOURCE order: it is verified to put
// every prerequisite before its dependants, and costing by source index keeps
// every existing tech's cost byte-identical when prerequisites are edited (a
// topological re-sort would renumber the whole tail of the tree). The engine
// prices research globally (`getResearchNextCost()`), so this array is a stable
// record rather than a live price list.
const sourceIndex = new Map(techs.map((tech, index) => [tech.id, index]));
const orderViolations = [];
for (const tech of techs) {
  for (const prerequisite of tech.prerequisites ?? []) {
    const parentIndex = sourceIndex.get(prerequisite);
    if (parentIndex === undefined) {
      orderViolations.push(`${tech.id} -> unknown prerequisite ${prerequisite}`);
    } else if (parentIndex > sourceIndex.get(tech.id)) {
      orderViolations.push(
        `${tech.id} (position ${sourceIndex.get(tech.id)}) comes before its ` +
          `prerequisite ${prerequisite} (position ${parentIndex})`,
      );
    }
  }
}
if (orderViolations.length > 0) {
  throw new Error(
    `The source file must list prerequisites before their dependants:\n  ` +
      orderViolations.join("\n  "),
  );
}

const entries = techs.map((tech) => {
  const bonuses = [];
  for (const effect of tech.effects ?? []) {
    const converted = convertEffect(tech, effect);
    if (Array.isArray(converted)) bonuses.push(...converted);
    else if (converted !== null) bonuses.push(converted);
  }
  const conversions = conversionsOf(tech);
  const ignored = (tech.effects ?? [])
    .map((effect) => {
      const line = report.find(
        (candidate) =>
          candidate.startsWith(`${tech.id}: IGNORED`) &&
          candidate.includes(`${effect.type} -> ${effect.target}`),
      );
      return line
        ? {
            type: effect.type,
            target: effect.target,
            value: effect.value,
            reason: line.split("— ")[1] ?? "flagged",
          }
        : undefined;
    })
    .filter(Boolean);
  return {
    ...(existingByKey.get(tech.id) ?? {}),
    key: tech.id,
    name: tech.name,
    description:
      (tech.effects ?? [])
        .map((effect) => `${effect.type} ${effect.target} (${effect.value})`)
        .join("; ") || "A branch of study for the settlement.",
    age: tech.age,
    category: tech.category,
    prerequisites: [...(tech.prerequisites ?? [])],
    // The engine prices research globally; don't inject per-tech cost records.
    bonuses,
    unlocks: [...new Set(tech.unlockedUnits ?? [])],
    // Only emitted when a tech converts something: an empty array on all 172
    // entries is pure diff noise, and the loader defaults to `[]`.
    ...(conversions.length > 0 ? { conversions } : {}),
    ignored,
  };
});

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

writeFileSync(outputPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
writeFileSync(
  reportPath,
  [
    `techtree conversion report — ${new Date().toISOString()}`,
    `source: ${path.basename(sourcePath)} → ${path.relative(root, outputPath)}`,
    `techs: ${entries.length}, bonuses: ${entries.reduce((n, e) => n + e.bonuses.length, 0)}, ignored: ${report.length}`,
    "",
    ...report,
    "",
  ].join("\n"),
  "utf8",
);

console.log(`wrote ${path.relative(root, outputPath)} (${entries.length} entries)`);
console.log(`wrote ${path.relative(root, reportPath)} (${report.length} flagged effects)`);
console.log(`total bonuses: ${entries.reduce((n, e) => n + e.bonuses.length, 0)}`);
