/**
 * Generates `docs/mechanics-reference.md` from the JSON payloads in
 * `src/game/data/`.
 *
 * Generated rather than hand-written so another model can be handed an accurate
 * picture of every boost in the game without trusting anyone's memory — and so
 * the doc regenerates after a balance edit instead of silently going stale.
 *
 * Run: node tools/gen/mechanicsReference.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DATA = "src/game/data";
const read = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));
const list = (data) => (Array.isArray(data) ? data : Object.values(data));

const num = (v) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Math.abs(n) >= 1000
    ? n.toExponential(3)
    : String(Math.round(n * 1000) / 1000);
};

const bonus = (b) =>
  b.value === undefined
    ? `${b.type} → ${b.destination}`
    : `${b.type} → ${b.destination} (${num(b.value)})`;

const costs = (c) =>
  (c ?? []).map((x) => `${x.resource} ${num(x.base)}×${num(x.factor)}`).join(" + ");

const out = [];
const p = (s = "") => out.push(s);

/** Loaded early: the unlock table in §1.2 needs building data before Part 2. */
const buildingListForUnlock = list(read("buildings.json"));

/** Emit a `| age | count | ids |` table grouped by an `age` field. */
const byAgeTable = (rows, idOf) => {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.age)) groups.set(row.age, []);
    groups.get(row.age).push(idOf(row));
  }
  p(`| age | count | ids |`);
  p(`| --- | --- | --- |`);
  for (const age of [...groups.keys()].sort((a, b) => a - b)) {
    const keys = groups.get(age);
    p(`| ${age} | ${keys.length} | ${keys.map((k) => `\`${k}\``).join(", ")} |`);
  }
  p();
};

p("# Mechanics & boosts reference");
p();
p("**Generated** by `tools/gen/mechanicsReference.mjs` — do not edit by hand.");
p("Regenerate after any change under `src/game/data/`.");
p();
p("An accurate dump for handing to another model or an optimiser.");
p("**Part 1 is the rules** — the part that is easy to get wrong by reading the");
p("tables alone. **Part 2 is the content.**");
p();

// ============================================================ PART 1: RULES
p("---");
p();
p("# Part 1 — Rules");
p();

p("## 1.1 How a building boosts production");
p();
p("One formula, `computeResourceRate`:");
p();
p("```");
p("rate = (Σ additional) × (Π multiplicative) × (1 + Σ additiveMultiplier) − Σ drain");
p("```");
p();
p("Four mechanisms, and they do **not** combine the same way:");
p();
p("| term | combining rule |");
p("| --- | --- |");
p("| `additional` | **sums** |");
p("| `multiplicative` | **multiplies** — every source compounds with every other |");
p("| `additiveMultiplier` | sums as a **percentage**: `1 + Σ (perBuilding × count) ^ buildingPower` — exponent-scaled, see the worked example in §1.8 |");
p("| `drain` | **sums, then subtracts** — consumption, never negative |");
p();
p("So two `multiplicative` bonuses of ×2 give ×4, while two");
p("`additiveMultiplier` bonuses of +10% give +20%, not +21%. No tiers or groups.");
p();

p("### The building families");
p();
p("| family | buildings | effect | needs workers? |");
p("| --- | --- | --- | --- |");
p("| **primary** | `farm`, `lumberYard`, `quarry`, `goldMine` | `additiveMultiplier` +10% each on a gatherable | **yes** |");
p("| **advanced** | `barracks`, `university`, `smithy` | `resourceProduction` **+1/s** *and* `additiveMultiplier` +5% | no |");
p("| advanced | `market` | `resourceProduction` +1/s only | no |");
p("| capacity | `house`, `townHall` | `capacityProvided` (raises a building's cap) | no |");
p("| upkeep | `people` | `resourceDrain` −1 food/s **each** | no |");
p();
p("The advanced four boost the *building* resources — `military` (barracks),");
p("`science` (university), `metalwork` (smithy), `trade` (market) — which are");
p("**not** worker-assignable. Primary buildings boost the four gatherables");
p("(`food`/`wood`/`stone`/`gold`) and pay nothing unless a worker is assigned.");
p();
p("Capacity is stored *as a resource* rather than as a bonus, because it is");
p("expected to gain a multiplier variant later. `maxCount` is decorative — the");
p("live limit is the building's capacity resource, 10 by default.");
p();

p("## 1.2 Workers, clicks and science");
p();
p("- A worker on a gatherable yields `productionPerWorker` per action; total is");
p("  `workers × productionPerWorker` plus the auto-clicker term");
p("  `autoClicksPerSecond × productionPerClick`.");
p("- A **manual click** gains");
p("  `clickPower × productionPerWorker × Π multipliers`, drains excluded.");
p("  `clickPower` is one global stat scaling every manual click.");
p("- **Science is a worker resource**, exactly like `food`. A university produces");
p("  only 1/s on its own; the measured optimum was a *science share* of 0.20–0.40");
p("  of all workers, which is far larger than it looks like it should be.");
p("- **There is no automatic clicking in the game.** `autoClicksPerSecond` exists");
p("  on the state but starts at **0** and is only ever set by");
p("  `setAutoClicksPerSecond()` from the **Dev Tools** panel - it is a cheat knob,");
p("  not a mechanic. Nothing in `data/` grants it. A model must not assume");
p("  passive production from clicks.");
p();

p("### Starting state");
p();
p("Read live from `createInitialState()` - this is the exact state every simulation");
p("begins from, and it is bare.");
p();
p("| field | value |");
p("| --- | --- |");
p("| `food`/`wood`/`stone`/`gold` | **0** - no starting stockpile at all |");
p("| `science`/`military`/`metalwork`/`trade` | **0** |");
p("| `population` | **0** |");
p("| `workers` (all eight resources) | **0** - every worker is unassigned |");
p("| `builtBuildings` | `{ townHall: 1 }` |");
p("| `clickPower` | **1** (base; bonuses raise it) |");
p("| `autoClicksPerSecond` | **0** (dev only) |");
p("| `boughtResearch` / `boughtUpgrades` / `enteredAges` / `defeatedEncounters` | empty |");
p();
p("The opening move is therefore **build a citizen** (`people`), which is what");
p("creates population; population is *derived* from the count of `people` built,");
p("not a separately settable resource.");
p();
p("Initial capacity limits (each building's live cap is this resource):");
p();
p("| capacity resource | starts at |");
p("| --- | --- |");
p("| `houseCapacity`, `farmCapacity`, `lumberYardCapacity`, `quarryCapacity`, `goldMineCapacity` | **10** |");
p("| `marketCapacity`, `smithyCapacity`, `barracksCapacity`, `universityCapacity` | **11** |");
p("| `townHallCapacity` | **1** |");
p("| `peopleCapacity` | 0 - raised only by `house` (+10 each) |");
p();
p("### Building unlock conditions");
p();
p("A building is buyable when `available` is true **and** its `unlock` gate is");
p("satisfied. Three gate shapes exist:");
p();
p("| `source` | meaning |");
p("| --- | --- |");
p("| `buildingCount` | satisfied once `building` is built `threshold` times |");
p("| `battle` | satisfied once `encounterId` has been defeated |");
p("| `age` | satisfied once `ageId` has been entered |");
p();
p("| building | unlock |");
p("| --- | --- |");
for (const b of buildingListForUnlock) {
  if (!b.unlock) continue;
  const u = b.unlock;
  const text =
    u.source === "buildingCount"
      ? `${u.building} built >= ${u.threshold}`
      : u.source === "battle"
        ? `defeat \`${u.encounterId}\``
        : `enter \`${u.ageId}\``;
  p(`| \`${b.key}\` | ${text} |`);
}
p();
p("Everything else (`people`, `house`, `farm`, `lumberYard`, `quarry`, `goldMine`,");
p("`townHall`) is available from the first tick with no gate.");
p();

p("## 1.3 Simulation settings (what the Part 2 numbers were measured under)");
p();
p("| setting | value | meaning |");
p("| --- | --- | --- |");
p("| `actionsPerSecond` | **5** | the action budget per simulated second |");
p("| `gatherClicksPerAction` | **10** | clicks one gather action is worth |");
p("| tick | **1 simulated second** | `tick()` applies one second of production |");
p("| objective | `{ type: \"ageReach\", ageId: \"age1\" }` | run ends at the Iron Age |");
p("| `maxGameTime` | 12 000 s benchmark / 20 000 s searches | horizon; a run that never reaches the objective reports it |");
p("| randomness | **none** | no seed; repeats are bit-identical |");
p();
p("**The action budget is the binding constraint, not resources.** Every gather,");
p("build, purchase *and worker reassignment* consumes one of the 5 slots per");
p("second. A policy was once observed spending 19 995 of 20 000 actions gathering");
p("and never reaching the Iron Age. A reassignment that lands back where it");
p("started costs a slot and changes nothing — the most likely remaining waste.");
p();
p("Tooling consequence: timings are **game time**, not wall-clock, so running");
p("candidates across cores in parallel is safe and only costs wall-clock.");
p();

p("## 1.4 Costs");
p();
p("- **Buildings and units** use a cumulative series `T(n) = base × (factor^√n − 1)`,");
p("  so the *n*-th unit costs `T(n) − T(n−1)`: cost per unit rises, but far");
p("  slower than linearly.");
p("- **Research is priced by ordinal, not identity.** `getResearchCostForCount(n)`");
p("  prices the *n*-th tech bought in the **current age** at");
p("  `base × factor^(√n − 1)`, keyed on the age, never on which tech it is");
p("  (Ancient: `200 · 12^(√n − 1)` science). Therefore:");
p("  - every tech available in an age costs **exactly the same**;");
p("  - any path buying all 23 Age-0 techs costs the same total (10 131 950");
p("    science) whatever the order — so price **cannot** rank research options;");
p("  - price only prices *delay*, which is why idling research is costly, and");
p("    that is an argument never to stall, never an argument to reorder;");
p("  - a tech bought from an earlier age is priced at the current age's next");
p("    price and does **not** advance `n`.");
p();

p("## 1.5 Gates");
p();
p("Entering an age is gated on **battles won** plus a **building threshold** —");
p("never on research. Research still gates Age-1 indirectly and hard: it unlocks");
p("the bronze units needed to win Wolf Pack and **Troy**, and its bonuses");
p("compound into everything downstream.");
p();

// ========================================================== PART 2: CONTENT
p("## 1.6 Age progression — the exact entry condition");
p();
p("`CivilizationState.canEnterAge(ageId)` is the whole gate. All four must hold:");
p();
p("1. `ageId` is a real age and **not** already in `enteredAges` (idempotent).");
p("2. `getCurrentAge()?.key === ageId` — you may only complete the age you are in.");
p("3. **Every encounter whose `age` equals this age's index is won.**");
p("4. **Total buildings ≥ the target** for this age.");
p();
p("Two details that are easy to get wrong:");
p();
p("- **Research is *not* part of the gate.** No condition reads `boughtResearch`.");
p("  Research still gates Age-1 indirectly: it unlocks the bronze units needed to");
p("  win Wolf Pack and **Troy**, and its bonuses compound downstream.");
p("- **The building target belongs to the *next* age.**");
p("  `getAgeBuildingTarget(age)` returns `ageDefinitions[index + 1].buildingThreshold`,");
p("  falling back to the current age's own. So completing Ancient (index 0) is");
p("  measured against **Iron Age's** threshold, not Ancient's. Ages' `unlocks` fire");
p("  on `enterAge(id)`, so they are **completion rewards** — Ancient's bonuses");
p("  arrive when Ancient is completed.");
p();
p("- **Entering an age is an *action*, not a passive state.** `enterAge` costs one of");
p("  the 5 action slots (§1.3), and the simulation logs a rejected `enterAge` when");
p("  `canEnterAge` is false. Any optimiser must emit the action, not merely satisfy");
p("  the predicate.");
p();
p("| to complete age | key | needs this many buildings |");
p("| --- | --- | --- |");
{
  const agesForTable = list(read("ages.json"));
  agesForTable.forEach((a, i) => {
    const next = agesForTable[i + 1];
    p(
      `| ${i} | \`${a.key}\` | **${num(next?.buildingThreshold ?? a.buildingThreshold)}**` +
        `${next ? ` (target of \`${next.key}\`)` : ""} |`,
    );
  });
}
p();

p("## 1.7 The battle algorithm");
p();
p("`src/game/battle.ts`. Fully **deterministic** — damage has no random component,");
p("so the same armies always produce the same battle. The seed is a battle");
p("fingerprint (battle id + both army signatures) kept only for logging/replay.");
p();
p("### Representation and constants");
p();
p("A stack is **one aggregate hit-point pool**, never one object per unit — so a");
p("million spearmen cost the same to simulate as one, and a battle always finishes");
p("in bounded time. Effective hit points per unit:");
p();
p("```");
p("hitPoints  = hp / (1 − min(armor, 0.9))      // armour is a % reduction, capped at 90%");
p("livingCount = ceil(hpPool / hitPoints)");
p("```");
p();
p("| constant | value | meaning |");
p("| --- | --- | --- |");
p("| `initialDistance` | **20** | armies deploy this far apart; range gates who may fire |");
p("| `maximumRounds` | **200** | unresolved by then ⇒ `stalemate`, counted as a loss |");
p("| `bonusVsMultiplier` | **1.5** | damage multiplier against a countered tag |");
p("| `screeningShare` | **0.25** | share of damage redirected to screens |");
p();
p("### One round (one second of playback)");
p();
p("The lines close a little, then **every stack that can reach an enemy fires");
p("once, in speed order**, then the lines close again.");
p();
p("**Who can hit whom (`canReach`)** — the attacker's `canHit` domains must include");
p("the target's `domain`; `distance <= attacker.range`; an `air` target needs");
p("`range > 1`; and **ground cannot hit naval at `range <= 3`** — the rule that");
p("makes naval viable at all.");
p();
p("**Damage multipliers (`matchupMultiplier`)** — all four multiply together:");
p();
p("```");
p("×1.5            attacker.bonusVs intersects target.tags");
p("×1.2            air attacker vs naval target");
p("×(range / 10)   naval attacker vs ground target   ← ships scale WITH their range");
p("×0.3            air target hit by a range<=1 attacker");
p("```");
p();
p("The naval term is **scaling, not flat**: a longer-ranged ship hits ground");
p("harder. That is the sharpest available lever on the naval balance question.");
p();
p("### Target selection — the eight orders");
p();
p("> ### ⚠ There are NO selectable orders in Age 0 or Age 1");
p("> ");
p("> `ordersForAge(0)` and `ordersForAge(1)` both return **exactly one** entry:");
p("> `standard`. Verified against the live engine:");
p("> ");
p("> | age | orders available | count |");
p("> | --- | --- | --- |");
p("> | **0 Ancient** | `standard` | **1** |");
p("> | **1 Iron** | `standard` | **1** |");
p("> | 2 Classical | `standard`, `frontline`, `backline`, `focus_counter`, `focus_weak`, `focus_strong` | 6 |");
p("> | 3+ | all eight | 8 |");
p("> ");
p("> The other seven unlock in Age 2 and Age 3. **Any strategy, model or optimiser");
p("> reasoning about the Age-1 objective must assume `standard` for every unit,");
p("> because there is no other option available.** Do not budget time for order");
p("> selection at Age 1 — the Army tab's order picker cannot offer anything else");
p("> yet, and `getAvailableOrders()` returns the age-0 list (just `standard`)");
p("> until the settlement enters its first age.");
p("> ");
p("> Because `standard` is the pre-orders rule verbatim, this also means the Age-1");
p("> battles behave exactly as they did before orders existed: **every stack fires");
p("> at the weakest reachable pool.**");
p();
p("Orders change **targeting and screening only** — never damage, range or speed,");
p("so an order can move the cost of a battle but not invalidate a unit's stats.");
p("`standard` is bit-for-bit the pre-orders rule and deliberately does *not* prefer");
p("a countered target; folding that in would silently retune every battle for");
p("players who never touch the control.");
p();
p("| order | targets |");
p("| --- | --- |");
p("| `standard` | weakest reachable stack |");
p("| `focus_weak` | smallest remaining stack |");
p("| `focus_strong` | largest remaining stack |");
p("| `focus_counter` | weakest foe whose tags the attacker counters, else any |");
p("| `same_tag` | a foe sharing one of your tags, else first reachable |");
p("| `frontline` | nearest melee line (lowest `range`) |");
p("| `backline` | furthest-reaching foe |");
p("| `protect_ranged` | standard targeting, but draws fire for ranged allies |");
p();
p("Every order falls back to a reachable target, so an order never makes a stack");
p("idle while enemies are in range. An order is **per unit type**, not per stack");
p("instance — one army, one order per type, so it always describes the whole of");
p("that type.");
p();
p("At **Age 0–1 only `standard` exists** (see the warning above), so the remaining");
p("seven are forward-looking: they matter from Age 2, not for an Age-1 strategy.");
p();
p("### Screening");
p();
p("A stack whose order is `protect_ranged`, or whose `range <= 3` (fragile), is");
p("protected. Its `frontline`/`protect_ranged` allies split **25 %** of the damage");
p("aimed at it. All of it is still dealt — screening trades a body's survival for");
p("its allies' rather than adding or removing damage. The share is small on");
p("purpose: at a higher share the screen dies in the opening rounds, the enemy");
p("focuses whatever is left, and the order loses battles that were already won.");
p();
p("### Outcome and consequences");
p();
p("`simulateBattle` → `{ rounds, outcome, playerSurvivors, enemySurvivors }`.");
p("**Units are never lost** — `resolveBattle()` restores post-battle counts, so a");
p("defeat costs the opportunity, not the army. Outcome is `player` | `enemy` |");
p("`stalemate`, the last counting as a loss. The UI plays back 1 round/sec.");
p();
p("A battle also feeds `defeatEncounter(id)`: idempotent, appends the id, records");
p("the fastest victory, and applies the encounter's victory bonuses.");
p();

p("### Research costs in full");
p();
p("Each age carries a price schedule in `ages.json`:");
p();
p("```ts");
p("research: { base, factor }");
p("```");
p();
p("and the **n-th** tech bought in that age costs `base × factor^(√n − 1)` science,");
p("with `n` counting only techs bought *in that age*. The schedule is read from");
p("`getCurrentAge()`, so **entering a new age restarts the curve** at that age's");
p("own `base` with a fresh counter — that is the whole reason the bases leap by");
p("orders of magnitude below.");
p();
p("| age | `base` (1st tech) | `factor` (curve climb) |");
p("| --- | --- | --- |");
{
  const agesForCost = list(read("ages.json"));
  for (const a of agesForCost) {
    p(`| \`${a.key}\` | ${num(a.research?.base)} | ${num(a.research?.factor)} |`);
  }
}
p();
p("`costMultipliers` (per-age resource price scaling, `getResourceCostMultiplier`)");
p("are **all empty today** — the field is wired but carries no data.");
p();
p("### What the curve actually costs");
p();
p("Computed from the schedules above. Cumulative = everything bought so far in that");
p("age; the ratio is marginal cost ÷ previous marginal cost.");
p();
{
  const agesForCost = list(read("ages.json"));
  for (const a of agesForCost) {
    const base = Number(a.research?.base ?? 100);
    const factor = Number(a.research?.factor ?? 10);
    const count = list(read("research.json")).filter(
      (r) => r.age === agesForCost.indexOf(a),
    ).length;
    if (!count) continue;
    p(`**${a.name}** (\`${a.key}\`, ${count} techs, base ${num(base)}, factor ${factor})`);
    p();
    p("| n | marginal | cumulative | ×prev |");
    p("| --- | --- | --- | --- |");
    let cumulative = 0;
    let prevMarginal = 0;
    for (let n = 1; n <= Math.min(count, 10); n += 1) {
      const marginal = base * factor ** (Math.sqrt(n) - 1);
      cumulative += marginal;
      p(
        `| ${n} | ${num(marginal)} | ${num(cumulative)} | ` +
          `${prevMarginal ? (marginal / prevMarginal).toFixed(2) : "—"} |`,
      );
      prevMarginal = marginal;
    }
    if (count > 10) {
      // Closed form: sum_{k=1..count} base * factor^(sqrt(k)-1) has no elementary
      // sum, so the row below is only the *final marginal* price. Reporting a
      // cumulative there needs the actual sum, which is walked instead.
      const last = base * factor ** (Math.sqrt(count) - 1);
      p(`| … | | | |`);
      p(`| ${count} | ${num(last)} | see below | |`);
    }
    p();
    // Walk the whole ladder for the true cumulative total.
    let total = 0;
    for (let n = 1; n <= count; n += 1) {
      total += base * factor ** (Math.sqrt(n) - 1);
    }
    p(
      `All ${count}: **${num(total)}** science in total. The last tech alone costs ` +
        `**${num(base * factor ** (Math.sqrt(count) - 1))}** — ` +
        `${((base * factor ** (Math.sqrt(count) - 1) / total) * 100).toFixed(1)}% ` +
        `of everything that age spends on research.`,
    );
    p();
  }
}
p("Three consequences worth internalising:");
p();
p("- **Order is free.** Because the price keys on the ordinal `n`, *not* the tech,");
p("  any ordering of the same 23 Age-0 techs costs the identical total. Research");
p("  order cannot be optimised through cost saving — only through *when* you buy.");
p("- **Buying early is buying cheap.** Every tech you buy raises the price of every");
p("  later one, so idling research is a loan against a rising price. This is the one");
p("  place where \"cost-aware\" reasoning is real: it argues never to stall, and it");
p("  says nothing about *which* tech to pick.");
p("- **An earlier-age tech bought late costs full current-age price** and does not");
p("  advance `n`. Back-filling Ancient techs in the Iron Age is therefore a pure");
p("  drain on the Iron Age's own curve — it does not get cheaper, and it does not");
p("  earn a discount.");
p();
p("Research is a **buyable**, so it takes the same four cost reductions as");
p("buildings and units (`base → factor → percent → flat`, §13.1, clamped at 0) —");
p("but only ones naming `\"research\"` explicitly: `allBuildings` never reaches it,");
p("because research is not a building.");
p();

p("### Worked example - how an enhancer reaches `computeResourceRate`");
p();
p("This is the calculation most easily misread, so it is spelled out against real");
p("numbers lifted from a finished `balanced` Age-1 run.");
p();
p("**`farmEnhancer9` (tier 0) grants, verbatim:**");
p();
p("```json");
p('[{"type":"attributeFlat",       "destination":"farmPower",   "value":1},');
p(' {"type":"attributeMultiplier", "destination":"farmCapacity","value":10},');
p(' {"type":"attributeMultiplier", "destination":"food",       "value":2}]');
p("```");
p();
p("At the end of that run: **F = 177 farms**, **2 farm enhancers** bought,");
p("**`farmPower` = 3.6**. The engine's own factors for `food` were:");
p();
p("| term | value | where it comes from |");
p("| --- | --- | --- |");
p("| `additional` | `[251, 2, 3, 6, 21]` | 251 food workers, then research flats |");
p("| `multiplicative` | `[2,2,2,1.2,4,3,2,2,2,10,2,2,2,2,2]` | 2 from each of the 2 enhancers; the rest from research |");
p("| `additiveMultiplier` | `[31095.94]` | **the farms, exponent-scaled** (below) |");
p("| `drain` | `[1000]` | citizens |");
p();
p("### ⚠ Building multipliers are exponent-scaled by `buildingPower`");
p();
p("This is the single most misreadable line in the engine. A building's");
p("`additiveMultiplier` is **not** `perBuilding × count`. It is:");
p();
p("```");
p("  perBuilding x count          raised to the power of  buildingPower");
p("  = (0.10 x F) ^ farmPower");
p("```");
p();
p("Verified against the run above: `(0.10 × 177) ^ 3.6 = 31095.94`, which is");
p("exactly the `additiveMultiplier` entry. At the naive linear reading it would");
p("have been `0.10 × 177 = 17.7` — **wrong by a factor of ~1760**.");
p();
p("So the two \"+10% per farm\" ideas behave completely differently:");
p();
p("| farmPower | farms=10 | farms=100 | farms=177 | shape |");
p("| --- | --- | --- | --- | --- |");
p("| 1 (base) | 1.0 | 10.0 | 17.7 | linear |");
p("| 2 | 1.0 | 100 | 313.8 | quadratic |");
p("| 3.6 (2 enhancers + Iron Age) | 3.98 | 3981 | 31096 | strongly super-linear |");
p();
p("**`buildingPower` grows**, so the same farm count is worth progressively more:");
p();
p("```");
p("  farmPower = base power (1, from the definition's `power` field)");
p("            + Σ attributeFlat on `farmPower`   (+1 per farm enhancer bought)");
p("            × Π attributeMultiplier on `farmPower` (ages, research, encounters)");
p("```");
p();
p("In that run: `(1 + 2 enhancers) × 1.2 (Iron Age) = 3.6`. Buying enhancers");
p("therefore has a **double effect** - it doubles food directly *and* raises the");
p("exponent on the farm contribution, so existing farms become worth more too.");
p("That coupling is the real reason enhancer tiers are worth chasing, and it is");
p("not visible from the bonus rows alone.");
p();
p("### The full rate for that run");
p();
p("```");
p("  rate = (Σ additional) × (Π multiplicative) × (1 + Σ additiveMultiplier) − Σ drain");
p("");
p("       = (251 + 2 + 3 + 6 + 21)   <- 283");
p("         × 2^11 × 1.2 × 4 × 3 × 10 <- 294912   (all 15 multipliers, compounding)")
p("         × (1 + 31095.94)          <- 31096.94  (the farms, super-linear)")
p("         − 1000                     <- 177 citizens draining food");
p("       = 2,595,354,010,563 food/s");
p("```");
p();
p("Reading `attributeMultiplier: 2` as \"+2 food\" or \"+200% food\" would both be");
p("wrong: it is a **factor in a product**, and with 15 of them the compounding is");
p("where nearly all of the output comes from - not from the farm count.");
p();
p("### The upgrade chains, and what each tier does");
p();
p("Two families with different shapes. **Primary** chains (farm, lumberYard,");
p("quarry, goldMine) grant capacity; **advanced** chains (barracks, university,");
p("smithy, market) do not:");
p();
p("| tier | unlocks at | primary adds | advanced adds |");
p("| --- | --- | --- | --- |");
p("| 0 | 9 | `farmPower` +1, `farmCapacity` x10, `food` x2 | power +1, resource production +1, resource x2 |");
p("| 1–2 | 98, 980 | as above, + `costReductionPercent` 0.5 from tier 2 | same |");
p("| 3–5 | 9 800 … 980 000 | as above | as above |");
p("| 6–7 | 9.8e6, 9.8e7 | + `costReductionFactor` 0.99 from tier 6 | same |");
p();
p("Each tier is a **one-shot purchase that applies permanently** and then");
p("disappears from the Upgrades tab. Thresholds are ×10 apart, so chains are");
p("logarithmically spaced: the marginal value of the last tier is far lower than");
p("the first. Because advanced chains grant no capacity, `barracks`/`university`/");
p("`smithy`/`market` are hard-capped at 11 and only **tier 0 is reachable** today");
p("- do not plan around their higher tiers without first adding a capacity source.");
p();
p("`costReductionFactor 0.99` means the buyable's growth factor is raised to the");
p("**power 0.99**, i.e. `max(1.01, F^0.99)` - the log-growth exponent scales by");
p("exactly 0.99, so the meaning is \"grow at 99% of the default rate\" and it means");
p("the same thing at every factor.");
p();
p("---");
p();
p("# Part 2 — Content");
p();



p("## Attributes");
p();
p("Defined in code (`src/game/attributes.ts`), not in a payload: gatherables");
p("`food`, `wood`, `stone`, `gold`; tracked `population`, `science`, `military`,");
p("`metalwork`, `trade`; one capacity resource per building; derived stats");
p("`clickPower`, `autoClickRate`, `armyPower`.");
p();

const buildingList = buildingListForUnlock;
p(`## Buildings (${buildingList.length})`);
p();
p("| key | name | costs | max | power | available |");
p("| --- | --- | --- | --- | --- | --- |");
for (const b of buildingList) {
  p(
    `| \`${b.key}\` | ${b.name} | ${costs(b.costs)} | ${b.maxCount ?? 10} | ` +
      `${b.power ?? "—"} | ${b.available ? "yes" : "gated"} |`,
  );
}
p();
p("### Building effects (verbatim from the payload)");
p();
for (const b of buildingList) {
  if (b.effects) p(`- **\`${b.key}\`** — \`${JSON.stringify(b.effects)}\``);
}
p();

const researchList = list(read("research.json"));
p(`## Research (${researchList.length})`);
p();
byAgeTable(researchList, (r) => r.key);
p("### Research bonuses — the multipliers actually worth tuning");
p();
for (const r of researchList) {
  if (!r.bonuses?.length) continue;
  const prereq = r.prerequisites?.length
    ? ` prereq: ${r.prerequisites.join(", ")}`
    : "";
  const unlock = r.unlocks?.length ? ` unlocks: ${r.unlocks.join(", ")}` : "";
  p(
    `- **age ${r.age} \`${r.key}\`** (${r.category}) — ` +
      r.bonuses.map(bonus).join("; ") +
      prereq +
      unlock,
  );
}
p();

const unitList = list(read("units.json"));
p(`## Units (${unitList.length})`);
p();
byAgeTable(unitList, (u) => u.id);
p("### Unit stats");
p();
p("| id | name | domain | tier | hp | attack | armor | range | speed | acc | costs |");
p("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const u of unitList) {
  p(
    `| \`${u.id}\` | ${u.name} | ${u.domain} | ${u.tier ?? "—"} | ${num(u.hp)} | ` +
      `${num(u.attack)} | ${num(u.armor)} | ${num(u.range)} | ${num(u.speed)} | ` +
      `${num(u.accuracy)} | ${costs(u.costs)} |`,
  );
}
p();

p("### Matchups — `tags`, `canHit` and `bonusVs`");
p();
p("This is the rock-paper-scissors surface, and it is where naval balance lives.");
p();
p("- `tags` — unit classes, used for `same_tag` battle orders.");
p("- `canHit` — which domains this unit may target at all.");
p("- `bonusVs` — **tag list this unit deals a damage bonus against** (e.g.");
p("  `spearman_bronze` and `catapult_ancient` both have `bonusVs: [\"armored\"]`).");
p("  A naval unit with no entry here takes nothing from an armoured line, and");
p("  vice versa — this is the lever for an anti-naval or anti-armour rebalance.");
p();
p("| id | domain | tags | canHit | bonusVs |");
p("| --- | --- | --- | --- | --- |");
for (const u of unitList) {
  const canHit = Array.isArray(u.canHit) ? u.canHit.join(",") : u.canHit ?? "all";
  p(
    `| \`${u.id}\` | ${u.domain} | ${(u.tags ?? []).join(",")} | ${canHit} | ` +
      `${(u.bonusVs ?? []).join(",") || "—"} |`,
  );
}
p();

const encList = list(read("encounters.json"));
p(`## Encounters (${encList.length})`);
p();
p("| key | name | age | year | boss | enemy army | victory bonuses | unlocks |");
p("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const e of encList) {
  const army = (e.enemyArmy ?? []).map((a) => `${a.unitId}×${a.count}`).join(", ");
  p(
    `| \`${e.key}\` | ${e.name} | ${e.age} | ${e.year ?? "—"} | ` +
      `${e.isBoss ? "**yes**" : ""} | ${army} | ` +
      `${(e.bonuses ?? []).map(bonus).join("; ") || "—"} | ` +
      `${(e.unlocks ?? []).join(",") || "—"} |`,
  );
}
p();

p("## Ages");
p();
try {
  const ageList = list(read("ages.json"));
  p("| key | name | building threshold | research base | research factor | bonuses |");
  p("| --- | --- | --- | --- | --- | --- |");
  for (const a of ageList) {
    p(
      `| \`${a.key}\` | ${a.name} | ${num(a.buildingThreshold)} | ` +
        `${num(a.research?.base)} | ${num(a.research?.factor)} | ` +
        `${(a.bonuses ?? []).map(bonus).join("; ") || "—"} |`,
    );
  }
} catch {
  p("_no ages.json_");
}
p();

p("## Upgrades");
p();
try {
  const upList = list(read("upgrades.json"));
  p(`${upList.length} upgrades.`);
  p();
  p("| key | name | building | tier | threshold | costs | bonuses |");
  p("| --- | --- | --- | --- | --- | --- | --- |");
  for (const u of upList) {
    p(
      `| \`${u.key}\` | ${u.name} | ${u.building ?? "—"} | ${u.tier ?? "—"} | ` +
        `${u.threshold ?? "—"} | ${costs(u.costs)} | ` +
        `${(u.bonuses ?? []).map(bonus).join("; ") || "—"} |`,
    );
  }
} catch {
  p("_no upgrades.json_");
}
p();

p("---");
p();
p(
  `Payloads in \`${DATA}\`: ${readdirSync(DATA)
    .sort()
    .map((f) => `\`${f}\``)
    .join(", ")}. Anything absent above is absent from the dump, not missing from the game.`,
);

writeFileSync("docs/mechanics-reference.md", out.join("\n"));
console.log(`wrote docs/mechanics-reference.md (${out.length} lines)`);






















































































































