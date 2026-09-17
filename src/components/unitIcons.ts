import type { LucideIcon } from "lucide-react";
import {
  Bird,
  Castle,
  Crosshair,
  Flame,
  Plane,
  Rocket,
  Shield,
  Ship,
  Swords,
  Wind,
  Zap,
} from "lucide-react";

/**
 * Unit presentation: exactly one icon per unit (Milestone 8).
 *
 * Vendored game-icons.net SVGs live in `public/units/<file>.svg` (CC BY 3.0 —
 * see `public/units/ATTRIBUTION.md`). `vendoredIcons` maps a unit id to its
 * file name; `tools/gen/icons.mjs` rewrites that map when it vendors icons.
 * A unit without a vendored icon falls back to a lucide role icon chosen from
 * its tags, so a missing file can never break the Army tab or the Gamepedia.
 */
// @generated: vendoredIcons begin
const vendoredIcons: Record<string, string> = {
  "archer_classical": "archer_classical.svg",
  "archer_prehist": "archer_prehist.svg",
  "artillery_modern": "artillery_modern.svg",
  "assassin": "assassin.svg",
  "attack_heli": "attack_heli.svg",
  "axeman_bronze": "axeman_bronze.svg",
  "ballista": "ballista.svg",
  "battleship": "battleship.svg",
  "bear": "bear.svg",
  "biplane": "biplane.svg",
  "bombard": "bombard.svg",
  "bomber_stealth": "bomber_stealth.svg",
  "bomber_ww2": "bomber_ww2.svg",
  "bowman_bronze": "bowman_bronze.svg",
  "cannon": "cannon.svg",
  "canoe": "canoe.svg",
  "caravel": "caravel.svg",
  "carrier_nuclear": "carrier_nuclear.svg",
  "carrier_ww2": "carrier_ww2.svg",
  "catapult_ancient": "catapult_ancient.svg",
  "cavalry_iron": "cavalry_iron.svg",
  "chariot_bronze": "chariot_bronze.svg",
  "chariot_iron": "chariot_iron.svg",
  "cog": "cog.svg",
  "companion": "companion.svg",
  "crossbow": "crossbow.svg",
  "cuirassier": "cuirassier.svg",
  "destroyer_modern": "destroyer_modern.svg",
  "dragoon_ind": "dragoon_ind.svg",
  "dragoon_mech": "dragoon_mech.svg",
  "dragoon_modern": "dragoon_modern.svg",
  "dragoon_ren": "dragoon_ren.svg",
  "drone": "drone.svg",
  "elephant_iron": "elephant_iron.svg",
  "fighter_jet": "fighter_jet.svg",
  "fighter_ww2": "fighter_ww2.svg",
  "fire_ship": "fire_ship.svg",
  "frigate_sail": "frigate_sail.svg",
  "galleon": "galleon.svg",
  "gatling": "gatling.svg",
  "hoplite": "hoplite.svg",
  "howitzer_ind": "howitzer_ind.svg",
  "ironclad": "ironclad.svg",
  "knight": "knight.svg",
  "lancer": "lancer.svg",
  "legionary": "legionary.svg",
  "line_infantry": "line_infantry.svg",
  "longbow": "longbow.svg",
  "longship": "longship.svg",
  "man_at_arms": "man_at_arms.svg",
  "mech_suit": "mech_suit.svg",
  "musketeer": "musketeer.svg",
  "onager": "onager.svg",
  "orbital_laser": "orbital_laser.svg",
  "pikeman_ren": "pikeman_ren.svg",
  "privateer": "privateer.svg",
  "quinquereme": "quinquereme.svg",
  "rifleman": "rifleman.svg",
  "satellite": "satellite.svg",
  "slinger": "slinger.svg",
  "soldier_modern": "soldier_modern.svg",
  "spearman_bronze": "spearman_bronze.svg",
  "spearman_iron": "spearman_iron.svg",
  "special_forces": "special_forces.svg",
  "starship": "starship.svg",
  "sub_early": "sub_early.svg",
  "sub_nuclear": "sub_nuclear.svg",
  "swordsman_iron": "swordsman_iron.svg",
  "tank_abrams": "tank_abrams.svg",
  "tank_ww2": "tank_ww2.svg",
  "trader_classical": "trader_classical.svg",
  "trebuchet": "trebuchet.svg",
  "trireme_bronze": "trireme_bronze.svg",
  "war_galley_iron": "war_galley_iron.svg",
  "warrior": "warrior.svg",
  "wolf": "wolf.svg",
  "ww1_infantry": "ww1_infantry.svg",
  "ww2_infantry": "ww2_infantry.svg",
  "zeppelin": "zeppelin.svg",
};
// @generated: vendoredIcons end

const roleIcon = (tags: readonly string[]): LucideIcon => {
  if (tags.includes("space")) return Rocket;
  if (tags.includes("air")) return Plane;
  if (tags.includes("naval")) return Ship;
  if (tags.includes("siege")) return Castle;
  if (tags.includes("ranged")) return Crosshair;
  if (tags.includes("cavalry")) return Wind;
  if (tags.includes("beast") || tags.includes("animal")) return Bird;
  if (tags.includes("support")) return Shield;
  if (tags.includes("fire")) return Flame;
  if (tags.includes("fast")) return Zap;
  return Swords;
};

export type UnitIcon =
  | { kind: "vendored"; url: string }
  | { kind: "lucide"; Icon: LucideIcon };

/** Resolve a unit's icon: vendored SVG when available, lucide role icon otherwise. */
export const unitIcon = (unitId: string, tags: readonly string[]): UnitIcon => {
  const file = vendoredIcons[unitId];
  if (file) return { kind: "vendored", url: `/units/${file}` };
  return { kind: "lucide", Icon: roleIcon(tags) };
};

/** Tone class shared with the existing colour vocabulary in styles.css. */
export const unitTone = (tags: readonly string[]): string => {
  if (tags.includes("air") || tags.includes("space")) return "violet";
  if (tags.includes("naval")) return "blue";
  if (tags.includes("ranged")) return "green";
  if (tags.includes("cavalry")) return "amber";
  if (tags.includes("siege")) return "orange";
  return "red";
};
