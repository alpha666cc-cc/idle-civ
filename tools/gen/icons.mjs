// Vendoring script for unit icons (Milestone 8).
// Downloads game-icons.net SVGs (CC BY 3.0) for the unit roster into
// `public/units/`, normalises their fills to `currentColor`, writes
// `public/units/ATTRIBUTION.md`, and rewrites the `vendoredIcons` map between
// the @generated markers in `src/components/unitIcons.ts`.
//
// Candidates are bare file names validated against the full icon index
// (`tools/gen/icon-index.txt`, one `author/icon-name.svg` per line): explicit
// per-unit candidates first (unique across units), then tag-keyword matches,
// then duplicate reuse — units with no hit stay on the lucide fallback.
//
// Run: node tools/gen/icons.mjs   (needs network)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const indexFile = path.join(root, "tools", "gen", "icon-index.txt");
const unitsFile = path.join(root, "src", "game", "data", "units.json");
const outDir = path.join(root, "public", "units");
const mapFile = path.join(root, "src", "components", "unitIcons.ts");
const rawBase = "https://raw.githubusercontent.com/game-icons/icons/master/";

/** Authors checked first when a bare name matches several index paths. */
const preferredAuthors = [
  "lorc",
  "delapouite",
  "skoll",
  "carl-olsen",
  "irongamer",
  "darkzaitzev",
  "john-colburn",
  "cathelineau",
  "favian",
];

/** Explicit candidates per unit id (bare file names, any author). */
const candidates = {
  warrior: ["stone-axe.svg", "bearded-axe.svg", "stone-spear.svg", "club.svg"],
  slinger: ["sling.svg", "stone-sling.svg"],
  archer_prehist: ["bowman.svg", "archer.svg", "bow.svg"],
  wolf: ["wolf-head.svg", "howling-wolf.svg", "wolf-howl.svg", "fox.svg"],
  bear: ["bear-face.svg", "polar-bear.svg", "bear.svg"],
  canoe: ["canoe.svg", "boat-fishing.svg", "raft.svg"],
  spearman_bronze: ["spear-hook.svg", "spear-feather.svg", "spears.svg", "barbed-spear.svg"],
  axeman_bronze: ["stone-axe.svg", "bearded-axe.svg", "battle-gear.svg"],
  chariot_bronze: ["chariot.svg", "horse-head.svg", "horse.svg"],
  bowman_bronze: ["bowman.svg", "archery-target.svg", "arrow-cluster.svg"],
  trireme_bronze: ["trireme.svg", "galley.svg", "sailboat.svg"],
  catapult_ancient: ["catapult.svg", "onager.svg"],
  spearman_iron: ["spears.svg", "spear-hook.svg", "barbed-spear.svg"],
  swordsman_iron: ["crossed-swords.svg", "swordman.svg", "broadsword.svg", "gladius.svg"],
  chariot_iron: ["chariot.svg", "horse-head.svg"],
  cavalry_iron: ["horse-head.svg", "cavalry.svg", "knight-banner.svg"],
  war_galley_iron: ["galley.svg", "warship.svg", "sail.svg"],
  elephant_iron: ["elephant.svg", "mammoth.svg", "ox-head.svg"],
  ballista: ["crossbow.svg", "mounted-gun.svg", "arrow-cluster.svg"],
  quinquereme: ["galley.svg", "trireme.svg", "sail.svg"],
  legionary: ["roman-shield.svg", "roman-armour.svg", "roman-helmet.svg", "legion-fare.svg"],
  hoplite: ["spartan-helmet.svg", "greek-bust.svg", "corinthian-helmet.svg", "shield.svg"],
  companion: ["horse-head.svg", "cavalry.svg", "knight-banner.svg"],
  archer_classical: ["bowman.svg", "archer.svg", "arrow-cluster.svg"],
  onager: ["catapult.svg", "weight-crush.svg"],
  fire_ship: ["flame.svg", "fire-element.svg", "sail.svg"],
  assassin: ["backstab.svg", "hooded-figure.svg", "dagger.svg", "poison-bottle.svg"],
  trader_classical: ["trade.svg", "coins.svg", "sack.svg", "cargo-crane.svg"],
  knight: ["mounted-knight.svg", "knight-banner.svg", "knight-crest.svg", "shield.svg"],
  longbow: ["longbow.svg", "archer.svg", "bowman.svg"],
  crossbow: ["crossbow.svg", "crossed-swords.svg"],
  man_at_arms: ["chest-armor.svg", "armored-pants.svg", "shield.svg", "helmet.svg"],
  trebuchet: ["trebuchet.svg", "catapult.svg"],
  cog: ["sailboat.svg", "boat.svg", "wood-ship.svg"],
  longship: ["longboat.svg", "viking-longship.svg", "sail.svg", "oar.svg"],
  bombard: ["cannon.svg", "bomb.svg", "barrel.svg"],
  caravel: ["caravel.svg", "sailboat.svg", "boat.svg"],
  musketeer: ["rifle.svg", "musket.svg", "pistol-gun.svg"],
  pikeman_ren: ["pikeman.svg", "halberd.svg", "spears.svg"],
  dragoon_ren: ["pistol-gun.svg", "horse-head.svg", "cavalry.svg"],
  cuirassier: ["chest-armor.svg", "armor.svg", "knight-crest.svg"],
  cannon: ["cannon.svg", "gun-rose.svg"],
  galleon: ["galleon.svg", "warship.svg", "sail.svg"],
  frigate_sail: ["frigate.svg", "sailboat.svg", "warship.svg"],
  privateer: ["jolly-roger.svg", "pirate-flag.svg", "pirate-skull.svg"],
  line_infantry: ["rifle.svg", "bayonet.svg", "marching.svg"],
  rifleman: ["rifle.svg", "shotgun-round.svg", "pistol-gun.svg"],
  dragoon_ind: ["horse-head.svg", "rifle.svg", "cavalry.svg"],
  lancer: ["spear-hook.svg", "lance.svg", "horse-head.svg"],
  gatling: ["gatling-gun.svg", "minigun.svg", "mounted-gun.svg"],
  ironclad: ["ironclad.svg", "battleship.svg", "warship.svg"],
  zeppelin: ["zeppelin.svg", "air-balloon.svg", "hot-air-balloon.svg", "blimp.svg"],
  biplane: ["biplane.svg", "plane.svg", "propeller-plane.svg", "plane-wing.svg"],
  howitzer_ind: ["howitzer.svg", "artillery.svg", "cannon.svg"],
  sub_early: ["submarine.svg", "torpedo.svg"],
  ww1_infantry: ["rifle.svg", "trench.svg", "soldier-helmet.svg"],
  ww2_infantry: ["soldier-helmet.svg", "rifle.svg", "helmet.svg"],
  dragoon_mech: ["halftrack.svg", "jeep.svg", "tank.svg"],
  tank_ww2: ["tank.svg", "m4-tank.svg", "armored-car.svg"],
  fighter_ww2: ["plane-wing.svg", "plane.svg", "jet-fighter.svg"],
  bomber_ww2: ["bomber.svg", "plane-tail.svg", "plane.svg"],
  battleship: ["battleship.svg", "warship.svg", "ironclad.svg"],
  carrier_ww2: ["aircraft-carrier.svg", "carrier.svg", "warship.svg"],
  soldier_modern: ["soldier-helmet.svg", "soldier.svg", "rifle.svg"],
  tank_abrams: ["tank.svg", "armored-car.svg", "m4-tank.svg"],
  fighter_jet: ["jet-fighter.svg", "f-35.svg", "plane.svg"],
  destroyer_modern: ["destroyer.svg", "torpedo.svg", "warship.svg"],
  dragoon_modern: ["humvee.svg", "armored-car.svg", "tank.svg"],
  drone: ["drone.svg", "spy-drone.svg", "quadcopter.svg", "uav.svg"],
  attack_heli: ["helicopter.svg", "apache-helicopter.svg", "chopper.svg"],
  artillery_modern: ["artillery.svg", "howitzer.svg", "rocket-thumper.svg"],
  sub_nuclear: ["submarine.svg", "missile-swarm.svg", "torpedo.svg"],
  carrier_nuclear: ["aircraft-carrier.svg", "carrier.svg", "warship.svg"],
  special_forces: ["night-vision.svg", "soldier.svg", "commando.svg", "rifle.svg"],
  bomber_stealth: ["stealth-bomber.svg", "plane-wing.svg", "plane.svg"],
  satellite: ["satellite-communication.svg", "satellite.svg", "dish.svg"],
  orbital_laser: ["laser-blast.svg", "laser-warn.svg", "sun-spiral.svg"],
  mech_suit: ["mech.svg", "mecha-head.svg", "walker.svg", "robot-golem.svg"],
  starship: ["starfighter.svg", "spaceship.svg", "rocket.svg", "shuttle.svg"],
};

/** Tag → icon-name keyword fragments, used when no explicit candidate matches. */
const tagKeywords = {
  naval: ["ship", "boat", "sail", "galley", "trireme", "submarine", "torpedo", "warship"],
  air: ["plane", "jet", "wing", "zeppelin", "balloon", "helicopter", "drone", "propeller"],
  space: ["satellite", "rocket", "shuttle", "spaceship", "star", "orbit"],
  ranged: ["bow", "arrow", "archer", "crossbow", "sling", "rifle", "gun", "pistol", "gatling"],
  cavalry: ["horse", "knight", "cavalry", "rider"],
  armored: ["tank", "armor", "shield", "helmet", "cuirass", "chariot"],
  "anti-armor": ["catapult", "cannon", "trebuchet", "ballista", "artillery", "howitzer", "bomb", "laser"],
  beast: ["wolf", "bear", "elephant", "fox", "mammoth"],
  siege: ["catapult", "trebuchet", "siege"],
  infantry: ["sword", "spear", "axe", "soldier", "legion", "rifle", "helmet"],
};

function loadUnits() {
  const parsed = JSON.parse(fs.readFileSync(unitsFile, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed.units ?? parsed.definitions ?? [];
  return list.map((def) => ({ id: def.key ?? def.id, tags: def.tags ?? [] }));
}

const index = fs
  .readFileSync(indexFile, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const authorRank = (entryPath) => {
  const at = preferredAuthors.indexOf(entryPath.slice(0, entryPath.indexOf("/")));
  return at === -1 ? preferredAuthors.length : at;
};

const byName = new Map(); // bare name → author-ranked index paths
for (const entry of index) {
  const name = entry.slice(entry.indexOf("/") + 1);
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push(entry);
}
for (const paths of byName.values()) {
  paths.sort((a, b) => authorRank(a) - authorRank(b) || a.localeCompare(b));
}

/** Segment match: "arrow-cluster" contains the keyword "arrow". */
const nameMatches = (entryPath, keyword) =>
  entryPath
    .slice(entryPath.indexOf("/") + 1)
    .replace(/\.svg$/, "")
    .split("-")
    .includes(keyword);

const used = new Set();
const chosen = new Map(); // unitId → index path

for (const unit of loadUnits()) {
  let pick = null;
  for (const name of candidates[unit.id] ?? []) {
    const paths = byName.get(name) ?? [];
    pick = paths.find((p) => !used.has(p)) ?? null;
    if (pick) break;
  }
  if (!pick) {
    const keywords = (unit.tags ?? []).flatMap((tag) => tagKeywords[tag] ?? []);
    for (const keyword of keywords) {
      pick = index.filter((p) => nameMatches(p, keyword)).find((p) => !used.has(p)) ?? null;
      if (pick) break;
    }
  }
  if (!pick) {
    for (const name of candidates[unit.id] ?? []) {
      const paths = byName.get(name) ?? [];
      if (paths.length) {
        pick = paths[0]; // duplicate fallback: reuse another unit's icon
        break;
      }
    }
  }
  if (pick) {
    chosen.set(unit.id, pick);
    used.add(pick);
  } else {
    console.warn(`MISS  ${unit.id}: no icon found, lucide fallback`);
  }
}

async function download(entryPath, outFile) {
  const response = await fetch(rawBase + entryPath);
  if (!response.ok) throw new Error(`${response.status} for ${entryPath}`);
  let svg = await response.text();
  svg = svg.replace(/fill="#fff"|fill="white"/g, 'fill="currentColor"');
  fs.writeFileSync(outFile, svg, "utf8");
}

fs.mkdirSync(outDir, { recursive: true });
const attribution = [
  "# Unit icon attribution",
  "",
  "Unit icons come from [game-icons.net](https://game-icons.net/) — each is the",
  "property of its author and is used under the",
  "[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) licence.",
  "Fills are normalised to `currentColor`; no other modification is made.",
  "",
  "| Unit | Icon | Author | Source |",
  "| --- | --- | --- | --- |",
];
let ok = 0;
for (const [unitId, entryPath] of chosen) {
  const slash = entryPath.indexOf("/");
  const author = entryPath.slice(0, slash);
  const name = entryPath.slice(slash + 1);
  try {
    await download(entryPath, path.join(outDir, `${unitId}.svg`));
    ok += 1;
    attribution.push(
      `| \`${unitId}\` | ${name.replace(/\.svg$/, "")} | ${author} | https://game-icons.net/1x1/${author}/${name} |`,
    );
  } catch (error) {
    console.warn(`FAIL  ${unitId}: ${error.message}`);
    chosen.delete(unitId);
  }
}
attribution.push("", "With thanks to all game-icons.net contributors.");
fs.writeFileSync(path.join(outDir, "ATTRIBUTION.md"), attribution.join("\n"), "utf8");

// Rewrite the vendoredIcons map between the @generated markers.
const mapText = fs.readFileSync(mapFile, "utf8");
const beginMarker = "// @generated: vendoredIcons begin";
const endMarker = "// @generated: vendoredIcons end";
const begin = mapText.indexOf(beginMarker);
const end = mapText.indexOf(endMarker);
if (begin === -1 || end === -1) throw new Error("vendoredIcons markers not found");
const entries = [...chosen.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([unitId]) => `  "${unitId}": "${unitId}.svg",`)
  .join("\n");
const replacement = `${beginMarker}\nconst vendoredIcons: Record<string, string> = {\n${entries}\n};\n${endMarker}`;
fs.writeFileSync(
  mapFile,
  mapText.slice(0, begin) + replacement + mapText.slice(end + endMarker.length),
  "utf8",
);

const roster = loadUnits();
fs.writeFileSync(
  path.join(root, "temp", "icons-report.txt"),
  [...chosen.entries()].map(([id, p]) => `${id} <- ${p}`).join("\n") + "\n",
  "utf8",
);
console.log(`Vendored ${ok} files; ${chosen.size}/${roster.length} units mapped.`);
console.log(`Misses: ${roster.filter((u) => !chosen.has(u.id)).map((u) => u.id).join(", ") || "none"}`);
