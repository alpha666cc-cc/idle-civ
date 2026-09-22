// Battle minimum-army simulator (dev-only, temp/ scratch).
// Run: .\tools\node\node.exe temp\min-army.mjs
// 1. pick a battle, 2. uncheck units to exclude (battle age + previous age),
// 3. prints the minimum-military-cost winning army + full resource cost.
// Player units use BASE stats; enemy uses JSON enemyBoosts. Variance (0.8-1.0)
// is replaced by its mean (0.9), so results are deterministic/conservative.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ExpNumber } from "../src/game/expNumber.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const units = readJson("src/game/data/units.json");
const battles = readJson("src/game/data/encounters.json");
const research = readJson("src/game/data/research.json");
const byId = new Map(units.map((u) => [u.id, u]));
const researchById = new Map(research.map((r) => [r.key, r]));

const researchClosure = (researchId, seen = new Set()) => {
  if (seen.has(researchId)) return [];
  const tech = researchById.get(researchId);
  if (!tech) return [];
  seen.add(researchId);
  return [
    ...(tech.prerequisites ?? []).flatMap((id) => researchClosure(id, seen)),
    researchId,
  ];
};

const researchIdsForBattle = (battle, unitIds) => {
  const ids = new Set(
    research.filter((tech) => tech.age < battle.age).map((tech) => tech.key),
  );
  for (const unitId of unitIds) {
    const unlockers = research.filter((tech) =>
      (tech.unlocks ?? []).includes(unitId),
    );
    const shortest =
      unlockers
        .map((tech) => researchClosure(tech.key))
        .sort((left, right) => left.length - right.length)[0] ?? [];
    shortest.forEach((id) => ids.add(id));
  }
  return research.filter((tech) => ids.has(tech.key));
};

const candidatesForBattle = (battle, _battleIndex) => {
  const ageBattles = battles.filter(({ age }) => age === battle.age);
  const ordinal = ageBattles.findIndex(({ key }) => key === battle.key);
  const current = units.filter(
    (unit) => (unit.costs ?? []).length > 0 && unit.age === battle.age,
  );
  const previous = units.filter(
    (unit) => (unit.costs ?? []).length > 0 && unit.age === battle.age - 1,
  );
  if (battle.age === 0 && ordinal === 0) {
    return units.filter((unit) => unit.id === "warrior");
  }
  if (battle.isBoss) return [...previous, ...current];
  if (ordinal === 0) return [...previous, ...current.slice(0, 2)];
  if (ordinal === 1)
    return [...previous, ...current.slice(0, Math.ceil(current.length / 2))];
  return [...previous, ...current];
};

const latestCombatUnitId = (battle) =>
  units
    .filter(
      (unit) =>
        (unit.costs ?? []).length > 0 &&
        unit.age === battle.age &&
        battle.enemyArmy.some((stack) => {
          const target = byId.get(stack.unitId);
          if (!target || !(unit.canHit ?? []).includes(target.domain))
            return false;
          if (
            (unit.domain === "naval" && target.domain === "ground") ||
            (unit.domain === "ground" && target.domain === "naval")
          )
            return unit.range >= 7;
          return target.domain !== "air" || unit.range > 1;
        }),
    )
    .at(-1)?.id;

const unitStrengthScale = (unit) => {
  const military = (unit.costs ?? []).find(
    (cost) => cost.resource === "military",
  );
  if (!military) return 1;
  return Math.max(1, ExpNumber.from(military.base).log10() / 3);
};

const scaledUnit = (unit) => {
  const scale = unitStrengthScale(unit);
  return {
    ...unit,
    hp: unit.hp * scale,
    attack: unit.attack * scale,
  };
};

const MAX_ROUNDS = 200;
const START_DISTANCE = 20;
const SHORE_RANGE = 7;
const BONUS_VS = 1.5;
const MAX_ARMOR = 0.9;
const VARIANCE_MEAN = 0.9;

const effHp = (u) => u.hp / (1 - Math.min(u.armor, MAX_ARMOR));
const canReach = (att, tgt, distance) => {
  if (!att.canHit.includes(tgt.domain)) return false;
  if (distance > att.range) return false;
  if (tgt.domain === "air" && att.range <= 1) return false;
  if (
    (att.domain === "naval" && tgt.domain === "ground") ||
    (att.domain === "ground" && tgt.domain === "naval")
  )
    return att.range >= SHORE_RANGE;
  return true;
};
const matchup = (att, tgt) => {
  let m = 1;
  if ((att.bonusVs ?? []).some((tag) => (tgt.tags ?? []).includes(tag)))
    m *= BONUS_VS;
  if (att.domain === "air" && tgt.domain === "naval") m *= 1.2;
  if (att.domain === "naval" && tgt.domain === "ground") m *= 0.8;
  if (tgt.domain === "air" && att.range <= 1) m *= 0.3;
  return m;
};
const hitChance = (att, distance) =>
  Math.max(
    0.05,
    Math.min(1, att.accuracy * (1 - Math.min(1, distance / att.range) * 0.3)),
  );
const boosted = (unit, boosts) => {
  let hp = unit.hp;
  let attack = unit.attack;
  let armor = unit.armor;
  let range = unit.range;
  let speed = unit.speed;
  let accuracy = unit.accuracy;
  for (const b of boosts ?? []) {
    if (b.type !== "attributeMultiplier" && b.type !== "attributeFlat")
      continue;
    const parts = b.destination.split(".");
    const target = parts.length === 3 ? parts.slice(0, 2).join(".") : parts[0];
    const stat = parts.at(-1);
    const matches =
      target === unit.id ||
      target === "unitAll" ||
      (target.startsWith("tag.") && unit.tags?.includes(target.slice(4)));
    if (
      !matches ||
      !["hp", "attack", "armor", "range", "speed", "accuracy"].includes(stat)
    )
      continue;
    const value = Number(b.value);
    const apply = (current) =>
      b.type === "attributeFlat" ? current + value : current * value;
    if (stat === "hp") hp = apply(hp);
    if (stat === "attack") attack = apply(attack);
    if (stat === "armor") armor = apply(armor);
    if (stat === "range") range = apply(range);
    if (stat === "speed") speed = apply(speed);
    if (stat === "accuracy") accuracy = apply(accuracy);
  }
  return { ...unit, hp, attack, armor, range, speed, accuracy };
};
const simulate = (composition, enemyStacks, boosts, playerBoosts = []) => {
  const player = [...composition.entries()]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => {
      const def = boosted(scaledUnit(byId.get(id)), playerBoosts);
      return { def, count: n, pool: effHp(def) * n };
    });
  const enemy = enemyStacks.map((s) => {
    const def = boosted(scaledUnit(byId.get(s.unitId)), boosts);
    return { def, count: s.count, pool: effHp(def) * s.count };
  });
  const order = [...player, ...enemy].sort((a, b) => b.def.speed - a.def.speed);
  const living = (f) =>
    f.pool <= 0 ? 0 : Math.min(f.count, Math.ceil(f.pool / effHp(f.def)));
  const isPlayer = (f) => player.includes(f);
  let distance = START_DISTANCE;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (!player.some((f) => living(f) > 0) || !enemy.some((f) => living(f) > 0))
      break;
    for (const att of order) {
      const n = living(att);
      if (n <= 0) continue;
      const foes = (isPlayer(att) ? enemy : player).filter(
        (f) => living(f) > 0 && canReach(att.def, f.def, distance),
      );
      if (foes.length === 0) continue;
      const target = foes.reduce((a, b) => (b.pool < a.pool ? b : a), foes[0]);
      target.pool = Math.max(
        0,
        target.pool -
          n *
            att.def.attack *
            hitChance(att.def, distance) *
            VARIANCE_MEAN *
            matchup(att.def, target.def),
      );
    }
    const fastest = order.reduce(
      (m, f) => (living(f) > 0 ? Math.max(m, f.def.speed) : m),
      0,
    );
    distance = Math.max(1, distance - Math.max(1, Math.floor(fastest / 2)));
  }
  const p = player.some((f) => living(f) > 0);
  const e = enemy.some((f) => living(f) > 0);
  if (p && !e) return "player";
  if (e && !p) return "enemy";
  return "stalemate";
};
const unitCost = (unit, count) => {
  const total = {};
  for (const c of unit.costs ?? []) {
    const first = ExpNumber.from(c.base);
    const factor = ExpNumber.fromNumber(c.factor);
    const sum =
      c.factor === 1
        ? first.mul(ExpNumber.fromNumber(count))
        : first
            .mul(factor.pow(count).sub(ExpNumber.ONE))
            .div(factor.sub(ExpNumber.ONE));
    total[c.resource] = (total[c.resource] ?? ExpNumber.ZERO).add(sum.ceil());
  }
  return total;
};
const armyCost = (composition) => {
  const total = {};
  for (const [id, n] of composition) {
    const c = unitCost(byId.get(id), n);
    for (const [r, v] of Object.entries(c)) {
      total[r] = (total[r] ?? ExpNumber.ZERO).add(v);
    }
  }
  return total;
};
const militaryCost = (composition) =>
  armyCost(composition).military ?? ExpNumber.ZERO;
const fmtNum = (n) => {
  if (!(n instanceof ExpNumber)) n = ExpNumber.fromNumber(n);
  if (n.isZero) return "0";
  if (n.exponent >= 3) {
    const suffixes = ["K", "M", "B", "T"];
    const tier = Math.floor(n.exponent / 3) - 1;
    const scaled = n.mantissa * 10 ** (n.exponent % 3);
    return `${scaled.toFixed(2)}${suffixes[tier] ?? `e${n.exponent}`}`;
  }
  return `${Math.ceil(n.toNumber())}`;
};
const wins = (composition, enemy, boosts, playerBoosts) =>
  simulate(composition, enemy, boosts, playerBoosts) === "player";
// Search: cheapest solo winner per unit (binary search), then mixed
// hill-climb (swap expensive units for cheap ones), then trim each stack.
const solve = (
  candidates,
  enemy,
  boosts,
  onProgress,
  requireMixed = false,
  requiredUnitId,
  battleAge,
) => {
  const battleWins = (composition) => {
    const playerBoosts = researchIdsForBattle({ age: battleAge }, [
      ...composition.keys(),
    ]).flatMap((tech) => tech.bonuses ?? []);
    return wins(composition, enemy, boosts, playerBoosts);
  };
  let best = null;
  for (const unit of candidates) {
    let lo = 1;
    let hi = 1;
    while (!battleWins(new Map([[unit.id, hi]]))) {
      hi *= 2;
      if (hi > 1e7) break;
    }
    if (hi > 1e7) continue;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (battleWins(new Map([[unit.id, mid]]))) hi = mid;
      else lo = mid + 1;
    }
    const comp = new Map([[unit.id, lo]]);
    const cost = militaryCost(comp);
    if (!requireMixed && (!best || cost.lt(best.military))) {
      best = { composition: comp, military: cost };
    }
    onProgress?.(`solo ${unit.id} x${lo} (${fmtNum(cost)} military)`);
  }

  if (requireMixed) {
    const anchors = requiredUnitId
      ? candidates.filter((unit) => unit.id === requiredUnitId)
      : candidates;
    for (const unit of anchors) {
      let lo = 1;
      let hi = 1;
      while (!battleWins(new Map([[unit.id, hi]]))) {
        hi *= 2;
        if (hi > 1e7) break;
      }
      if (hi > 1e7) continue;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (battleWins(new Map([[unit.id, mid]]))) hi = mid;
        else lo = mid + 1;
      }
      for (const other of candidates) {
        if (other.id === unit.id) continue;
        const base = new Map([[unit.id, Math.ceil(lo / 2)]]);
        let add = 1;
        while (add <= 1e7) {
          const trial = new Map(base);
          trial.set(other.id, add);
          if (battleWins(trial)) {
            const candidate = {
              composition: trial,
              military: militaryCost(trial),
            };
            if (!best || candidate.military.lt(best.military)) best = candidate;
            break;
          }
          add *= 2;
        }
      }
    }
  }
  if (!best) return null;
  const ids = candidates.map((u) => u.id);
  let improved = true;
  let passes = 0;
  while (improved && passes < 3) {
    improved = false;
    passes += 1;
    for (const [id, n] of [...best.composition]) {
      for (const other of ids) {
        if (other === id) continue;
        const base = new Map(best.composition);
        base.set(id, Math.ceil(n / 2));
        if (base.get(id) <= 0) base.delete(id);
        let add = 1;
        let found = false;
        while (add <= 1e7) {
          const trial = new Map(base);
          trial.set(other, (trial.get(other) ?? 0) + add);
          if (battleWins(trial)) {
            found = true;
            break;
          }
          add *= 2;
        }
        if (!found) continue;
        let lo = 1;
        let hi = add;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          const t2 = new Map(base);
          t2.set(other, (base.get(other) ?? 0) + mid);
          if (battleWins(t2)) hi = mid;
          else lo = mid + 1;
        }
        const next = new Map(base);
        next.set(other, (next.get(other) ?? 0) + lo);
        if (
          next.size >= (requireMixed ? 2 : 1) &&
          militaryCost(next).lt(best.military) &&
          battleWins(next)
        ) {
          best = { composition: next, military: militaryCost(next) };
          improved = true;
        }
      }
    }
  }
  for (const [id, n] of [...best.composition]) {
    if (id === requiredUnitId) continue;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const t = new Map(best.composition);
      if (mid <= 0) t.delete(id);
      else t.set(id, mid);
      if (battleWins(t)) hi = mid;
      else lo = mid + 1;
    }
    if (lo <= 0) {
      if (!requireMixed || best.composition.size > 2) {
        best.composition.delete(id);
      }
    } else best.composition.set(id, lo);
  }
  best.military = militaryCost(best.composition);
  return best;
};

const useInteractive = process.stdin.isTTY === true;
const rl = useInteractive
  ? createInterface({ input: process.stdin, output: process.stdout })
  : null;
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
// Non-interactive: node temp/min-army.mjs <battle#> [excludedIds...]

const main = async () => {
  const args = process.argv.slice(2);
  const nonInteractive = args.length > 0;
  const pickBattle = async () => {
    if (nonInteractive) return battles[Number(args[0])];
    return battles[Number(await ask("\nWhich battle (number)? "))];
  };
  const pickExcluded = async () => {
    if (nonInteractive) {
      const list = (args[1] ?? "").split(",").map((s) => Number(s.trim()));
      return new Set(list.filter((n) => Number.isInteger(n)));
    }
    return new Set(
      (await ask("\nExclude: "))
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n)),
    );
  };
  console.log("=== Minimum-army simulator ===\n");
  battles.forEach((b, i) => {
    console.log(
      `${String(i).padStart(2, " ")}. [age ${b.age}] ${b.name} (${b.key})`,
    );
  });
  const battle = await pickBattle();
  if (!battle) {
    console.log("Unknown battle number.");
    rl?.close();
    return;
  }
  const candidates = candidatesForBattle(battle, Number(args[0]));
  console.log(
    `\nBattle: ${battle.name} — enemy: ${battle.enemyArmy.map((s) => `${s.unitId} x${s.count}`).join(", ")}`,
  );
  console.log(
    `Candidate units (age ${battle.age} + previous age). [x] = included.`,
  );
  console.log("Enter comma-separated numbers to EXCLUDE (empty = keep all):");
  candidates.forEach((u, i) => {
    const mil = u.costs.find((c) => c.resource === "military");
    console.log(
      `${String(i).padStart(2, " ")}. [x] ${u.name} (${u.id}, age ${u.age}, mil base ${mil ? fmtNum(Number(mil.base)) : "-"})`,
    );
  });
  const excluded = await pickExcluded();
  const allowed = candidates.filter((_, i) => !excluded.has(i));
  if (allowed.length === 0) {
    console.log("All units excluded — nothing to search.");
    rl?.close();
    return;
  }
  rl?.close();
  console.log(`\nSearching over ${allowed.length} units...`);
  const enemyResearchBoosts = researchIdsForBattle(
    battle,
    battle.enemyArmy.map((stack) => stack.unitId),
  ).flatMap((tech) => tech.bonuses ?? []);
  const result = solve(
    allowed,
    battle.enemyArmy,
    [...enemyResearchBoosts, ...(battle.enemyBoosts ?? [])],
    (l) => console.log(`  ${l}`),
    args[2] === "mixed",
    battle.isBoss ? latestCombatUnitId(battle) : undefined,
    battle.age,
  );
  if (!result) {
    console.log("\nNo winning army found with these units.");
    return;
  }
  const full = armyCost(result.composition);
  const requiredResearch = researchIdsForBattle(battle, [
    ...result.composition.keys(),
  ]);
  console.log(`\n=== Minimum army to defeat ${battle.name} ===`);
  for (const [id, n] of result.composition) {
    const u = byId.get(id);
    console.log(`  ${u.name} (${id}) x${n}`);
  }
  console.log("\nTotal cost:");
  for (const [resource, amount] of Object.entries(full)) {
    console.log(`  ${resource}: ${fmtNum(amount)}`);
  }
  console.log(`\nRequired research (${requiredResearch.length}):`);
  console.log(`  ${requiredResearch.join(", ") || "none"}`);
  console.log(`\nMilitary (optimized): ${fmtNum(result.military)}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
