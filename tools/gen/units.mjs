/**
 * Unit roster generator — Milestone 8 (see AGENTS.md §14).
 *
 * Authoring source: `temp/unit100-v3.json` (the hand-authored roster).
 * Output: `src/game/data/units.json`, which is what the engine imports.
 *
 * Run: .\tools\node\node.exe tools\gen\units.mjs
 *
 * Two roster-wide tuning rules are applied here, never in the engine:
 *   1. `STAT_SCALE_PER_AGE` multiplies `hp` and `attack` by 8 per age, so one
 *      unit of a newer age is worth roughly 52 units of the previous one under
 *      the square law (3 ages ≈ 4,400). Tactical stats — accuracy, range, speed
 *      — stay bounded on purpose: they decide who can shoot whom, not how hard.
 *   2. Unit costs use factor 5 by default; the Age-0 Tribesman and Bronze
 *      infantry bands use factors 4 and 3. Age-0 base costs are listed below.
 *
 * A unit's `available` flag is the inverse of the authored `locked` flag: the
 * tribesman is buyable from the start, everything else is unlocked by a battle
 * victory (the explicit `unlocks` list on an encounter, AGENTS.md §13.4).
 */
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "temp/unit100-v3.json";

/**
 * Age-0 tier bands. Bronze infantry buys scale more slowly, while the starting
 * Tribesman has a deliberately flatter first rank. All cost entries in one unit
 * share the same factor; sources from later ages are not modified here.
 */
const AGE_ZERO_COSTS = {
  warrior: [
    { resource: "military", base: 150 },
    { resource: "food", base: 5_000 },
  ],
  canoe: [
    { resource: "military", base: 25_000 },
    { resource: "wood", base: 400_000 },
  ],
  spearman_bronze: [
    { resource: "military", base: 100_000 },
    { resource: "metalwork", base: 5_000 },
  ],
  axeman_bronze: [
    { resource: "military", base: 300_000 },
    { resource: "metalwork", base: 20_000 },
  ],
};
const DEFAULT_COST_FACTOR = 5;
const AGE_ZERO_FACTORS = {
  warrior: 4,
  spearman_bronze: 3,
  axeman_bronze: 3,
};
const costsFor = (unit) => AGE_ZERO_COSTS[unit.id] ?? unit.costs ?? [];
const factorFor = (unit) => AGE_ZERO_FACTORS[unit.id] ?? DEFAULT_COST_FACTOR;

const OUTPUT = "src/game/data/units.json";
const STAT_SCALE_PER_AGE = 8;

/** Original one-line flavour text; the mechanical facts are rendered from data. */
const descriptions = {
  warrior: "Hunter-spearmen with fire-hardened pikes. The first defenders of the settlement, and its last resort.",
  slinger: "Whirls a river stone at anything within a few paces. Quick to raise, easy to replace.",
  archer_prehist: "Flint-tipped arrows fly further than any thrown stone, and can reach a bird in flight.",
  wolf: "Hunts in a pack and closes fast. Nothing a trained line cannot handle, and nothing a lone hunter can.",
  bear: "Half a ton of muscle and claw. Slow to rouse, and it does not stop when it is hurt.",
  canoe: "A dugout hull for river and coast. Carries a raiding party, and nothing heavier.",
  spearman_bronze: "Bronze heads on long shafts, braced against cavalry. The point is meant for armour.",
  axeman_bronze: "Heavy bronze axes for close work; no shield line survives them for long.",
  chariot_bronze: "Two horses, a driver and a fighting platform. Terrifying in the open, useless in a bog.",
  bowman_bronze: "Bronze-tipped arrows in massed volleys. Cheap damage at a safe distance.",
  trireme_bronze: "Bronze-age galley packed with rowers and a ram at the waterline.",
  catapult_ancient: "Torsion artillery that lobs stones over a wall and through a shield line.",
  spearman_iron: "Iron-pointed pikes for the phalanx. Cheaper than bronze and harder to blunt.",
  swordsman_iron: "Short iron blade and a big shield; the workhorse of the first iron armies.",
  chariot_iron: "An iron-age chariot with a heavier crew and a longer reach than its bronze ancestor.",
  cavalry_iron: "Riders who fight from the saddle rather than riding to the fight. Speed is the armour.",
  war_galley_iron: "A decked galley with an iron-shod ram, built to sink rather than to board.",
  elephant_iron: "A war elephant with a howdah on its back. Breaks a line by weight alone.",
  ballista: "Bolt-throwing engine on a wooden frame. Long range, slow to reload, indifferent to arrows.",
  quinquereme: "Five banks of oars and a reinforced bow; the heaviest ram afloat in its age.",
  legionary: "Drilled infantry who can hold a line, throw, and rotate under pressure.",
  hoplite: "Shield-wall infantry with a long spear and heavy panoply. Unbeaten head-on.",
  companion: "Companion cavalry: the decisive shock charge aimed at a gap, not the front.",
  archer_classical: "Composite bow shooting from a horse or a hill; range and mobility together.",
  onager: "Arm-throwing engine that arcs a stone into a fortified position.",
  fire_ship: "A hull packed with pitch and set alight, steered into an enemy fleet.",
  assassin: "A single blade in the right tent. Fragile, fast, and lethal to a commander.",
  trader_classical: "A trade galley with wide holds and a small crew. Barely fights, but sails anywhere.",
  knight: "Plate armour, a lance and a destrier. The dominant shock arm of its age.",
  longbow: "Yew bows with a high draw weight: massed arrow storms at long range.",
  crossbow: "Slow to span, but a bolt punches through mail at close range.",
  man_at_arms: "Professional infantry with mail, spear and poleaxe; the core of a medieval host.",
  trebuchet: "Counterweight engine that drops a stone onto a wall from far beyond bowshot.",
  cog: "Broad-hulled trader turned transport. Carries an army's baggage and its horses.",
  longship: "Shallow-draught hull that rows up a river and beaches without a harbour.",
  bombard: "Early gunpowder artillery, enormous and slow, built to break stone gates.",
  caravel: "Lateen-sailed hull that can beat upwind; explores and raids far from home.",
  musketeer: "Black-powder volleys in ranks. Terrifying to cavalry, helpless in the rain.",
  pikeman_ren: "Pike and shot's other half: a hedge of points that keeps cavalry at bay.",
  dragoon_ren: "Mounted infantry who ride to the fight and shoot from the ground on arrival.",
  cuirassier: "Heavy cavalry in steel breastplates, charging home in a single mass.",
  cannon: "Mobile field gun with an iron barrel. Shreds formations and siege works alike.",
  galleon: "Ocean-going hull with heavy timbers and a broadside of guns.",
  frigate_sail: "Fast sailing warship built for escort, patrol and raiding rather than the line.",
  privateer: "A licensed raider: light guns, deep holds, and a crew paid in plunder.",
  line_infantry: "Bayoneted muskets and formal drill. Holds a line by discipline alone.",
  rifleman: "Rifled barrels and aimed fire; kills at ranges the old muskets only hoped for.",
  dragoon_ind: "Mounted infantry with modern carbines: mobility plus firepower.",
  lancer: "Horse cavalry with a long lance, still useful in the charge's last decades.",
  gatling: "Hand-cranked multibarrel gun. Devastating in a fixed position, quick to jam.",
  ironclad: "Iron-plated hull with a revolving turret and no sails at all.",
  zeppelin: "Rigid airship for observation and night bombing. Slow, huge, and vulnerable.",
  biplane: "Canvas and wire fighter; it owns the air until something faster appears.",
  howitzer_ind: "Indirect-fire artillery that drops shells into trenches behind a ridge.",
  sub_early: "A petrol-driven boat that attacks unseen, and sinks if it is seen.",
  ww1_infantry: "Bolt-action rifle, entrenching tool and gas mask; a war of attrition in one soldier.",
  ww2_infantry: "Semi-automatic rifles, grenades and radios: the first fully modern foot soldier.",
  dragoon_mech: "Halftrack-borne infantry: they arrive with the armour and fight with it.",
  tank_ww2: "Medium tank with an all-round turret; armour becomes an arm of decision, not infantry support.",
  fighter_ww2: "Piston fighter with self-sealing tanks and heavy machine guns; escorts what it fights.",
  bomber_ww2: "Heavy four-engine bomber. Carries a city's worth of ordnance, and needs a fighter screen.",
  battleship: "Steel hull, armour belt and 16-inch rifles. A fleet is built around it.",
  carrier_ww2: "A flight deck on a hull. Its punch is the aircraft it carries, not its guns.",
  soldier_modern: "Assault rifle, body armour and a radio: one soldier who is also a sensor.",
  tank_abrams: "Composite-armour main battle tank with a stabilised gun that hits on the move.",
  fighter_jet: "Supersonic multirole jet with radar-guided missiles. Owns the air outright.",
  destroyer_modern: "Guided-missile destroyer: air defence, anti-submarine work and precision strikes in one hull.",
  dragoon_modern: "Armoured cavalry with thermal sights: scouts, screens and flank guards for the tank force.",
  drone: "Unmanned aircraft loitering overhead, finding targets and striking them from above.",
  attack_heli: "Rotary-wing gunship that hunts armour from behind a treeline.",
  artillery_modern: "Multiple-launch rocket system. One salvo covers a grid square, and then it moves.",
  sub_nuclear: "Nuclear attack submarine. Stays under for months and sinks what it is sent for.",
  carrier_nuclear: "Nuclear-powered carrier: an airbase that sails, with the escorts to survive it.",
  special_forces: "Small teams behind the lines. Trains, bridges and commanders disappear.",
  bomber_stealth: "Radar-absorbent flying wing. Arrives before anyone knows it is over the border.",
  satellite: "Military satellite: it watches, listens and directs. Nothing can reach it at all.",
  orbital_laser: "Orbital beam platform. Reaches anything on the far side of the planet.",
  mech_suit: "One pilot in layered armour carrying a cannon. Walks through whatever it is aimed at.",
  starship: "A trooper that flies and fights in vacuum, carrying a division's firepower in one suit.",
};

const units = JSON.parse(readFileSync(SOURCE, "utf8"));

const normalized = units.map((unit) => {
  const description = descriptions[unit.id];
  if (description === undefined) {
    throw new Error(`Missing description for unit: ${unit.id}`);
  }
  const scale = STAT_SCALE_PER_AGE ** unit.age;
  return {
    id: unit.id,
    name: unit.name,
    description,
    age: unit.age,
    domain: unit.domain,
    tags: unit.tags,
    canHit: unit.canHit,
    bonusVs: unit.bonusVs ?? [],
    hp: Math.round(unit.hp * scale),
    attack: Math.round(unit.power * scale),
    armor: unit.armor,
    range: unit.range,
    speed: unit.speed,
    accuracy: unit.accuracy,
    available: !unit.locked,
    costs: costsFor(unit).map(({ resource, base }) => ({
      resource,
      base,
      factor: factorFor(unit),
      exponent: 0.5,
    })),
  };
});

const ids = normalized.map(({ id }) => id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length > 0) throw new Error(`Duplicate unit ids: ${duplicates}`);
const staleDescriptions = Object.keys(descriptions).filter(
  (id) => !ids.includes(id),
);
if (staleDescriptions.length > 0) {
  throw new Error(`Descriptions for unknown units: ${staleDescriptions}`);
}

/** Combat quality: effective hit points times damage per round. */
const quality = (unit) =>
  (unit.hp / (1 - unit.armor)) * unit.attack * unit.accuracy;
const beats = (older, newer) =>
  Math.round(Math.sqrt(quality(newer) / quality(older)));

console.log(
  `units ${normalized.length} | stat scale x${STAT_SCALE_PER_AGE}/age | ` +
    `cost factor ${DEFAULT_COST_FACTOR} (age 0: ${JSON.stringify(AGE_ZERO_FACTORS)})`,
);
for (let age = 0; age <= 6; age += 1) {
  const roster = normalized.filter((unit) => unit.age === age);
  console.log(
    `  age ${age}: ${roster.length} units, hp ${roster[0].hp}..${roster[roster.length - 1].hp}, attack ${roster[0].attack}..${roster[roster.length - 1].attack}`,
  );
}
const byId = Object.fromEntries(normalized.map((unit) => [unit.id, unit]));
console.log("cross-age dominance (units beaten by one of the newer type):");
for (const [older, newer] of [
  ["line_infantry", "tank_ww2"],
  ["caravel", "battleship"],
  ["legionary", "tank_abrams"],
  ["warrior", "starship"],
]) {
  console.log(
    `  ${older} (a${byId[older].age}) vs ${newer} (a${byId[newer].age}): ${beats(byId[older], byId[newer])}`,
  );
}
console.log(
  `buyable from the start: ${normalized.filter(({ available }) => available).map(({ id }) => id).join(", ")}`,
);
console.log(
  `enemy-only (no costs): ${normalized.filter(({ costs }) => costs.length === 0).map(({ id }) => id).join(", ")}`,
);

writeFileSync(OUTPUT, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
console.log(`wrote ${OUTPUT}`);