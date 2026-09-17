/**
 * Battle campaign generator — Milestone 8 (see AGENTS.md §14).
 *
 * Authoring source: `temp/campaign_v2.json` (the hand-authored campaign).
 * Output: `src/game/data/encounters.json`, which is what the engine imports.
 *
 * Run: .\tools\node\node.exe tools\gen\battles.mjs
 *
 * What this does, in order:
 *   1. Trims the prototype schema: drops the population window, the authored
 *      player army, `ageName`/`nextAge`, and the prototype-only `allowedUnits`
 *      / `lockedUnits` lists. Keeps `age`, `year` and `isBoss`.
 *   2. Replaces dev-note descriptions with short original historical ones and
 *      formats the prototype's `historical` counts into one readable line.
 *   3. Rewrites `enemyArmy` as `{ unitId, count, label }` (the prototype's
 *      `represents` becomes `label`) and repairs the one enemy unit id that
 *      exists in no roster (`artillery_ww2` -> `howitzer_ind`).
 *   4. Derives each victory's `unlocks` (an explicit unit id list, §13.4): the
 *      opening battle opens the rest of the Ancient roster, and every age-end
 *      boss opens the whole next age.
 *   5. Normalises enemy armies to their battle's age by writing `enemyBoosts` —
 *      the "fake research" that keeps an older enemy army relevant. The boost is
 *      `sqrt(referenceQuality / unitQuality)` on hp and attack, only ever
 *      upwards and capped, so an age-appropriate army needs no boost.
 *   6. Gives every victory a permanent bonus: regular battles raise military
 *      production; bosses also raise every unit's hp and attack.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "temp/campaign_v2.json";
const UNIT_DATA = "src/game/data/units.json";
const OUTPUT = "src/game/data/encounters.json";
const UNIT_FIXES = { artillery_ww2: "howitzer_ind" };
const MAX_ENEMY_BOOST = 8;

/** Original short descriptions; year and enemy list are rendered from data. */
const text = {
  age0_1_first_fire: {
    name: "First Fire",
    description:
      "A hunting band drives a wolf pack away from the winter camp. The settlement fights as a group for the first time, and keeps the fire.",
  },
  age0_2_bronze_raid: {
    name: "Bronze Raid",
    description:
      "Bronze-armed raiders fall on the herds at the edge of the settlement. Whoever holds the field keeps the metal.",
  },
  age0_boss_troy: {
    name: "Fall of Troy",
    description:
      "A walled city finally falls after a long siege: the most famous ruin of the bronze age, and the end of the world that built it.",
  },
  age1_1_kadesh_iron: {
    name: "Kadesh",
    description:
      "Two chariot empires collide beside the Orontes in the largest chariot battle anyone remembers. Neither side wins, and both claim it.",
  },
  age1_2_assyrian_siege: {
    name: "Assyrian Siege",
    description:
      "The first army organised for empire: iron points, siege engines, and a deliberate reputation for cruelty.",
  },
  age1_boss_iron_collapse: {
    name: "The Sea Peoples",
    description:
      "Cities from the Aegean to the Levant fall to raiders arriving by sea. Whole systems collapse, and iron survives because it is cheap.",
  },
  age2_1_marathon: {
    name: "Marathon",
    description:
      "A smaller citizen army runs down a much larger one on a beach. The armoured line holds, and a messenger runs home with the news.",
  },
  age2_2_cannae: {
    name: "Cannae",
    description:
      "A double envelopment destroys a far larger army in a single afternoon: the classic lesson in refusing your own centre.",
  },
  age2_boss_gaugamela: {
    name: "Gaugamela",
    description:
      "A companion cavalry charge breaks a numerically superior imperial host on an open plain, and an empire changes hands.",
  },
  age3_1_tours: {
    name: "Battle of Tours",
    description:
      "Infantry formed in a defensive square hold a hillside against repeated cavalry charges.",
  },
  age3_2_hastings: {
    name: "Hastings",
    description:
      "A shield wall faces armoured cavalry and massed archers. A disputed crown is settled in one long day.",
  },
  age3_boss_castillon: {
    name: "Castillon",
    description:
      "Field cannon end the longbow's century of dominance, in the last battle of a hundred-year war.",
  },
  age4_1_pavia: {
    name: "Pavia",
    description:
      "Pikes and handguns shred a knightly charge. The armour that ruled the battlefield for centuries is suddenly obsolete.",
  },
  age4_2_lepanto: {
    name: "Lepanto",
    description:
      "Oared fleets fight it out in a narrow gulf: the last great galley battle in the Mediterranean.",
  },
  age4_boss_vienna: {
    name: "Vienna 1683",
    description:
      "A relief force breaks the siege of an imperial capital, and heavy cavalry with field guns finishes the work.",
  },
  age5_1_waterloo: {
    name: "Waterloo",
    description:
      "A single day of infantry squares, cavalry charges and massed artillery settles the fate of an empire.",
  },
  age5_2_gettysburg: {
    name: "Gettysburg",
    description:
      "Rifled muskets and massed artillery make the frontal assault suicidal. Three days decide where a war is going.",
  },
  age5_boss_somme: {
    name: "The Somme",
    description:
      "After a week of bombardment, an army gains a few miles for tens of thousands of casualties. Attrition becomes the strategy.",
  },
  age6_1_midway: {
    name: "Midway",
    description:
      "Aircraft carriers decide a naval war without the fleets ever sighting each other. Air power becomes the measure of a navy.",
  },
  age6_2_berlin_1945: {
    name: "Berlin 1945",
    description:
      "Tanks and infantry fight street by street through a capital as a war in Europe ends.",
  },
  age6_3_desert_storm: {
    name: "Desert Storm",
    description:
      "Precision air power and armoured manoeuvre defeat a much larger army in a hundred hours.",
  },
  age6_4_drone_war: {
    name: "Drone War",
    description:
      "Cheap unmanned aircraft watch and strike, and artillery becomes guided and disposable.",
  },
  age6_boss_orbital: {
    name: "Orbital War",
    description:
      "The last battle is directed from orbit, where nothing left on the ground can answer it.",
  },
};

const units = JSON.parse(readFileSync(UNIT_DATA, "utf8"));
const unitById = Object.fromEntries(units.map((unit) => [unit.id, unit]));
const battles = JSON.parse(readFileSync(SOURCE, "utf8"));

/** Combat quality: effective hit points times damage per round. */
const quality = (unit) =>
  (unit.hp / (1 - unit.armor)) * unit.attack * unit.accuracy;

/** Cost magnitude of a unit, so a roster can be listed cheapest-first. */
const costExponent = (unit) => {
  const raw = String(unit.costs[0].base);
  const match = raw.match(/e([+-]?\d+)$/i);
  return match ? Number(match[1]) : Math.log10(Number(raw));
};

/** Buyable units per age, cheapest cost first — the order they become affordable. */
const buyableByAge = new Map();
for (const unit of units) {
  if (unit.costs.length === 0) continue;
  const roster = buyableByAge.get(unit.age) ?? [];
  roster.push(unit);
  buyableByAge.set(unit.age, roster);
}
for (const roster of buyableByAge.values()) {
  roster.sort((a, b) => costExponent(a) - costExponent(b));
}

/** Unlocks: the opening battle opens its own age; every boss opens the next age. */
const startable = new Set(
  units.filter((unit) => unit.available).map((unit) => unit.id),
);
const unlocksFor = (battle, indexInAge) => {
  const ids = [];
  if (battle.age === 0 && indexInAge === 0) {
    for (const unit of buyableByAge.get(0) ?? []) {
      if (!startable.has(unit.id)) ids.push(unit.id);
    }
  }
  if (battle.isBoss) {
    for (const unit of buyableByAge.get(battle.age + 1) ?? []) {
      ids.push(unit.id);
    }
  }
  return ids;
};

/** Format the prototype's historical counts into one flavour line. */
const historicalLine = (historical) => {
  if (!historical) return undefined;
  const number = (value) =>
    typeof value === "number" ? value.toLocaleString("en-US") : String(value);
  return Object.entries(historical)
    .map(([label, value]) => `${label.replaceAll("_", " ")} ${number(value)}`)
    .join(" · ");
};

/** Reference quality for a battle: median quality of its age's buyable roster. */
const referenceQuality = (age) => {
  const roster = (buyableByAge.get(age) ?? []).map(quality).sort((a, b) => a - b);
  if (roster.length === 0) return undefined;
  return roster[Math.floor(roster.length / 2)];
};

/**
 * Enemy "fake research": an enemy unit older than its battle catches up to the
 * reference quality of the battle's age, so a bronze line still matters in an
 * iron-age fight. Same-age (and newer) enemy units are left exactly as authored;
 * the cap is one age's worth of catch-up (8 per stat ≈ 64× quality).
 */
const boostsFor = (enemyArmy, battle) => {
  const reference = referenceQuality(battle.age);
  const boosts = [];
  if (reference === undefined) return boosts;
  const seen = new Set();
  for (const stack of enemyArmy) {
    const unit = unitById[stack.unitId];
    if (!unit || seen.has(unit.id)) continue;
    seen.add(unit.id);
    if (unit.age >= battle.age) continue;
    const factor = Math.min(
      MAX_ENEMY_BOOST,
      Math.max(1, Math.sqrt(reference / quality(unit))),
    );
    if (factor <= 1.005) continue;
    const value = Math.round(factor * 100) / 100;
    for (const destination of [`${unit.id}.hp`, `${unit.id}.attack`]) {
      boosts.push({ type: "attributeMultiplier", destination, value });
    }
  }
  return boosts;
};

const FIRST_BATTLE = "age0_1_first_fire";

/** Victory rewards: a permanent production bump, or an army-wide one for bosses. */
const bonusesFor = (battle) =>
  battle.isBoss
    ? [
        { type: "attributeMultiplier", destination: "military", value: 1.1 },
        { type: "attributeMultiplier", destination: "unitAll.hp", value: 1.05 },
        {
          type: "attributeMultiplier",
          destination: "unitAll.attack",
          value: 1.05,
        },
      ]
    : [{ type: "attributeMultiplier", destination: "military", value: 1.05 }];

const indexInAge = new Map();
const output = battles.map((battle) => {
  const authored = text[battle.id];
  if (!authored) throw new Error(`Missing text for battle: ${battle.id}`);
  const index = indexInAge.get(battle.age) ?? 0;
  indexInAge.set(battle.age, index + 1);

  const enemyArmy = (battle.enemyArmy ?? []).map((stack) => ({
    unitId: UNIT_FIXES[stack.id] ?? stack.id,
    count: stack.count,
    label: stack.represents,
  }));
  for (const stack of enemyArmy) {
    if (!unitById[stack.unitId]) {
      throw new Error(`${battle.id}: unknown enemy unit ${stack.unitId}`);
    }
  }

  const unlocks = unlocksFor(battle, index);
  for (const id of unlocks) {
    if (!unitById[id]) throw new Error(`${battle.id}: unknown unlock ${id}`);
  }

  const bonuses = bonusesFor(battle);
  if (battle.id === FIRST_BATTLE) {
    bonuses.push({
      type: "attributeMultiplier",
      destination: "town-hallCapacity",
      value: 10,
    });
  }

  return {
    key: battle.id,
    name: authored.name,
    description: authored.description,
    age: battle.age,
    year: battle.year,
    isBoss: battle.isBoss === true,
    historical: historicalLine(battle.historical),
    enemyArmy,
    enemyBoosts: boostsFor(enemyArmy, battle),
    bonuses,
    unlocks,
  };
});

const unlockedOnce = new Map();
for (const battle of output) {
  for (const id of battle.unlocks) {
    if (unlockedOnce.has(id)) {
      throw new Error(`Unit ${id} unlocked by two battles`);
    }
    unlockedOnce.set(id, battle.key);
  }
}
const neverUnlocked = units
  .filter(
    (unit) => unit.costs.length > 0 && !unit.available && !unlockedOnce.has(unit.id),
  )
  .map((unit) => unit.id);
if (neverUnlocked.length > 0) {
  throw new Error(`Buyable units never unlocked: ${neverUnlocked}`);
}

for (const battle of output) {
  const armies = battle.enemyArmy
    .map((stack) => `${stack.unitId} x${stack.count}`)
    .join(", ");
  const boosts = [
    ...new Set(battle.enemyBoosts.map(({ destination }) => destination.split(".")[0])),
  ].join(" ");
  console.log(
    `${battle.isBoss ? "BOSS" : "    "} ${battle.key} (age ${battle.age}, ${battle.year}) | ${armies} | +${boosts || "-"} | unlocks ${battle.unlocks.length}`,
  );
}
console.log(
  `battles ${output.length} | bosses ${output.filter(({ isBoss }) => isBoss).length} | units unlocked by victories ${unlockedOnce.size}`,
);

writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`wrote ${OUTPUT}`);