// Research-tree converter: `temp/tech tree-v2-effects.json` → `src/game/data/research.json`.
//
// The v2 file is human-authored and not strict JSON (missing commas between
// adjacent effect objects), so it is lenient-parsed with one regex repair.
// Effect tiers use only "small" and "large" today; the medium tier is kept in
// the mapping so a future v3 file can adopt it without changes here.
//
// Mapping (user ruling):
//   cost small → ÷2, medium → ÷100, large/big → −0.01 cost scaling
//   production small → ×2 (food ×4), medium → ×10 (food ×20), large → ×100 (×200)
//   unit_stat_boost small → ×1.25, large → ×1.5 (multiplier)
//   unlock_unit → the definition's `unlocks` list (not a bonus)
//   Capacity/unsupported types are kept per entry under `ignored` with a
//   machine-readable reason — never silently dropped.
//
// Costs are not taken from the v2 file: techs are ordered topologically
// (prerequisites first, then source order) and cost 1K × 10^index science.
//
// Rerunnable: deterministic output; GUIDs are stamped afterwards by
// `node tools/gen/guids.mjs` (which derives them from file name + key).
//
// Run: node tools/gen/techtree.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

/** Point this at a future v3 file to regenerate the tree. */
const sourcePath = path.join(root, "temp", "tech tree-v2-effects.json");
const outputPath = path.join(root, "src", "game", "data", "research.json");
const reportPath = path.join(root, "temp", "techtree-flags.txt");

// ---------------------------------------------------------------------------
// Vocabulary read from the live game data
// ---------------------------------------------------------------------------

const units = JSON.parse(
  fs.readFileSync(path.join(root, "src", "game", "data", "units.json"), "utf8"),
);
const buildings = JSON.parse(
  fs.readFileSync(path.join(root, "src", "game", "data", "buildings.json"), "utf8"),
);
const unitIds = new Set(units.map((unit) => unit.id));
const buyableUnitIds = new Set(
  units.filter((unit) => (unit.costs ?? []).length > 0).map((unit) => unit.id),
);
const buildingKeys = new Set(buildings.map((building) => building.key));

/** v2 production_multiplier target → engine resource key. */
const productionTargetResource = {
  food: "food",
  wood: "wood",
  stone: "stone",
  gold: "gold",
  science: "science",
  metalwork: "metalwork",
};

/** Building key producing a resource (for production_multiplier targets). */
const buildingResource = {
  farm: "food",
  "lumber-yard": "wood",
  lumber_yard: "wood",
  quarry: "stone",
  "gold-mine": "gold",
  gold_mine: "gold",
  market: "gold",
  smithy: "metalwork",
};

/** v2 unit-stat target → engine bonus destination grammar. */
const unitStatTargets = {
  infantry_hp: "tag.infantry.hp",
  ranged_attack: "tag.ranged.attack",
  cavalry_attack: "tag.armored.attack",
  cavalry_speed: "tag.armored.speed",
  ship_attack: "tag.naval.attack",
  naval_defense: "tag.naval.hp",
  melee_defense: "unitAll.hp",
  unit_hp: "unitAll.hp",
  army_defense: "unitAll.hp",
  army_power: "unitAll.attack",
};

/** v2 cost-reduction group target → concrete buyable ids. */
const groupTargets = () => ({
  all: [...buildingKeys],
  military_units: [...buyableUnitIds],
  ranged_units: units.filter((u) => u.tags.includes("ranged")).map((u) => u.id),
  cavalry_units: units
    .filter((u) => u.tags.includes("armored") && u.domain === "ground")
    .map((u) => u.id),
  naval_units: units
    .filter((u) => u.tags.includes("naval") || u.domain === "naval")
    .map((u) => u.id),
  siege_units: units.filter((u) => u.tags.includes("anti-armor")).map((u) => u.id),
});

/** Tier values per effect type (user ruling; medium reserved for v3). */
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

const raw = fs.readFileSync(sourcePath, "utf8");
const fixed = raw.replace(/}\s*\n(\s*)\{/g, "},\n$1{");
const techs = JSON.parse(fixed);
console.log(`parsed ${techs.length} techs from ${path.basename(sourcePath)}`);


// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

const groups = groupTargets();
const report = [];
const flag = (tech, effect, reason) => {
  report.push(
    `${tech.id}: IGNORED ${effect.type} -> ${effect.target} (${effect.value}) — ${reason}`,
  );
};

const convertEffect = (tech, effect) => {
  const { type, target, value: tier } = effect;
  if (type === "unlock_unit") {
    if (!unitIds.has(target)) flag(tech, effect, "unknown unit id");
    return null; // carried via `unlocks`, not a bonus
  }
  if (type === "production_multiplier") {
    if (target === "house" || target === "town_hall") {
      flag(tech, effect, "capacity-adjacent — user review");
      return null;
    }
    if (target === "trade") {
      flag(tech, effect, "no trade system yet");
      return null;
    }
    if (target === "all") {
      return {
        type: "attributeMultiplier",
        destination: "all-production",
        value: String(tierValue.production_multiplier[tier]),
      };
    }
    const resource = productionTargetResource[target] ?? buildingResource[target];
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
  if (type === "global_production") {
    if (target === "trade") {
      flag(tech, effect, "no trade system yet");
      return null;
    }
    return {
      type: "attributeMultiplier",
      destination: "all-production",
      value: String(tierValue.production_multiplier[tier]),
    };
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
      if (buildingKeys.has(target)) {
        return { type: "costReductionPercent", destination: target, value: String(value) };
      }
      flag(tech, effect, "unmappable building target");
      return null;
    }
    if (type === "cost_reduction") {
      if (target === "dock" || target === "enhancers") {
        flag(tech, effect, "no such buyable (dock / enhancer cost path)");
        return null;
      }
      const ids = groups[target];
      if (!ids) {
        flag(tech, effect, "unknown cost group");
        return null;
      }
      return ids.map((id) => ({ type: "costReductionPercent", destination: id, value: String(value) }));
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
  if (type === "building_capacity" || type === "resource_capacity") {
    flag(tech, effect, "capacity — user review");
    return null;
  }
  const noSystem = {
    research_speed: "research purchase is instant; no speed mechanic",
    offline_cap: "offline tuning not research-driven",
    offline_efficiency: "offline tuning not research-driven",
    special_ability: "no such mechanic",
    convert_unit: "unit conversion not implemented",
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


// Topological order: prerequisites first, then source order among the free.
const byId = new Map(techs.map((tech) => [tech.id, tech]));
const ordered = [];
const done = new Set();
const visit = (tech) => {
  if (done.has(tech.id)) return;
  for (const prerequisite of tech.prerequisites ?? []) {
    const parent = byId.get(prerequisite);
    if (parent && !done.has(parent.id)) visit(parent);
  }
  done.add(tech.id);
  ordered.push(tech);
};
for (const tech of techs) visit(tech);
if (ordered.length !== techs.length) {
  throw new Error(`topological sort lost techs: ${techs.length - ordered.length}`);
}

const entries = ordered.map((tech, index) => {
  const bonuses = [];
  for (const effect of tech.effects ?? []) {
    const converted = convertEffect(tech, effect);
    if (Array.isArray(converted)) bonuses.push(...converted);
    else if (converted !== null) bonuses.push(converted);
  }
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
    key: tech.id,
    name: tech.name,
    description:
      (tech.effects ?? [])
        .map((effect) => `${effect.type} ${effect.target} (${effect.value})`)
        .join("; ") || "A branch of study for the settlement.",
    age: tech.age,
    category: tech.category,
    prerequisites: [...(tech.prerequisites ?? [])],
    costs: [
      {
        resource: "science",
        base: (1000 * Math.pow(10, index)).toExponential(10),
        factor: 1,
      },
    ],
    bonuses,
    unlocks: [...new Set(tech.unlockedUnits ?? [])],
    ignored,
  };
});

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

fs.writeFileSync(outputPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
fs.writeFileSync(
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
