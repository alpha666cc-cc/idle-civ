# Mechanics & boosts reference

**Generated** by `tools/gen/mechanicsReference.mjs` — do not edit by hand.
Regenerate after any change under `src/game/data/`.

An accurate dump for handing to another model or an optimiser.
**Part 1 is the rules** — the part that is easy to get wrong by reading the
tables alone. **Part 2 is the content.**

---

# Part 1 — Rules

## 1.1 How a building boosts production

One formula, `computeResourceRate`:

```
rate = (Σ additional) × (Π multiplicative) × (1 + Σ additiveMultiplier) − Σ drain
```

Four mechanisms, and they do **not** combine the same way:

| term | combining rule |
| --- | --- |
| `additional` | **sums** |
| `multiplicative` | **multiplies** — every source compounds with every other |
| `additiveMultiplier` | sums as a **percentage**: `1 + Σ (perBuilding × count) ^ buildingPower` — exponent-scaled, see the worked example in §1.8 |
| `drain` | **sums, then subtracts** — consumption, never negative |

So two `multiplicative` bonuses of ×2 give ×4, while two
`additiveMultiplier` bonuses of +10% give +20%, not +21%. No tiers or groups.

### The building families

| family | buildings | effect | needs workers? |
| --- | --- | --- | --- |
| **primary** | `farm`, `lumberYard`, `quarry`, `goldMine` | `additiveMultiplier` +10% each on a gatherable | **yes** |
| **advanced** | `barracks`, `university`, `smithy` | `resourceProduction` **+1/s** *and* `additiveMultiplier` +5% | no |
| advanced | `market` | `resourceProduction` +1/s only | no |
| capacity | `house`, `townHall` | `capacityProvided` (raises a building's cap) | no |
| upkeep | `people` | `resourceDrain` −1 food/s **each** | no |

The advanced four boost the *building* resources — `military` (barracks),
`science` (university), `metalwork` (smithy), `trade` (market) — which are
**not** worker-assignable. Primary buildings boost the four gatherables
(`food`/`wood`/`stone`/`gold`) and pay nothing unless a worker is assigned.

Capacity is stored *as a resource* rather than as a bonus, because it is
expected to gain a multiplier variant later. `maxCount` is decorative — the
live limit is the building's capacity resource, 10 by default.

## 1.2 Workers, clicks and science

- A worker on a gatherable yields `productionPerWorker` per action; total is
  `workers × productionPerWorker` plus the auto-clicker term
  `autoClicksPerSecond × productionPerClick`.
- A **manual click** gains
  `clickPower × productionPerWorker × Π multipliers`, drains excluded.
  `clickPower` is one global stat scaling every manual click.
- **Science is a worker resource**, exactly like `food`. A university produces
  only 1/s on its own; the measured optimum was a *science share* of 0.20–0.40
  of all workers, which is far larger than it looks like it should be.
- **There is no automatic clicking in the game.** `autoClicksPerSecond` exists
  on the state but starts at **0** and is only ever set by
  `setAutoClicksPerSecond()` from the **Dev Tools** panel - it is a cheat knob,
  not a mechanic. Nothing in `data/` grants it. A model must not assume
  passive production from clicks.

### Starting state

Read live from `createInitialState()` - this is the exact state every simulation
begins from, and it is bare.

| field | value |
| --- | --- |
| `food`/`wood`/`stone`/`gold` | **0** - no starting stockpile at all |
| `science`/`military`/`metalwork`/`trade` | **0** |
| `population` | **0** |
| `workers` (all eight resources) | **0** - every worker is unassigned |
| `builtBuildings` | `{ townHall: 1 }` |
| `clickPower` | **1** (base; bonuses raise it) |
| `autoClicksPerSecond` | **0** (dev only) |
| `boughtResearch` / `boughtUpgrades` / `enteredAges` / `defeatedEncounters` | empty |

The opening move is therefore **build a citizen** (`people`), which is what
creates population; population is *derived* from the count of `people` built,
not a separately settable resource.

Initial capacity limits (each building's live cap is this resource):

| capacity resource | starts at |
| --- | --- |
| `houseCapacity`, `farmCapacity`, `lumberYardCapacity`, `quarryCapacity`, `goldMineCapacity` | **10** |
| `marketCapacity`, `smithyCapacity`, `barracksCapacity`, `universityCapacity` | **11** |
| `townHallCapacity` | **1** |
| `peopleCapacity` | 0 - raised only by `house` (+10 each) |

### Building unlock conditions

A building is buyable when `available` is true **and** its `unlock` gate is
satisfied. Three gate shapes exist:

| `source` | meaning |
| --- | --- |
| `buildingCount` | satisfied once `building` is built `threshold` times |
| `battle` | satisfied once `encounterId` has been defeated |
| `age` | satisfied once `ageId` has been entered |

| building | unlock |
| --- | --- |
| `barracks` | people built >= 90 |
| `university` | defeat `age0_1_first_fire` |
| `smithy` | townHall built >= 5 |
| `market` | enter `age1` |

Everything else (`people`, `house`, `farm`, `lumberYard`, `quarry`, `goldMine`,
`townHall`) is available from the first tick with no gate.

## 1.3 Simulation settings (what the Part 2 numbers were measured under)

| setting | value | meaning |
| --- | --- | --- |
| `actionsPerSecond` | **5** | the action budget per simulated second |
| `gatherClicksPerAction` | **10** | clicks one gather action is worth |
| tick | **1 simulated second** | `tick()` applies one second of production |
| objective | `{ type: "ageReach", ageId: "age1" }` | run ends at the Iron Age |
| `maxGameTime` | 12 000 s benchmark / 20 000 s searches | horizon; a run that never reaches the objective reports it |
| randomness | **none** | no seed; repeats are bit-identical |

**The action budget is the binding constraint, not resources.** Every gather,
build, purchase *and worker reassignment* consumes one of the 5 slots per
second. A policy was once observed spending 19 995 of 20 000 actions gathering
and never reaching the Iron Age. A reassignment that lands back where it
started costs a slot and changes nothing — the most likely remaining waste.

Tooling consequence: timings are **game time**, not wall-clock, so running
candidates across cores in parallel is safe and only costs wall-clock.

## 1.4 Costs

- **Buildings and units** use a cumulative series
  `T(n) = base × factor^(n^exponent − 1)`. Cost entries default to exponent
  `0.5`, preserving the square-root curve; the engine also keeps a linear
  early-cost floor. The *n*-th unit costs `T(n) − T(n−1)`.
- **Research is priced by ordinal, not identity.** `getResearchCostForCount(n)`
  prices the *n*-th tech bought in the **current age** at
  `base × factor^(n^exponent − 1)`, keyed on the age, never on which tech it is
  (Ancient: `200 · 12^(√n − 1)` science). Therefore:
  - every tech available in an age costs **exactly the same**;
  - any path buying all 23 Age-0 techs costs the same total (10 131 950
    science) whatever the order — so price **cannot** rank research options;
  - price only prices *delay*, which is why idling research is costly, and
    that is an argument never to stall, never an argument to reorder;
  - a tech bought from an earlier age is priced at the current age's next
    price and does **not** advance `n`.

## 1.5 Gates

Entering an age is gated on **battles won** plus a **building threshold** —
never on research. Research still gates Age-1 indirectly and hard: it unlocks
the bronze units needed to win Wolf Pack and **Troy**, and its bonuses
compound into everything downstream.

## 1.6 Age progression — the exact entry condition

`CivilizationState.canEnterAge(ageId)` is the whole gate. All four must hold:

1. `ageId` is a real age and **not** already in `enteredAges` (idempotent).
2. `getCurrentAge()?.key === ageId` — you may only complete the age you are in.
3. **Every encounter whose `age` equals this age's index is won.**
4. **Total buildings ≥ the target** for this age.

Two details that are easy to get wrong:

- **Research is *not* part of the gate.** No condition reads `boughtResearch`.
  Research still gates Age-1 indirectly: it unlocks the bronze units needed to
  win Wolf Pack and **Troy**, and its bonuses compound downstream.
- **The building target belongs to the *next* age.**
  `getAgeBuildingTarget(age)` returns `ageDefinitions[index + 1].buildingThreshold`,
  falling back to the current age's own. So completing Ancient (index 0) is
  measured against **Iron Age's** threshold, not Ancient's. Ages' `unlocks` fire
  on `enterAge(id)`, so they are **completion rewards** — Ancient's bonuses
  arrive when Ancient is completed.

- **Entering an age is an *action*, not a passive state.** `enterAge` costs one of
  the 5 action slots (§1.3), and the simulation logs a rejected `enterAge` when
  `canEnterAge` is false. Any optimiser must emit the action, not merely satisfy
  the predicate.

| to complete age | key | needs this many buildings |
| --- | --- | --- |
| 0 | `age0` | **1.500e+3** (target of `age1`) |
| 1 | `age1` | **1.500e+4** (target of `age2`) |
| 2 | `age2` | **1.500e+6** (target of `age3`) |
| 3 | `age3` | **1.500e+8** (target of `age4`) |
| 4 | `age4` | **1.500e+9** (target of `age5`) |
| 5 | `age5` | **1.500e+10** (target of `age6`) |
| 6 | `age6` | **1.500e+10** |

## 1.7 The battle algorithm

`src/game/battle.ts`. Fully **deterministic** — damage has no random component,
so the same armies always produce the same battle. The seed is a battle
fingerprint (battle id + both army signatures) kept only for logging/replay.

### Representation and constants

A stack is **one aggregate hit-point pool**, never one object per unit — so a
million spearmen cost the same to simulate as one, and a battle always finishes
in bounded time. Effective hit points per unit:

```
hitPoints  = hp / (1 − min(armor, 0.9))      // armour is a % reduction, capped at 90%
livingCount = ceil(hpPool / hitPoints)
```

| constant | value | meaning |
| --- | --- | --- |
| starting gap | **maximum army range + 1** | Round 0 deployment; no unit is in range |
| `maximumRounds` | **101** | unresolved by then ⇒ `stalemate`, counted as a loss |
| `bonusVsMultiplier` | **1.5** | damage multiplier against a countered tag |
| `screeningShare` | **0.25** | share of damage redirected to screens |

### One round (one second of playback)

Round 0 is a deployment snapshot with no attacks. At the start of each active
round, both armies advance one position toward each other, then **every stack that
can reach an enemy fires once, in speed order**. Unit speed determines attack order,
not movement. Thus a unit can become targetable in Round 1, and a backline unit
can be reached even when an untargetable unit holds the opposing frontline.

**Who can hit whom (`canReach`)** — the attacker's `canHit` domains must include
the target's `domain`; `distance <= attacker.range`; an `air` target needs
`range > 1`; and **ground cannot hit naval at `range <= 3`** — the rule that
makes naval viable at all.

**Damage multipliers (`matchupMultiplier`)** — all four multiply together:

```
×1.5            attacker.bonusVs intersects target.tags
×1.2            air attacker vs naval target
×(range / 10)   naval attacker vs ground target   ← ships scale WITH their range
×0.3            air target hit by a range<=1 attacker
```

The naval term is **scaling, not flat**: a longer-ranged ship hits ground
harder. That is the sharpest available lever on the naval balance question.

Two **formation-based** multipliers also apply, read from each formation's
data: a formation may declare `damageDealtVs` (e.g. `pike_square` deals ×1.5 vs
`cavalry`, ×0.8 vs `ranged`) and/or `damageTakenVs` (e.g. `turtle` takes ×0.7
from any `ranged` attacker — missile-fire resistance).

### Target selection — the eight orders

> ### ⚠ There are NO selectable orders in Age 0 or Age 1
> 
> `ordersForAge(0)` and `ordersForAge(1)` both return **exactly one** entry:
> `standard`. Verified against the live engine:
> 
> | age | orders available | count |
> | --- | --- | --- |
> | **0 Ancient** | `standard` | **1** |
> | **1 Iron** | `standard` | **1** |
> | 2 Classical | `standard`, `frontline`, `backline`, `focus_counter`, `focus_weak`, `focus_strong` | 6 |
> | 3+ | all eight | 8 |
> 
> The other seven unlock in Age 2 and Age 3. **Any strategy, model or optimiser
> reasoning about the Age-1 objective must assume `standard` for every unit,
> because there is no other option available.** Do not budget time for order
> selection at Age 1 — the Army tab's order picker cannot offer anything else
> yet, and `getAvailableOrders()` returns the age-0 list (just `standard`)
> until the settlement enters its first age.
> 
> Because `standard` is the pre-orders rule verbatim, this also means the Age-1
> battles behave exactly as they did before orders existed: **every stack fires
> at the weakest reachable pool.**

Orders change **targeting and screening only** — never damage, range or speed,
so an order can move the cost of a battle but not invalidate a unit's stats.
`standard` is bit-for-bit the pre-orders rule and deliberately does *not* prefer
a countered target; folding that in would silently retune every battle for
players who never touch the control.

| order | targets |
| --- | --- |
| `standard` | weakest reachable stack |
| `focus_weak` | smallest remaining stack |
| `focus_strong` | largest remaining stack |
| `focus_counter` | weakest foe whose tags the attacker counters, else any |
| `same_tag` | a foe sharing one of your tags, else first reachable |
| `frontline` | nearest melee line (lowest `range`) |
| `backline` | furthest-reaching foe |
| `protect_ranged` | standard targeting, but draws fire for ranged allies |

Every order falls back to a reachable target, so an order never makes a stack
idle while enemies are in range. An order is **per unit type**, not per stack
instance — one army, one order per type, so it always describes the whole of
that type.

At **Age 0–1 only `standard` exists** (see the warning above), so the remaining
seven are forward-looking: they matter from Age 2, not for an Age-1 strategy.

### Screening

A stack whose order is `protect_ranged`, or whose `range <= 3` (fragile), is
protected. Its `frontline`/`protect_ranged` allies split **25 %** of the damage
aimed at it. All of it is still dealt — screening trades a body's survival for
its allies' rather than adding or removing damage. The share is small on
purpose: at a higher share the screen dies in the opening rounds, the enemy
focuses whatever is left, and the order loses battles that were already won.

### Outcome and consequences

`simulateBattle` → `{ rounds, outcome, playerSurvivors, enemySurvivors }`.
**Units are never lost** — `resolveBattle()` restores post-battle counts, so a
defeat costs the opportunity, not the army. Outcome is `player` | `enemy` |
`stalemate`, the last counting as a loss. The UI plays back 1 round/sec.

A battle also feeds `defeatEncounter(id)`: idempotent, appends the id, records
the fastest victory, and applies the encounter's victory bonuses.

### Research costs in full

Each age carries a price schedule in `ages.json`:

```ts
research: { base, factor }
```

and the **n-th** tech bought in that age costs `base × factor^(√n − 1)` science,
with `n` counting only techs bought *in that age*. The schedule is read from
`getCurrentAge()`, so **entering a new age restarts the curve** at that age's
own `base` with a fresh counter — that is the whole reason the bases leap by
orders of magnitude below.

| age | `base` (1st tech) | `factor` (curve climb) |
| --- | --- | --- |
| `age0` | 200 | 12 |
| `age1` | 1.000e+9 | 230 |
| `age2` | 1.000e+15 | 2.000e+3 |
| `age3` | 1.000e+21 | 2.000e+4 |
| `age4` | 1.000e+27 | 2.000e+5 |
| `age5` | 1.000e+33 | 2.000e+6 |
| `age6` | 1.000e+39 | 2.000e+7 |

`costMultipliers` (per-age resource price scaling, `getResourceCostMultiplier`)
are **all empty today** — the field is wired but carries no data.

### What the curve actually costs

Computed from the schedules above. Cumulative = everything bought so far in that
age; the ratio is marginal cost ÷ previous marginal cost.

**Ancient** (`age0`, 23 techs, base 200, factor 12)

| n | marginal | cumulative | ×prev |
| --- | --- | --- | --- |
| 1 | 200 | 200 | — |
| 2 | 559.811 | 759.811 | 2.80 |
| 3 | 1.233e+3 | 1.993e+3 | 2.20 |
| 4 | 2.400e+3 | 4.393e+3 | 1.95 |
| 5 | 4.315e+3 | 8.708e+3 | 1.80 |
| 6 | 7.333e+3 | 1.604e+4 | 1.70 |
| 7 | 1.194e+4 | 2.798e+4 | 1.63 |
| 8 | 1.880e+4 | 4.679e+4 | 1.57 |
| 9 | 2.880e+4 | 7.559e+4 | 1.53 |
| 10 | 4.310e+4 | 1.187e+5 | 1.50 |
| … | | | |
| 23 | 2.497e+6 | see below | |

All 23: **1.013e+7** science in total. The last tech alone costs **2.497e+6** — 24.6% of everything that age spends on research.

**Iron Age** (`age1`, 23 techs, base 1.000e+9, factor 230)

| n | marginal | cumulative | ×prev |
| --- | --- | --- | --- |
| 1 | 1.000e+9 | 1.000e+9 | — |
| 2 | 9.512e+9 | 1.051e+10 | 9.51 |
| 3 | 5.357e+10 | 6.408e+10 | 5.63 |
| 4 | 2.300e+11 | 2.941e+11 | 4.29 |
| 5 | 8.303e+11 | 1.124e+12 | 3.61 |
| 6 | 2.650e+12 | 3.775e+12 | 3.19 |
| 7 | 7.706e+12 | 1.148e+13 | 2.91 |
| 8 | 2.081e+13 | 3.229e+13 | 2.70 |
| 9 | 5.290e+13 | 8.519e+13 | 2.54 |
| 10 | 1.279e+14 | 2.130e+14 | 2.42 |
| … | | | |
| 23 | 9.220e+17 | see below | |

All 23: **2.068e+18** science in total. The last tech alone costs **9.220e+17** — 44.6% of everything that age spends on research.

**Classical** (`age2`, 24 techs, base 1.000e+15, factor 2000)

| n | marginal | cumulative | ×prev |
| --- | --- | --- | --- |
| 1 | 1.000e+15 | 1.000e+15 | — |
| 2 | 2.330e+16 | 2.430e+16 | 23.30 |
| 3 | 2.609e+17 | 2.852e+17 | 11.20 |
| 4 | 2.000e+18 | 2.285e+18 | 7.66 |
| 5 | 1.203e+19 | 1.432e+19 | 6.02 |
| 6 | 6.093e+19 | 7.524e+19 | 5.06 |
| 7 | 2.708e+20 | 3.461e+20 | 4.44 |
| 8 | 1.086e+21 | 1.432e+21 | 4.01 |
| 9 | 4.000e+21 | 5.432e+21 | 3.68 |
| 10 | 1.373e+22 | 1.916e+22 | 3.43 |
| … | | | |
| 24 | 7.424e+27 | see below | |

All 24: **1.350e+28** science in total. The last tech alone costs **7.424e+27** — 55.0% of everything that age spends on research.

**Middle Ages** (`age3`, 24 techs, base 1.000e+21, factor 20000)

| n | marginal | cumulative | ×prev |
| --- | --- | --- | --- |
| 1 | 1.000e+21 | 1.000e+21 | — |
| 2 | 6.047e+22 | 6.147e+22 | 60.47 |
| 3 | 1.408e+24 | 1.469e+24 | 23.28 |
| 4 | 2.000e+25 | 2.147e+25 | 14.21 |
| 5 | 2.072e+26 | 2.287e+26 | 10.36 |
| 6 | 1.715e+27 | 1.944e+27 | 8.28 |
| 7 | 1.198e+28 | 1.392e+28 | 6.98 |
| 8 | 7.313e+28 | 8.706e+28 | 6.11 |
| 9 | 4.000e+29 | 4.871e+29 | 5.47 |
| 10 | 1.995e+30 | 2.482e+30 | 4.99 |
| … | | | |
| 24 | 5.883e+37 | see below | |

All 24: **9.130e+37** science in total. The last tech alone costs **5.883e+37** — 64.4% of everything that age spends on research.

**Renaissance** (`age4`, 22 techs, base 1.000e+27, factor 200000)

| n | marginal | cumulative | ×prev |
| --- | --- | --- | --- |
| 1 | 1.000e+27 | 1.000e+27 | — |
| 2 | 1.569e+29 | 1.579e+29 | 156.95 |
| 3 | 7.597e+30 | 7.755e+30 | 48.40 |
| 4 | 2.000e+32 | 2.078e+32 | 26.33 |
| 5 | 3.568e+33 | 3.776e+33 | 17.84 |
| 6 | 4.828e+34 | 5.206e+34 | 13.53 |
| 7 | 5.299e+35 | 5.819e+35 | 10.97 |
| 8 | 4.927e+36 | 5.509e+36 | 9.30 |
| 9 | 4.000e+37 | 4.551e+37 | 8.12 |
| 10 | 2.899e+38 | 3.354e+38 | 7.25 |
| … | | | |
| 22 | 3.656e+46 | see below | |

All 22: **4.975e+46** science in total. The last tech alone costs **3.656e+46** — 73.5% of everything that age spends on research.

**Industrial** (`age5`, 22 techs, base 1.000e+33, factor 2000000)

| n | marginal | cumulative | ×prev |
| --- | --- | --- | --- |
| 1 | 1.000e+33 | 1.000e+33 | — |
| 2 | 4.074e+35 | 4.084e+35 | 407.35 |
| 3 | 4.099e+37 | 4.140e+37 | 100.62 |
| 4 | 2.000e+39 | 2.041e+39 | 48.79 |
| 5 | 6.145e+40 | 6.349e+40 | 30.72 |
| 6 | 1.359e+42 | 1.423e+42 | 22.12 |
| 7 | 2.344e+43 | 2.486e+43 | 17.24 |
| 8 | 3.319e+44 | 3.567e+44 | 14.16 |
| 9 | 4.000e+45 | 4.357e+45 | 12.05 |
| 10 | 4.213e+46 | 4.649e+46 | 10.53 |
| … | | | |
| 22 | 1.792e+56 | see below | |

All 22: **2.261e+56** science in total. The last tech alone costs **1.792e+56** — 79.3% of everything that age spends on research.

**Modern / Space** (`age6`, 34 techs, base 1.000e+39, factor 20000000)

| n | marginal | cumulative | ×prev |
| --- | --- | --- | --- |
| 1 | 1.000e+39 | 1.000e+39 | — |
| 2 | 1.057e+42 | 1.058e+42 | 1057.27 |
| 3 | 2.212e+44 | 2.222e+44 | 209.19 |
| 4 | 2.000e+46 | 2.022e+46 | 90.43 |
| 5 | 1.058e+48 | 1.078e+48 | 52.91 |
| 6 | 3.826e+49 | 3.934e+49 | 36.16 |
| 7 | 1.037e+51 | 1.076e+51 | 27.10 |
| 8 | 2.236e+52 | 2.343e+52 | 21.56 |
| 9 | 4.000e+53 | 4.234e+53 | 17.89 |
| 10 | 6.121e+54 | 6.545e+54 | 15.30 |
| … | | | |
| 34 | 1.866e+74 | see below | |

All 34: **2.431e+74** science in total. The last tech alone costs **1.866e+74** — 76.8% of everything that age spends on research.

Three consequences worth internalising:

- **Order is free.** Because the price keys on the ordinal `n`, *not* the tech,
  any ordering of the same 23 Age-0 techs costs the identical total. Research
  order cannot be optimised through cost saving — only through *when* you buy.
- **Buying early is buying cheap.** Every tech you buy raises the price of every
  later one, so idling research is a loan against a rising price. This is the one
  place where "cost-aware" reasoning is real: it argues never to stall, and it
  says nothing about *which* tech to pick.
- **An earlier-age tech bought late costs full current-age price** and does not
  advance `n`. Back-filling Ancient techs in the Iron Age is therefore a pure
  drain on the Iron Age's own curve — it does not get cheaper, and it does not
  earn a discount.

Research is a **buyable**, so it takes the same four cost reductions as
buildings and units (`base → factor → percent → flat`, §13.1, clamped at 0) —
but only ones naming `"research"` explicitly: `allBuildings` never reaches it,
because research is not a building.

### Worked example - how an enhancer reaches `computeResourceRate`

This is the calculation most easily misread, so it is spelled out against real
numbers lifted from a finished `balanced` Age-1 run.

**`farmEnhancer9` (tier 0) grants, verbatim:**

```json
[{"type":"attributeFlat",       "destination":"farmPower",   "value":1},
 {"type":"attributeMultiplier", "destination":"farmCapacity","value":10},
 {"type":"attributeMultiplier", "destination":"food",       "value":2}]
```

At the end of that run: **F = 177 farms**, **2 farm enhancers** bought,
**`farmPower` = 3.6**. The engine's own factors for `food` were:

| term | value | where it comes from |
| --- | --- | --- |
| `additional` | `[251, 2, 3, 6, 21]` | 251 food workers, then research flats |
| `multiplicative` | `[2,2,2,1.2,4,3,2,2,2,10,2,2,2,2,2]` | 2 from each of the 2 enhancers; the rest from research |
| `additiveMultiplier` | `[31095.94]` | **the farms, exponent-scaled** (below) |
| `drain` | `[1000]` | citizens |

### ⚠ Building multipliers are exponent-scaled by `buildingPower`

This is the single most misreadable line in the engine. A building's
`additiveMultiplier` is **not** `perBuilding × count`. It is:

```
  perBuilding x count          raised to the power of  buildingPower
  = (0.10 x F) ^ farmPower
```

Verified against the run above: `(0.10 × 177) ^ 3.6 = 31095.94`, which is
exactly the `additiveMultiplier` entry. At the naive linear reading it would
have been `0.10 × 177 = 17.7` — **wrong by a factor of ~1760**.

So the two "+10% per farm" ideas behave completely differently:

| farmPower | farms=10 | farms=100 | farms=177 | shape |
| --- | --- | --- | --- | --- |
| 1 (base) | 1.0 | 10.0 | 17.7 | linear |
| 2 | 1.0 | 100 | 313.8 | quadratic |
| 3.6 (2 enhancers + Iron Age) | 3.98 | 3981 | 31096 | strongly super-linear |

**`buildingPower` grows**, so the same farm count is worth progressively more:

```
  farmPower = base power (1, from the definition's `power` field)
            + Σ attributeFlat on `farmPower`   (+1 per farm enhancer bought)
            × Π attributeMultiplier on `farmPower` (ages, research, encounters)
```

In that run: `(1 + 2 enhancers) × 1.2 (Iron Age) = 3.6`. Buying enhancers
therefore has a **double effect** - it doubles food directly *and* raises the
exponent on the farm contribution, so existing farms become worth more too.
That coupling is the real reason enhancer tiers are worth chasing, and it is
not visible from the bonus rows alone.

### The full rate for that run

```
  rate = (Σ additional) × (Π multiplicative) × (1 + Σ additiveMultiplier) − Σ drain

       = (251 + 2 + 3 + 6 + 21)   <- 283
         × 2^11 × 1.2 × 4 × 3 × 10 <- 294912   (all 15 multipliers, compounding)
         × (1 + 31095.94)          <- 31096.94  (the farms, super-linear)
         − 1000                     <- 177 citizens draining food
       = 2,595,354,010,563 food/s
```

Reading `attributeMultiplier: 2` as "+2 food" or "+200% food" would both be
wrong: it is a **factor in a product**, and with 15 of them the compounding is
where nearly all of the output comes from - not from the farm count.

### The upgrade chains, and what each tier does

Two families with different shapes. **Primary** chains (farm, lumberYard,
quarry, goldMine) grant capacity; **advanced** chains (barracks, university,
smithy, market) do not:

| tier | unlocks at | primary adds | advanced adds |
| --- | --- | --- | --- |
| 0 | 9 | `farmPower` +1, `farmCapacity` x10, `food` x2 | power +1, resource production +1, resource x2 |
| 1–2 | 98, 980 | as above, + `costReductionPercent` 0.5 from tier 2 | same |
| 3–5 | 9 800 … 980 000 | as above | as above |
| 6–7 | 9.8e6, 9.8e7 | + `costReductionFactor` 0.99 from tier 6 | same |

Each tier is a **one-shot purchase that applies permanently** and then
disappears from the Upgrades tab. Thresholds are ×10 apart, so chains are
logarithmically spaced: the marginal value of the last tier is far lower than
the first. Because advanced chains grant no capacity, `barracks`/`university`/
`smithy`/`market` are hard-capped at 11 and only **tier 0 is reachable** today
- do not plan around their higher tiers without first adding a capacity source.

`costReductionFactor 0.99` means the buyable's growth factor is raised to the
**power 0.99**, i.e. `max(1.01, F^0.99)` - the log-growth exponent scales by
exactly 0.99, so the meaning is "grow at 99% of the default rate" and it means
the same thing at every factor.

---

# Part 2 — Content

## Attributes

Defined in code (`src/game/attributes.ts`), not in a payload: gatherables
`food`, `wood`, `stone`, `gold`; tracked `population`, `science`, `military`,
`metalwork`, `trade`; one capacity resource per building; derived stats
`clickPower`, `autoClickRate`, `armyPower`.

## Buildings (11)

| key | name | costs | max | power | available |
| --- | --- | --- | --- | --- | --- |
| `people` | Citizen | food 10×2.5 | 0 | — | yes |
| `house` | House | wood 10×12 | 0 | — | yes |
| `farm` | Farm | food 10×8 + wood 10×8 | 10 | 1 | yes |
| `lumberYard` | Lumber Yard | wood 10×8 + stone 5×8 | 10 | 1 | yes |
| `quarry` | Quarry | stone 20×8 | 10 | 1 | yes |
| `goldMine` | Gold Mine | wood 100×8 + stone 50×8 | 10 | 1 | yes |
| `townHall` | Town Hall | wood 1.000e+4×15 + stone 7.500e+3×15 + gold 1.250e+4×15 | 1 | — | yes |
| `barracks` | Barracks | wood 1.000e+4×10 + stone 1.000e+3×12 + food 5.000e+3×10 | 10 | 1 | yes |
| `university` | University | wood 1.000e+4×10 + stone 1.000e+4×12 + gold 7.500e+3×10 | 10 | 1 | yes |
| `smithy` | Smithy | wood 1.000e+6×12 + stone 1.000e+6×12 | 10 | 1 | yes |
| `market` | Market | wood 2.500e+7×12 + stone 2.500e+7×12 | 10 | 1 | yes |

### Building effects (verbatim from the payload)

- **`people`** — `{"resourceDrain":{"resource":"food","amount":1}}`
- **`house`** — `{"capacityProvided":{"building":"people","perBuilding":10}}`
- **`farm`** — `{"additiveMultiplier":{"resource":"food","perBuilding":0.1}}`
- **`lumberYard`** — `{"additiveMultiplier":{"resource":"wood","perBuilding":0.1}}`
- **`quarry`** — `{"additiveMultiplier":{"resource":"stone","perBuilding":0.1}}`
- **`goldMine`** — `{"additiveMultiplier":{"resource":"gold","perBuilding":0.1}}`
- **`townHall`** — `{"capacityProvided":[{"building":"house","perBuilding":10},{"building":"barracks","perBuilding":1},{"building":"university","perBuilding":1},{"building":"smithy","perBuilding":1},{"building":"market","perBuilding":1}]}`
- **`barracks`** — `{"resourceProduction":{"resource":"military","amount":1},"additiveMultiplier":{"resource":"military","perBuilding":0.05}}`
- **`university`** — `{"resourceProduction":{"resource":"science","amount":1},"additiveMultiplier":{"resource":"science","perBuilding":0.05}}`
- **`smithy`** — `{"resourceProduction":{"resource":"metalwork","amount":1},"additiveMultiplier":{"resource":"metalwork","perBuilding":0.05}}`
- **`market`** — `{"resourceProduction":{"resource":"trade","amount":1}}`

## Research (172)

| age | count | ids |
| --- | --- | --- |
| 0 | 23 | `agriculture`, `pottery`, `animal_husbandry`, `sling_throwing`, `mining`, `stone_working`, `forestry`, `weaving`, `writing`, `calendar`, `city_planning`, `tribal_organization`, `archery_mechanics`, `flint_knapping`, `domestication`, `trapping`, `woodcraft_hulls`, `bronze_smelting`, `bronze_casting`, `wheel_axle`, `composite_bowcraft`, `galley_design`, `torsion_physics` |
| 1 | 23 | `iron_mining`, `currency`, `masonry`, `trade_routes`, `mathematics`, `alphabet`, `irrigation`, `code_of_laws`, `road_networks`, `metallurgy_prep`, `shipbuilding_principles`, `philosophy_fundamentals`, `iron_working`, `iron_forging`, `iron_chariotry`, `horsemanship`, `ram_hulls`, `howdah_mounting`, `engineered_siegecraft`, `heavy_oar_arrays`, `iron_shielding`, `cavalry_formations`, `coastal_forts` |
| 2 | 24 | `aqueducts`, `drama_poetry`, `civil_service`, `logic`, `currency_standard`, `surveying`, `crop_rotation`, `lumber_mills`, `architecture`, `banking_concepts`, `aesthetics`, `scholasticism`, `legion_discipline`, `phalanx_doctrine`, `shock_cavalry`, `recurve_archery`, `heavy_counterweights`, `incendiary_weapons`, `subterfuge`, `armed_merchant_navies`, `armor_layering`, `siege_logistics`, `naval_ramming`, `martival_drill` |
| 3 | 24 | `feudalism`, `guilds`, `windmills`, `water_power`, `gothic_architecture`, `cartography`, `universities`, `patronage`, `manorialism`, `mining_shafts`, `craftsmanship`, `almanacs`, `plate_armor`, `yew_bowcraft`, `steel_crossbows`, `professional_men_at_arms`, `trebuchet_physics`, `clinker_building`, `raiding_vessels`, `early_black_powder`, `rigging_sails`, `castle_fortification`, `crossbow_drills`, `chivalric_code` |
| 4 | 22 | `printing_press`, `double_entry_bookkeeping`, `scientific_method`, `humanism`, `metallurgy`, `perspective_drawing`, `banking_houses`, `enclosure_acts`, `naval_academies`, `clockwork_mechanics`, `global_exploration`, `matchlock_mechanisms`, `tercio_formations`, `mounted_firearms`, `heavy_cavalry_pistols`, `cast_bronze_cannon`, `broadside_warfare`, `sailing_rigging`, `letters_of_marque`, `gunpowder_standardization`, `star_fortresses`, `naval_bombardment` |
| 5 | 22 | `steam_engine`, `industrialization`, `assembly_line`, `electricity`, `corporations`, `railroads`, `telegraph`, `internal_combustion`, `synthetic_fertilizers`, `refining`, `pharmaceuticals`, `rifled_barrels`, `minie_ball_ammunition`, `industrial_cavalry_tactics`, `lancer_charges`, `rapid_fire_mechanics`, `ironclad_armor`, `lighter_than_air_flight`, `aeronautics`, `heavy_rifled_artillery`, `submersible_hulls`, `trench_warfare` |
| 6 | 34 | `computers`, `nuclear_fission`, `internet`, `automation`, `genomics`, `renewable_energy`, `globalization`, `microprocessors`, `spaceflight`, `quantum_computing`, `nanotechnology`, `stormtrooper_tactics`, `combined_arms_armor`, `motorized_infantry`, `armored_warfare`, `piston_engine_fighters`, `strategic_bombing`, `naval_aviation`, `dreadnought_armor`, `assault_rifles`, `composite_armor`, `stealth_technology`, `guided_missiles`, `armored_cavalry_doctrine`, `unmanned_aerial_systems`, `helicopter_rotor_systems`, `rocket_artillery`, `nuclear_propulsion`, `special_operations`, `radar_low_observability`, `orbital_arrays`, `particle_beams`, `exoskeletons`, `interstellar_infantry` |

### Research bonuses — the multipliers actually worth tuning

- **age 0 `agriculture`** (civilian) — attributeMultiplier → food (2); costReductionPercent → farm (0.5)
- **age 0 `pottery`** (civilian) — costReductionPercent → house (0.5); attributeMultiplier → food (2) prereq: agriculture
- **age 0 `animal_husbandry`** (civilian) — attributeMultiplier → food (2); attributeMultiplier → wood (2) prereq: agriculture
- **age 0 `sling_throwing`** (civilian) — attributeMultiplier → food (2) prereq: pottery unlocks: slinger
- **age 0 `mining`** (civilian) — attributeMultiplier → stone (2); attributeMultiplier → gold (2) prereq: agriculture
- **age 0 `stone_working`** (civilian) — costReductionPercent → allBuildings (0.5); attributeMultiplier → stone (10) prereq: mining
- **age 0 `forestry`** (civilian) — attributeMultiplier → wood (2); costReductionPercent → allBuildings (0.5) prereq: agriculture
- **age 0 `weaving`** (civilian) — attributeMultiplier → gold (2); attributeMultiplier → food (2) prereq: animal_husbandry
- **age 0 `writing`** (civilian) — attributeMultiplier → science (10); costReductionPercent → allBuildings (0.5) prereq: pottery
- **age 0 `calendar`** (civilian) — attributeMultiplier → food (2); costReductionPercent → allBuildings (0.5) prereq: writing
- **age 0 `city_planning`** (civilian) — costReductionPercent → allBuildings (0.5); attributeMultiplier → allProduction (2) prereq: stone_working, writing
- **age 0 `tribal_organization`** (military) — attributeMultiplier → tag.infantry.attack (1.25); attributeMultiplier → tag.infantry.hp (1.25); attributeMultiplier → military (2) prereq: agriculture
- **age 0 `archery_mechanics`** (military) — costReductionPercent → allUnits (0.5); attributeMultiplier → tag.ranged.attack (1.25) prereq: tribal_organization
- **age 0 `flint_knapping`** (military) — attributeMultiplier → tag.ranged.attack (1.25); attributeMultiplier → military (2) prereq: sling_throwing, archery_mechanics unlocks: archer_prehist
- **age 0 `domestication`** (military) — attributeMultiplier → food (10); attributeMultiplier → unitAll.attack (1.25) prereq: tribal_organization
- **age 0 `trapping`** (military) — attributeMultiplier → food (2); attributeMultiplier → gold (2); costReductionPercent → allUnits (0.5) prereq: domestication
- **age 0 `woodcraft_hulls`** (military) — costReductionPercent → allUnits (0.5) prereq: tribal_organization unlocks: canoe
- **age 0 `bronze_smelting`** (military) — attributeMultiplier → tag.infantry.attack (1.25) prereq: tribal_organization, mining unlocks: spearman_bronze
- **age 0 `bronze_casting`** (military) — attributeMultiplier → tag.infantry.hp (1.25) prereq: bronze_smelting unlocks: axeman_bronze
- **age 0 `wheel_axle`** (military) — attributeMultiplier → unitAll.attack (1.25) prereq: bronze_smelting unlocks: chariot_bronze
- **age 0 `composite_bowcraft`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: flint_knapping, bronze_casting unlocks: bowman_bronze
- **age 0 `galley_design`** (military) — attributeMultiplier → tag.ranged.attack (1.25) prereq: woodcraft_hulls, bronze_casting unlocks: trireme_bronze
- **age 1 `iron_mining`** (civilian) — attributeMultiplier → metalwork (100); costReductionPercent → allBuildings (0.5) prereq: stone_working, bronze_smelting
- **age 1 `currency`** (civilian) — attributeMultiplier → trade (3); costReductionPercent → allBuildings (0.5) prereq: writing
- **age 1 `masonry`** (civilian) — attributeMultiplier → townHallCapacity (2); costReductionPercent → townHall (0.5); costReductionFactor → house (0.8) prereq: city_planning
- **age 1 `trade_routes`** (civilian) — attributeMultiplier → trade (100); attributeMultiplier → allProduction (2); attributeMultiplier → marketCapacity (2) prereq: currency
- **age 1 `mathematics`** (civilian) — attributeMultiplier → science (100); attributeMultiplier → universityCapacity (2) prereq: currency
- **age 1 `alphabet`** (civilian) — attributeMultiplier → science (3); costReductionPercent → allBuildings (0.5); costReductionPercent → people (0.9) prereq: writing
- **age 1 `irrigation`** (civilian) — attributeMultiplier → food (100); costReductionPercent → allBuildings (0.9) prereq: calendar
- **age 1 `code_of_laws`** (civilian) — costReductionPercent → allBuildings (0.75); attributeMultiplier → allProduction (3) prereq: alphabet
- **age 1 `road_networks`** (civilian) — attributeMultiplier → trade (100); attributeMultiplier → allProduction (2) prereq: trade_routes, masonry
- **age 1 `metallurgy_prep`** (civilian) — attributeMultiplier → stone (100); attributeMultiplier → gold (3); attributeMultiplier → smithyCapacity (2) prereq: iron_mining
- **age 1 `shipbuilding_principles`** (civilian) — costReductionPercent → tag.naval (0.75); attributeMultiplier → trade (3) prereq: galley_design
- **age 1 `philosophy_fundamentals`** (civilian) — attributeMultiplier → science (3); attributeMultiplier → allProduction (3) prereq: alphabet
- **age 0 `torsion_physics`** (military) — attributeMultiplier → unitAll.attack (1.25) prereq: wheel_axle, composite_bowcraft unlocks: catapult_ancient
- **age 1 `iron_forging`** (military) — attributeMultiplier → tag.infantry.hp (1.5) prereq: iron_working unlocks: swordsman_iron
- **age 1 `iron_chariotry`** (military) — attributeMultiplier → tag.armored.attack (1.5) prereq: wheel_axle, iron_working unlocks: chariot_iron
- **age 1 `horsemanship`** (military) — attributeMultiplier → tag.armored.attack (1.5); attributeMultiplier → trade (5) prereq: domestication unlocks: cavalry_iron
- **age 1 `ram_hulls`** (military) — attributeMultiplier → tag.naval.attack (1.5); attributeMultiplier → wood (100) prereq: galley_design unlocks: war_galley_iron
- **age 1 `howdah_mounting`** (military) — attributeMultiplier → tag.armored.attack (2) prereq: trapping, iron_working unlocks: elephant_iron
- **age 1 `engineered_siegecraft`** (military) — attributeMultiplier → tag.ranged.attack (5) prereq: torsion_physics, mathematics unlocks: ballista
- **age 1 `heavy_oar_arrays`** (military) — attributeMultiplier → tag.naval.attack (1.5); attributeMultiplier → tag.naval.hp (1.5) prereq: ram_hulls unlocks: quinquereme
- **age 1 `iron_shielding`** (military) — attributeMultiplier → unitAll.hp (1.25); costReductionFactor → domain.ground (0.9) prereq: iron_forging
- **age 1 `cavalry_formations`** (military) — attributeMultiplier → tag.armored.attack (1.5); costReductionPercent → tag.cavalry (0.75) prereq: horsemanship
- **age 1 `coastal_forts`** (military) — attributeMultiplier → tag.naval.hp (2); costReductionPercent → tag.naval (0.5) prereq: heavy_oar_arrays, masonry
- **age 2 `aqueducts`** (civilian) — attributeMultiplier → houseCapacity (100) prereq: masonry, mathematics
- **age 2 `drama_poetry`** (civilian) — attributeMultiplier → allProduction (3); costReductionPercent → allBuildings (0.5) prereq: alphabet
- **age 2 `civil_service`** (civilian) — attributeMultiplier → allProduction (10); costReductionFactor → people (0.9) prereq: code_of_laws
- **age 2 `logic`** (civilian) — attributeMultiplier → science (100); costReductionPercent → allBuildings (0.75) prereq: philosophy_fundamentals
- **age 2 `currency_standard`** (civilian) — attributeMultiplier → gold (100); costReductionPercent → allBuildings (0.5) prereq: currency
- **age 2 `surveying`** (civilian) — attributeMultiplier → stone (100); costReductionPercent → allBuildings (0.5) prereq: mathematics
- **age 2 `crop_rotation`** (civilian) — attributeMultiplier → food (100); costReductionPercent → allBuildings (0.5) prereq: irrigation
- **age 2 `lumber_mills`** (civilian) — attributeMultiplier → wood (100); costReductionPercent → allBuildings (0.5) prereq: forestry, iron_mining
- **age 2 `architecture`** (civilian) — costReductionPercent → allBuildings (0.5); attributeMultiplier → allProduction (2) prereq: aqueducts
- **age 2 `banking_concepts`** (civilian) — attributeMultiplier → gold (2) prereq: currency_standard
- **age 2 `aesthetics`** (civilian) — attributeMultiplier → peopleCapacity (2); attributeMultiplier → houseCapacity (2); attributeMultiplier → farmCapacity (2); attributeMultiplier → lumberYardCapacity (2); attributeMultiplier → quarryCapacity (2); attributeMultiplier → goldMineCapacity (2); attributeMultiplier → townHallCapacity (2); attributeMultiplier → barracksCapacity (2); attributeMultiplier → universityCapacity (2); attributeMultiplier → smithyCapacity (2); attributeMultiplier → marketCapacity (2); attributeMultiplier → allProduction (2) prereq: drama_poetry, architecture
- **age 2 `scholasticism`** (civilian) — attributeMultiplier → science (2) prereq: logic
- **age 2 `legion_discipline`** (military) — attributeMultiplier → tag.infantry.hp (1.25) prereq: iron_forging unlocks: legionary
- **age 2 `phalanx_doctrine`** (military) — attributeMultiplier → tag.infantry.hp (1.25) prereq: iron_working unlocks: hoplite
- **age 2 `shock_cavalry`** (military) — attributeMultiplier → tag.armored.attack (1.25) prereq: horsemanship, cavalry_formations unlocks: companion
- **age 2 `recurve_archery`** (military) — attributeMultiplier → tag.ranged.attack (1.25) prereq: composite_bowcraft unlocks: archer_classical
- **age 2 `incendiary_weapons`** (military) — attributeMultiplier → tag.naval.attack (1.25) prereq: heavy_oar_arrays unlocks: fire_ship
- **age 2 `subterfuge`** (military) — attributeMultiplier → tag.infantry.hp (1.25) prereq: code_of_laws unlocks: assassin
- **age 2 `armed_merchant_navies`** (military) — attributeMultiplier → tag.naval.attack (1.25) prereq: trade_routes, shipbuilding_principles unlocks: trader_classical
- **age 2 `armor_layering`** (military) — attributeMultiplier → tag.infantry.hp (1.25); costReductionPercent → allUnits (0.5) prereq: iron_shielding
- **age 2 `siege_logistics`** (military) — costReductionPercent → tag.siege (0.75); attributeMultiplier → unitAll.attack (1.25) prereq: engineered_siegecraft
- **age 2 `naval_ramming`** (military) — attributeMultiplier → tag.naval.attack (1.25); costReductionPercent → tag.naval (0.5) prereq: heavy_oar_arrays
- **age 2 `martival_drill`** (military) — attributeMultiplier → unitAll.attack (1.25); costReductionPercent → allUnits (0.5) prereq: legion_discipline, phalanx_doctrine
- **age 3 `feudalism`** (civilian) — attributeMultiplier → food (100) prereq: civil_service
- **age 3 `guilds`** (civilian) — attributeMultiplier → gold (100); costReductionPercent → allBuildings (0.5) prereq: banking_concepts
- **age 3 `windmills`** (civilian) — attributeMultiplier → farmCapacity (100); attributeMultiplier → food (2) prereq: feudalism
- **age 3 `water_power`** (civilian) — attributeMultiplier → wood (100); costReductionPercent → allBuildings (0.5) prereq: lumber_mills
- **age 3 `gothic_architecture`** (civilian) — costReductionPercent → allBuildings (0.5); attributeMultiplier → allProduction (2) prereq: architecture
- **age 3 `cartography`** (civilian) — attributeMultiplier → trade (100); costReductionPercent → allBuildings (0.5) prereq: trade_routes
- **age 3 `universities`** (civilian) — attributeMultiplier → science (100); costReductionPercent → allBuildings (0.5) prereq: scholasticism
- **age 3 `patronage`** (civilian) — attributeMultiplier → allProduction (2) prereq: guilds
- **age 3 `manorialism`** (civilian) — attributeMultiplier → peopleCapacity (2) prereq: feudalism
- **age 3 `mining_shafts`** (civilian) — attributeMultiplier → stone (100); costReductionPercent → allBuildings (0.5) prereq: metallurgy_prep
- **age 3 `craftsmanship`** (civilian) — attributeMultiplier → metalwork (100); costReductionPercent → allBuildings (0.5) prereq: guilds
- **age 3 `plate_armor`** (military) — attributeMultiplier → tag.armored.attack (1.25) prereq: shock_cavalry, armor_layering unlocks: knight
- **age 3 `steel_crossbows`** (military) — attributeMultiplier → tag.ranged.attack (1.25) prereq: recurve_archery unlocks: crossbow
- **age 3 `professional_men_at_arms`** (military) — attributeMultiplier → tag.infantry.hp (1.25) prereq: legion_discipline unlocks: man_at_arms
- **age 3 `trebuchet_physics`** (military) — attributeMultiplier → unitAll.attack (1.25) prereq: heavy_counterweights unlocks: trebuchet
- **age 3 `clinker_building`** (military) — attributeMultiplier → tag.naval.attack (1.25) prereq: shipbuilding_principles unlocks: cog
- **age 3 `raiding_vessels`** (military) — attributeMultiplier → tag.naval.attack (1.25) prereq: clinker_building unlocks: longship
- **age 3 `early_black_powder`** (military) — attributeMultiplier → unitAll.attack (1.25) prereq: trebuchet_physics unlocks: bombard
- **age 3 `rigging_sails`** (military) — attributeMultiplier → tag.ranged.attack (1.25) prereq: clinker_building unlocks: caravel
- **age 3 `castle_fortification`** (military) — attributeMultiplier → unitAll.hp (1.25); costReductionPercent → allUnits (0.5) prereq: gothic_architecture
- **age 3 `crossbow_drills`** (military) — attributeMultiplier → tag.ranged.attack (1.25); costReductionPercent → tag.ranged (0.5) prereq: steel_crossbows
- **age 3 `chivalric_code`** (military) — attributeMultiplier → tag.armored.speed (1.25); costReductionPercent → tag.cavalry (0.5) prereq: plate_armor
- **age 4 `printing_press`** (civilian) — attributeMultiplier → science (100); costReductionPercent → allBuildings (0.5) prereq: universities, craftsmanship
- **age 4 `double_entry_bookkeeping`** (civilian) — attributeMultiplier → gold (100); costReductionPercent → allBuildings (0.5) prereq: guilds
- **age 4 `scientific_method`** (civilian) — attributeMultiplier → science (2) prereq: printing_press
- **age 4 `humanism`** (civilian) — attributeMultiplier → allProduction (2); costReductionPercent → allBuildings (0.5) prereq: printing_press
- **age 4 `metallurgy`** (civilian) — attributeMultiplier → metalwork (100); costReductionPercent → allBuildings (0.5) prereq: mining_shafts
- **age 4 `perspective_drawing`** (civilian) — attributeMultiplier → allProduction (2) prereq: architecture
- **age 4 `banking_houses`** (civilian) — attributeMultiplier → gold (2) prereq: double_entry_bookkeeping
- **age 4 `enclosure_acts`** (civilian) — attributeMultiplier → food (100); costReductionPercent → allBuildings (0.5) prereq: windmills
- **age 4 `naval_academies`** (civilian) — attributeMultiplier → trade (100); costReductionPercent → allBuildings (0.5) prereq: cartography
- **age 4 `clockwork_mechanics`** (civilian) — attributeFlat → autoClickRate (0.5); attributeMultiplier → allProduction (2) prereq: scientific_method
- **age 4 `tercio_formations`** (military) — attributeMultiplier → tag.infantry.hp (1.25) prereq: professional_men_at_arms, matchlock_mechanisms unlocks: pikeman_ren
- **age 4 `mounted_firearms`** (military) — attributeMultiplier → tag.ranged.attack (1.25) prereq: matchlock_mechanisms, chivalric_code unlocks: dragoon_ren
- **age 4 `heavy_cavalry_pistols`** (military) — attributeMultiplier → unitAll.attack (1.25) prereq: mounted_firearms unlocks: cuirassier
- **age 4 `cast_bronze_cannon`** (military) — attributeMultiplier → unitAll.attack (1.25) prereq: early_black_powder, metallurgy unlocks: cannon
- **age 4 `broadside_warfare`** (military) — attributeMultiplier → tag.naval.attack (1.25) prereq: rigging_sails, cast_bronze_cannon unlocks: galleon
- **age 4 `sailing_rigging`** (military) — attributeMultiplier → tag.ranged.attack (1.25) prereq: broadside_warfare unlocks: frigate_sail
- **age 4 `letters_of_marque`** (military) — attributeMultiplier → tag.naval.attack (1.25) prereq: sailing_rigging unlocks: privateer
- **age 4 `gunpowder_standardization`** (military) — attributeMultiplier → tag.ranged.attack (1.5); costReductionPercent → tag.ranged (0.5) prereq: matchlock_mechanisms
- **age 4 `star_fortresses`** (military) — attributeMultiplier → unitAll.hp (1.25); costReductionPercent → allUnits (0.5) prereq: castle_fortification, cast_bronze_cannon
- **age 4 `naval_bombardment`** (military) — attributeMultiplier → tag.naval.attack (1.25) prereq: broadside_warfare
- **age 5 `steam_engine`** (civilian) — attributeMultiplier → allProduction (100); costReductionPercent → allBuildings (0.01) prereq: clockwork_mechanics, metallurgy
- **age 5 `industrialization`** (civilian) — attributeMultiplier → allProduction (100) prereq: steam_engine
- **age 5 `assembly_line`** (civilian) — costReductionPercent → allBuildings (0.01); attributeMultiplier → allProduction (100) prereq: industrialization
- **age 5 `electricity`** (civilian) — attributeMultiplier → science (100); costReductionPercent → allBuildings (0.01) prereq: scientific_method
- **age 5 `corporations`** (civilian) — attributeMultiplier → gold (100); costReductionPercent → allBuildings (0.01) prereq: banking_houses
- **age 5 `railroads`** (civilian) — attributeFlat → clickPower (10); attributeMultiplier → allProduction (100) prereq: steam_engine, road_networks
- **age 5 `internal_combustion`** (civilian) — attributeMultiplier → allProduction (100) prereq: steam_engine
- **age 5 `synthetic_fertilizers`** (civilian) — attributeMultiplier → food (100); costReductionPercent → allBuildings (0.01) prereq: enclosure_acts
- **age 5 `refining`** (civilian) — attributeMultiplier → stone (100); costReductionPercent → allBuildings (0.01) prereq: internal_combustion
- **age 5 `pharmaceuticals`** (civilian) — attributeMultiplier → peopleCapacity (5) prereq: refining
- **age 5 `rifled_barrels`** (military) — attributeMultiplier → tag.infantry.hp (1.5) prereq: matchlock_mechanisms, gunpowder_standardization unlocks: line_infantry
- **age 5 `minie_ball_ammunition`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: rifled_barrels unlocks: rifleman
- **age 5 `industrial_cavalry_tactics`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: mounted_firearms unlocks: dragoon_ind
- **age 5 `lancer_charges`** (military) — attributeMultiplier → tag.armored.attack (1.5) prereq: heavy_cavalry_pistols unlocks: lancer
- **age 5 `rapid_fire_mechanics`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: minie_ball_ammunition unlocks: gatling
- **age 5 `ironclad_armor`** (military) — attributeMultiplier → tag.naval.attack (1.5) prereq: broadside_warfare, steam_engine unlocks: ironclad
- **age 5 `lighter_than_air_flight`** (military) — attributeMultiplier → unitAll.attack (1.5) prereq: steam_engine unlocks: zeppelin
- **age 5 `aeronautics`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: internal_combustion, lighter_than_air_flight unlocks: biplane
- **age 5 `submersible_hulls`** (military) — attributeMultiplier → tag.naval.attack (1.5) prereq: ironclad_armor unlocks: sub_early
- **age 5 `trench_warfare`** (military) — attributeMultiplier → unitAll.hp (1.5); costReductionPercent → allUnits (0.01) prereq: rapid_fire_mechanics
- **age 6 `computers`** (civilian) — attributeMultiplier → science (100); costReductionPercent → allBuildings (0.01) prereq: electricity
- **age 6 `nuclear_fission`** (civilian) — attributeMultiplier → allProduction (100); costReductionPercent → allBuildings (0.01) prereq: computers
- **age 6 `internet`** (civilian) — attributeMultiplier → science (100) prereq: computers
- **age 6 `automation`** (civilian) — costReductionPercent → allBuildings (0.01); attributeMultiplier → allProduction (100) prereq: assembly_line, computers
- **age 6 `genomics`** (civilian) — attributeMultiplier → food (100) prereq: pharmaceuticals
- **age 6 `renewable_energy`** (civilian) — attributeMultiplier → allProduction (100) prereq: electricity
- **age 6 `globalization`** (civilian) — attributeMultiplier → gold (100); costReductionPercent → allBuildings (0.01) prereq: internet, corporations
- **age 6 `microprocessors`** (civilian) — attributeFlat → clickPower (10); attributeMultiplier → allProduction (100) prereq: computers
- **age 6 `spaceflight`** (civilian) — attributeMultiplier → allProduction (100) prereq: nuclear_fission, microprocessors
- **age 6 `quantum_computing`** (civilian) — attributeMultiplier → science (100) prereq: microprocessors
- **age 6 `nanotechnology`** (civilian) — attributeMultiplier → allProduction (100); costReductionPercent → allBuildings (0.01) prereq: quantum_computing, genomics
- **age 6 `stormtrooper_tactics`** (military) — attributeMultiplier → tag.infantry.hp (1.5) prereq: trench_warfare unlocks: ww1_infantry
- **age 6 `combined_arms_armor`** (military) — attributeMultiplier → tag.infantry.hp (1.5) prereq: stormtrooper_tactics unlocks: ww2_infantry
- **age 6 `motorized_infantry`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: combined_arms_armor, internal_combustion unlocks: dragoon_mech
- **age 6 `armored_warfare`** (military) — attributeMultiplier → tag.armored.attack (1.5) prereq: combined_arms_armor unlocks: tank_ww2
- **age 6 `piston_engine_fighters`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: aeronautics unlocks: fighter_ww2
- **age 6 `strategic_bombing`** (military) — attributeMultiplier → unitAll.attack (1.5) prereq: piston_engine_fighters unlocks: bomber_ww2
- **age 6 `naval_aviation`** (military) — attributeMultiplier → tag.naval.attack (1.5) prereq: piston_engine_fighters unlocks: carrier_ww2
- **age 6 `dreadnought_armor`** (military) — attributeMultiplier → tag.naval.attack (1.5) prereq: ironclad_armor unlocks: battleship
- **age 6 `composite_armor`** (military) — attributeMultiplier → tag.armored.attack (1.5) prereq: armored_warfare unlocks: tank_abrams
- **age 6 `stealth_technology`** (military) — attributeMultiplier → unitAll.attack (1.5) prereq: piston_engine_fighters unlocks: fighter_jet
- **age 6 `guided_missiles`** (military) — attributeMultiplier → tag.naval.attack (1.5) prereq: dreadnought_armor, computers unlocks: destroyer_modern
- **age 6 `armored_cavalry_doctrine`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: motorized_infantry unlocks: dragoon_modern
- **age 6 `unmanned_aerial_systems`** (military) — attributeMultiplier → tag.ranged.attack (1.5) prereq: stealth_technology, microprocessors unlocks: drone
- **age 6 `helicopter_rotor_systems`** (military) — attributeMultiplier → unitAll.attack (1.5) prereq: piston_engine_fighters unlocks: attack_heli
- **age 6 `rocket_artillery`** (military) — attributeMultiplier → unitAll.attack (1.5) prereq: heavy_rifled_artillery, guided_missiles unlocks: artillery_modern
- **age 6 `special_operations`** (military) — attributeMultiplier → tag.infantry.hp (1.5) prereq: assault_rifles unlocks: special_forces
- **age 6 `radar_low_observability`** (military) — attributeMultiplier → unitAll.attack (1.5) prereq: strategic_bombing, stealth_technology unlocks: bomber_stealth
- **age 6 `orbital_arrays`** (military) — attributeMultiplier → unitAll.attack (1.5) prereq: spaceflight unlocks: satellite
- **age 6 `exoskeletons`** (military) — attributeMultiplier → unitAll.attack (1.5) prereq: special_operations, nanotechnology unlocks: mech_suit
- **age 6 `interstellar_infantry`** (military) — attributeMultiplier → tag.infantry.hp (1.5) prereq: exoskeletons, spaceflight unlocks: starship

## Units (79)

| age | count | ids |
| --- | --- | --- |
| 0 | 12 | `warrior`, `slinger`, `archer_prehist`, `wolf`, `bear`, `canoe`, `spearman_bronze`, `axeman_bronze`, `chariot_bronze`, `bowman_bronze`, `trireme_bronze`, `catapult_ancient` |
| 1 | 8 | `spearman_iron`, `swordsman_iron`, `chariot_iron`, `cavalry_iron`, `war_galley_iron`, `elephant_iron`, `ballista`, `quinquereme` |
| 2 | 8 | `legionary`, `hoplite`, `companion`, `archer_classical`, `onager`, `fire_ship`, `assassin`, `trader_classical` |
| 3 | 9 | `knight`, `longbow`, `crossbow`, `man_at_arms`, `trebuchet`, `cog`, `longship`, `bombard`, `caravel` |
| 4 | 8 | `musketeer`, `pikeman_ren`, `dragoon_ren`, `cuirassier`, `cannon`, `galleon`, `frigate_sail`, `privateer` |
| 5 | 10 | `line_infantry`, `rifleman`, `dragoon_ind`, `lancer`, `gatling`, `ironclad`, `zeppelin`, `biplane`, `howitzer_ind`, `sub_early` |
| 6 | 24 | `ww1_infantry`, `ww2_infantry`, `dragoon_mech`, `tank_ww2`, `fighter_ww2`, `bomber_ww2`, `battleship`, `carrier_ww2`, `soldier_modern`, `tank_abrams`, `fighter_jet`, `destroyer_modern`, `dragoon_modern`, `drone`, `attack_heli`, `artillery_modern`, `sub_nuclear`, `carrier_nuclear`, `special_forces`, `bomber_stealth`, `satellite`, `orbital_laser`, `mech_suit`, `starship` |

### Unit stats

| id | name | domain | tier | hp | attack | armor | range | speed | acc | costs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `warrior` | Tribesman | ground | 1 | 100 | 9 | 0.1 | 1 | 5 | 0.5 | military 150×3.5 + food 5.000e+3×3.5 |
| `slinger` | Slinger | ground | 2 | 50 | 20 | 0 | 4 | 7 | 0.6 | military 500×4.5 + stone 2.000e+4×4.5 |
| `archer_prehist` | Stone Bowman | ground | 3 | 60 | 30 | 0 | 4 | 6 | 0.6 | military 2.000e+3×4.5 + wood 1.000e+5×4.5 |
| `wolf` | Wolf | ground | — | 50 | 12 | 0.05 | 1 | 8 | 0.7 |  |
| `bear` | Bear | ground | — | 150 | 25 | 0.15 | 1 | 4 | 0.85 |  |
| `canoe` | Dugout Canoe | naval | 4 | 80 | 12 | 0.1 | 2 | 6 | 0.7 | military 2.500e+4×4.5 + wood 4.000e+5×4.5 |
| `spearman_bronze` | Bronze Spearman | ground | 5 | 90 | 20 | 0.2 | 2 | 5 | 0.85 | military 1.000e+5×2.5 + metalwork 5.000e+3×2.5 |
| `axeman_bronze` | Bronze Axeman | ground | 6 | 110 | 26 | 0.15 | 1 | 5 | 0.9 | military 3.000e+5×2.5 + metalwork 1.000e+4×2.5 |
| `chariot_bronze` | Bronze Chariot | ground | 7 | 180 | 60 | 0.25 | 2 | 8 | 0.7 | military 2.000e+6×4.5 + metalwork 2.000e+4×4.5 |
| `bowman_bronze` | Bronze Bowman | ground | 8 | 80 | 45 | 0.05 | 5 | 6 | 0.8 | military 2.000e+5×4.5 + metalwork 1.000e+4×4.5 + wood 2.000e+6×4.5 |
| `trireme_bronze` | Bronze Galley | naval | 9 | 250 | 40 | 0.3 | 4 | 6 | 0.65 | military 1.000e+7×4.5 + metalwork 1.000e+5×4.5 + wood 3.000e+8×4.5 |
| `catapult_ancient` | Catapult | ground | 10 | 150 | 100 | 0.1 | 8 | 2 | 0.45 | military 2.000e+7×4.5 + metalwork 1.000e+5×4.5 |
| `spearman_iron` | Iron Spearman | ground | 11 | 760 | 192 | 0.25 | 2 | 5 | 0.85 | military 6.953e+7×2.5 + metalwork 6.953e+6×2.5 |
| `swordsman_iron` | Iron Swordsman | ground | 12 | 920 | 240 | 0.3 | 1 | 5 | 0.85 | military 1.410e+8×2.5 + metalwork 1.410e+7×2.5 |
| `chariot_iron` | Iron Chariot | ground | 13 | 1.600e+3 | 320 | 0.35 | 2 | 8 | 0.7 | military 2.859e+8×3.5 + metalwork 2.859e+7×3.5 |
| `cavalry_iron` | Iron Cavalry | ground | 14 | 1.440e+3 | 288 | 0.3 | 1 | 8 | 0.75 | military 5.797e+8×3.5 + metalwork 5.797e+7×3.5 |
| `war_galley_iron` | War Galley | naval | 15 | 2.400e+3 | 280 | 0.35 | 3 | 5 | 0.6 | military 1.176e+9×4.5 + metalwork 1.176e+8×4.5 + wood 2.351e+9×4.5 |
| `elephant_iron` | War Elephant | ground | 16 | 5.000e+3 | 500 | 0.4 | 1 | 4 | 0.75 | military 2.384e+9×4 + metalwork 2.384e+8×4 + food 1.192e+10×4.5 |
| `ballista` | Ballista | ground | 17 | 880 | 440 | 0.15 | 9 | 2 | 0.6 | military 4.834e+9×4 + metalwork 4.834e+8×4 |
| `quinquereme` | Quinquereme | naval | 18 | 3.200e+3 | 360 | 0.45 | 5 | 5 | 0.6 | military 9.802e+9×4.5 + metalwork 9.802e+8×4.5 + wood 1.960e+10×4.5 |
| `legionary` | Legionary | ground | 19 | 7.680e+3 | 1.792e+3 | 0.35 | 1 | 5 | 0.9 | military 1.988e+10×1.5 + metalwork 1.988e+9×1.5 |
| `hoplite` | Hoplite | ground | 20 | 8.320e+3 | 1.920e+3 | 0.4 | 2 | 4 | 0.85 | military 2.306e+12×4.5 + metalwork 2.306e+11×4.5 |
| `companion` | Companion Cavalry | ground | 21 | 1.280e+4 | 2.560e+3 | 0.35 | 1 | 8 | 0.8 | military 1.042e+15×4.5 + metalwork 1.042e+14×4.5 |
| `archer_classical` | Composite Archer | ground | 22 | 4.800e+3 | 1.408e+3 | 0.1 | 6 | 6 | 0.75 | military 1.273e+18×4.5 + metalwork 1.273e+17×4.5 |
| `onager` | Onager | ground | 23 | 7.680e+3 | 3.840e+3 | 0.15 | 8 | 2 | 0.5 | military 2.914e+22×4.5 + metalwork 2.914e+21×4.5 |
| `fire_ship` | Fire Ship | naval | 24 | 9.600e+3 | 3.840e+3 | 0.1 | 2 | 7 | 0.6 | military 3.972e+27×4.5 + metalwork 3.972e+26×4.5 + wood 7.944e+26×4.5 |
| `assassin` | Assassin | ground | 25 | 3.840e+3 | 2.240e+3 | 0.05 | 1 | 9 | 0.9 | military 7.906e+33×4.5 + metalwork 7.906e+32×4.5 |
| `trader_classical` | Trade Galley | naval | 26 | 1.280e+4 | 320 | 0.1 | 1 | 6 | 0.5 | military 4.870e+41×4.5 + metalwork 4.870e+40×4.5 + wood 9.740e+40×4.5 |
| `knight` | Knight | ground | 27 | 1.126e+5 | 2.304e+4 | 0.55 | 1 | 7 | 0.85 | military 4.933e+81×4.5 + metalwork 4.933e+80×4.5 |
| `longbow` | Longbowman | ground | 28 | 3.840e+4 | 1.434e+4 | 0.1 | 7 | 6 | 0.78 | military 1.609e+99×4.5 + metalwork 1.609e+98×4.5 |
| `crossbow` | Crossbowman | ground | 29 | 4.352e+4 | 1.638e+4 | 0.2 | 6 | 4 | 0.75 | military 6.585e+120×4.5 + metalwork 6.585e+119×4.5 |
| `man_at_arms` | Man-at-Arms | ground | 30 | 7.680e+4 | 1.792e+4 | 0.45 | 1 | 5 | 0.85 | military 1.692e+147×4.5 + metalwork 1.692e+146×4.5 |
| `trebuchet` | Trebuchet | ground | 31 | 6.656e+4 | 4.096e+4 | 0.1 | 11 | 1 | 0.5 | military 5.670e+179×4.5 + metalwork 5.670e+178×4.5 |
| `cog` | Cog | naval | 32 | 1.536e+5 | 1.280e+4 | 0.25 | 3 | 5 | 0.6 | military 7.286e+218×4.5 + metalwork 7.286e+217×4.5 + wood 1.457e+218×4.5 |
| `longship` | Longship | naval | 33 | 1.434e+5 | 1.792e+4 | 0.2 | 2 | 7 | 0.65 | military 1.577e+267×4.5 + metalwork 1.577e+266×4.5 + wood 3.154e+266×4.5 |
| `bombard` | Bombard Cannon | ground | 34 | 7.168e+4 | 3.584e+4 | 0.15 | 9 | 2 | 0.45 | military 2.5801e326×4.5 + metalwork 2.5801e325×4.5 |
| `caravel` | Caravel | naval | 35 | 1.638e+5 | 1.536e+4 | 0.25 | 5 | 6 | 0.6 | military 2.0145e398×4.5 + metalwork 2.0145e397×4.5 + wood 4.0290e397×4.5 |
| `musketeer` | Musketeer | ground | 36 | 3.482e+5 | 2.253e+5 | 0.15 | 6 | 3 | 0.55 | military 2.4350e794×4.5 + metalwork 2.4350e793×4.5 |
| `pikeman_ren` | Tercio Pikeman | ground | 37 | 4.915e+5 | 1.229e+5 | 0.4 | 3 | 4 | 0.8 | military 7.8179e998×4.5 + metalwork 7.8179e997×4.5 |
| `dragoon_ren` | Dragoon - Renaissance | ground | 38 | 7.373e+5 | 1.720e+5 | 0.25 | 6 | 8 | 0.6 | military 3.7972e1256×4.5 + metalwork 3.7972e1255×4.5 |
| `cuirassier` | Cuirassier | ground | 39 | 9.830e+5 | 2.048e+5 | 0.5 | 1 | 7 | 0.8 | military 6.4957e1580×4.5 + metalwork 6.4957e1579×4.5 |
| `cannon` | Field Cannon | ground | 40 | 6.144e+5 | 3.482e+5 | 0.15 | 10 | 2 | 0.5 | military 9.3215e1988×4.5 + metalwork 9.3215e1987×4.5 |
| `galleon` | Galleon | naval | 41 | 2.048e+6 | 2.048e+5 | 0.4 | 6 | 5 | 0.6 | military 1.7249e2502×4.5 + metalwork 1.7249e2501×4.5 + wood 3.4498e2501×4.5 |
| `frigate_sail` | Sailing Frigate | naval | 42 | 1.843e+6 | 1.843e+5 | 0.35 | 6 | 6 | 0.62 | military 2.3578e3148×4.5 + metalwork 2.3578e3147×4.5 + wood 4.7157e3147×4.5 |
| `privateer` | Privateer | naval | 43 | 1.556e+6 | 1.638e+5 | 0.3 | 5 | 7 | 0.65 | military 3.4628e3961×4.5 + metalwork 3.4628e3960×4.5 + wood 6.9255e3960×4.5 |
| `line_infantry` | Line Infantry | ground | 44 | 3.277e+6 | 1.311e+6 | 0.25 | 7 | 4 | 0.65 | military 3.9969e7920×4.5 + metalwork 3.9969e7919×4.5 + science 1.9985e7920×4.5 |
| `rifleman` | Rifleman | ground | 45 | 3.113e+6 | 1.475e+6 | 0.2 | 8 | 5 | 0.7 | military 1.2871e9471×4.5 + metalwork 1.2871e9470×4.5 + science 6.4354e9470×4.5 |
| `dragoon_ind` | Dragoon - Industrial | ground | 46 | 6.226e+6 | 1.573e+6 | 0.28 | 7 | 8 | 0.7 | military 1.6046e11325×4.5 + metalwork 1.6046e11324×4.5 + science 8.0232e11324×4.5 |
| `lancer` | Lancer | ground | 47 | 6.554e+6 | 1.573e+6 | 0.3 | 2 | 8 | 0.75 | military 2.1582e13542×4.5 + metalwork 2.1582e13541×4.5 + science 1.0791e13542×4.5 |
| `gatling` | Gatling Gun | ground | 48 | 3.932e+6 | 1.966e+6 | 0.2 | 6 | 2 | 0.6 | military 4.7469e16193×4.5 + metalwork 4.7469e16192×4.5 + science 2.3734e16193×4.5 |
| `ironclad` | Ironclad | naval | 49 | 2.294e+7 | 2.294e+6 | 0.65 | 6 | 3 | 0.6 | military 1.4231e19364×4.5 + metalwork 1.4231e19363×4.5 + wood 2.8462e19363×4.5 + science 7.1154e19363×4.5 |
| `zeppelin` | Zeppelin | air | 50 | 1.311e+7 | 1.966e+6 | 0.2 | 10 | 4 | 0.55 | military 2.1820e23155×4.5 + metalwork 2.1820e23154×4.5 + science 1.0910e23155×4.5 |
| `biplane` | Biplane | air | 51 | 5.898e+6 | 1.638e+6 | 0.1 | 9 | 9 | 0.65 | military 7.7939e27688×4.5 + metalwork 7.7939e27687×4.5 + science 3.8970e27688×4.5 |
| `howitzer_ind` | Howitzer | ground | 52 | 5.243e+6 | 3.113e+6 | 0.15 | 12 | 2 | 0.55 | military 2.8773e33110×4.5 + metalwork 2.8773e33109×4.5 + science 1.4387e33110×4.5 |
| `sub_early` | Early Submarine | naval | 53 | 1.147e+7 | 2.130e+6 | 0.4 | 5 | 4 | 0.6 | military 1.7841e39593×4.5 + metalwork 1.7841e39592×4.5 + wood 3.5681e39592×4.5 + science 8.9204e39592×4.5 |
| `ww1_infantry` | WW1 Infantry | ground | 54 | 2.359e+7 | 9.175e+6 | 0.25 | 7 | 5 | 0.7 | military 4.8460e79183×4.5 + metalwork 4.8460e79182×4.5 + science 2.4230e79183×4.5 |
| `ww2_infantry` | WW2 Infantry | ground | 55 | 2.884e+7 | 1.101e+7 | 0.3 | 8 | 5 | 0.75 | military 8.9164e84922×4.5 + metalwork 8.9164e84921×4.5 + science 4.4582e84922×4.5 |
| `dragoon_mech` | Dragoon - Motorized | ground | 56 | 5.767e+7 | 1.442e+7 | 0.35 | 7 | 9 | 0.75 | military 1.7183e91078×4.5 + metalwork 1.7183e91077×4.5 + science 8.5913e91077×4.5 |
| `tank_ww2` | Sherman Tank | ground | 57 | 1.180e+8 | 2.884e+7 | 0.75 | 8 | 4 | 0.75 | military 6.5674e97679×4.5 + metalwork 6.5674e97678×4.5 + science 3.2837e97679×4.5 |
| `fighter_ww2` | P-51 Fighter | air | 58 | 5.767e+7 | 1.835e+7 | 0.15 | 10 | 10 | 0.72 | military 3.0165e104759×4.5 + metalwork 3.0165e104758×4.5 + science 1.5082e104759×4.5 |
| `bomber_ww2` | B-17 Bomber | air | 59 | 9.175e+7 | 3.932e+7 | 0.25 | 13 | 6 | 0.6 | military 5.4569e112352×4.5 + metalwork 5.4569e112351×4.5 + science 2.7285e112352×4.5 |
| `battleship` | Battleship | naval | 60 | 3.146e+8 | 4.719e+7 | 0.75 | 14 | 3 | 0.65 | military 1.3900e120496×4.5 + metalwork 1.3900e120495×4.5 + wood 2.7800e120495×4.5 + science 6.9501e120495×4.5 |
| `carrier_ww2` | Carrier WW2 | naval | 61 | 2.621e+8 | 7.864e+6 | 0.5 | 5 | 4 | 0.5 | military 1.3227e129229×4.5 + metalwork 1.3227e129228×4.5 + wood 2.6454e129228×4.5 + science 6.6134e129228×4.5 |
| `soldier_modern` | Modern Soldier | ground | 62 | 3.146e+7 | 1.258e+7 | 0.4 | 8 | 6 | 0.85 | military 7.2882e138595×4.5 + metalwork 7.2882e138594×4.5 + science 3.6441e138595×4.5 |
| `tank_abrams` | Abrams Tank | ground | 63 | 1.835e+8 | 4.194e+7 | 0.82 | 9 | 5 | 0.85 | military 6.3561e148641×4.5 + metalwork 6.3561e148640×4.5 + science 3.1780e148641×4.5 |
| `fighter_jet` | F-35 Fighter | air | 64 | 9.175e+7 | 2.884e+7 | 0.3 | 14 | 10 | 0.88 | military 1.9888e159415×4.5 + metalwork 1.9888e159414×4.5 + science 9.9442e159414×4.5 + gold 4.9721e159414×4.5 |
| `destroyer_modern` | Burke Destroyer | naval | 65 | 2.884e+8 | 3.670e+7 | 0.6 | 15 | 7 | 0.82 | military 8.3164e170969×4.5 + metalwork 8.3164e170968×4.5 + wood 1.6633e170969×4.5 + science 4.1582e170969×4.5 + gold 2.0791e170969×4.5 |
| `dragoon_modern` | Dragoon - Armored | ground | 66 | 1.049e+8 | 1.835e+7 | 0.55 | 8 | 9 | 0.85 | military 4.9707e183361×4.5 + metalwork 4.9707e183360×4.5 + science 2.4853e183361×4.5 |
| `drone` | Reaper Drone | air | 67 | 3.146e+7 | 2.359e+7 | 0.1 | 16 | 10 | 0.92 | military 1.0196e196652×4.5 + metalwork 1.0196e196651×4.5 + science 5.0978e196651×4.5 + gold 2.5489e196651×4.5 |
| `attack_heli` | Apache Helicopter | air | 68 | 7.864e+7 | 3.146e+7 | 0.35 | 10 | 9 | 0.85 | military 4.3621e210905×4.5 + metalwork 4.3621e210904×4.5 + science 2.1810e210905×4.5 |
| `artillery_modern` | M270 MLRS | ground | 69 | 6.554e+7 | 4.981e+7 | 0.25 | 16 | 3 | 0.75 | military 2.9243e226192×4.5 + metalwork 2.9243e226191×4.5 + science 1.4621e226192×4.5 |
| `sub_nuclear` | Nuclear Submarine | naval | 70 | 2.359e+8 | 4.194e+7 | 0.65 | 12 | 6 | 0.85 | military 1.1372e242587×4.5 + metalwork 1.1372e242586×4.5 + wood 2.2745e242586×4.5 + science 5.6862e242586×4.5 + gold 2.8431e242586×4.5 |
| `carrier_nuclear` | Nuclear Carrier | naval | 71 | 4.719e+8 | 1.311e+7 | 0.65 | 8 | 4 | 0.6 | military 4.1638e260169×4.5 + metalwork 4.1638e260168×4.5 + wood 8.3277e260168×4.5 + science 2.0819e260169×4.5 |
| `special_forces` | Special Forces | ground | 72 | 2.884e+7 | 1.704e+7 | 0.35 | 7 | 8 | 0.9 | military 1.3373e279027×4.5 + metalwork 1.3373e279026×4.5 + science 6.6865e279026×4.5 |
| `bomber_stealth` | Stealth Bomber | air | 73 | 1.049e+8 | 5.767e+7 | 0.35 | 18 | 8 | 0.8 | military 6.6462e299251×4.5 + metalwork 6.6462e299250×4.5 + science 3.3231e299251×4.5 + gold 1.6616e299251×4.5 |
| `satellite` | Military Satellite | air | 74 | 2.621e+7 | 0 | 0.05 | 25 | 0 | 1 | military 7.6231e320940×4.5 + metalwork 7.6231e320939×4.5 + science 3.8115e320940×4.5 + gold 1.9058e320940×4.5 |
| `orbital_laser` | Orbital Laser | air | 75 | 1.311e+8 | 7.864e+7 | 0.4 | 30 | 0 | 0.95 | military 2.3388e344204×4.5 + metalwork 2.3388e344203×4.5 + science 1.1694e344204×4.5 + gold 5.8470e344203×4.5 |
| `mech_suit` | Mech Suit | ground | 76 | 2.097e+8 | 4.719e+7 | 0.85 | 10 | 6 | 0.9 | military 3.4972e369152×4.5 + metalwork 3.4972e369151×4.5 + science 1.7486e369152×4.5 + gold 8.7430e369151×4.5 |
| `starship` | Starship Trooper | air | 77 | 2.621e+8 | 6.554e+7 | 0.9 | 20 | 10 | 0.95 | military 2.2939e395909×4.5 + metalwork 2.2939e395908×4.5 + science 1.1469e395909×4.5 + gold 5.7347e395908×4.5 |

### Matchups — `tags`, `canHit` and `bonusVs`

This is the rock-paper-scissors surface, and it is where naval balance lives.

- `tags` — unit classes, used for `same_tag` battle orders.
- `canHit` — which domains this unit may target at all.
- `bonusVs` — **tag list this unit deals a damage bonus against** (e.g.
  `spearman_bronze` and `catapult_ancient` both have `bonusVs: ["armored"]`).
  A naval unit with no entry here takes nothing from an armoured line, and
  vice versa — this is the lever for an anti-naval or anti-armour rebalance.

| id | domain | tags | canHit | bonusVs |
| --- | --- | --- | --- | --- |
| `warrior` | ground | infantry | ground | — |
| `slinger` | ground | ranged | ground,air,naval | — |
| `archer_prehist` | ground | ranged | ground,air,naval | — |
| `wolf` | ground | beast | ground | — |
| `bear` | ground | beast | ground | — |
| `canoe` | naval | naval | ground,naval | — |
| `spearman_bronze` | ground | infantry,antiArmor | ground | armored |
| `axeman_bronze` | ground | infantry | ground | — |
| `chariot_bronze` | ground | armored,cavalry | ground | — |
| `bowman_bronze` | ground | ranged | ground,air,naval | — |
| `trireme_bronze` | naval | naval,ranged | naval,ground | — |
| `catapult_ancient` | ground | antiArmor,siege | ground | armored |
| `spearman_iron` | ground | infantry,antiArmor | ground | armored |
| `swordsman_iron` | ground | infantry | ground | — |
| `chariot_iron` | ground | armored,cavalry | ground | — |
| `cavalry_iron` | ground | armored,cavalry | ground | — |
| `war_galley_iron` | naval | naval,armored | naval,ground | — |
| `elephant_iron` | ground | armored,cavalry | ground | — |
| `ballista` | ground | antiArmor,ranged,siege | ground,naval,air | armored,air |
| `quinquereme` | naval | naval,armored | naval,ground | — |
| `legionary` | ground | infantry,armored | ground | — |
| `hoplite` | ground | infantry,armored | ground | — |
| `companion` | ground | armored,cavalry | ground | — |
| `archer_classical` | ground | ranged | ground,air,naval | — |
| `onager` | ground | antiArmor,siege | ground,naval | armored |
| `fire_ship` | naval | naval | naval | naval |
| `assassin` | ground | infantry | ground | — |
| `trader_classical` | naval | naval |  | — |
| `knight` | ground | armored,cavalry | ground | — |
| `longbow` | ground | ranged | ground,air,naval | air |
| `crossbow` | ground | ranged,antiArmor | ground,air,naval | armored |
| `man_at_arms` | ground | infantry,armored | ground | — |
| `trebuchet` | ground | antiArmor,siege | ground,naval | armored |
| `cog` | naval | naval | naval | — |
| `longship` | naval | naval | naval,ground | — |
| `bombard` | ground | antiArmor,siege | ground,naval | armored |
| `caravel` | naval | naval,ranged | naval,ground | — |
| `musketeer` | ground | ranged | ground,air | — |
| `pikeman_ren` | ground | infantry,antiArmor | ground | — |
| `dragoon_ren` | ground | ranged,armored,cavalry | ground,air | — |
| `cuirassier` | ground | armored,cavalry | ground | — |
| `cannon` | ground | antiArmor,siege | ground,naval | armored |
| `galleon` | naval | naval,armored | naval,ground | — |
| `frigate_sail` | naval | naval,ranged | naval,ground | — |
| `privateer` | naval | naval | naval,ground | — |
| `line_infantry` | ground | infantry | ground,air | — |
| `rifleman` | ground | ranged | ground,air | — |
| `dragoon_ind` | ground | ranged,armored,cavalry | ground,air | — |
| `lancer` | ground | armored,cavalry | ground | — |
| `gatling` | ground | ranged,antiArmor | ground,air | infantry |
| `ironclad` | naval | naval,armored | naval,ground | — |
| `zeppelin` | air | air,armored | ground | — |
| `biplane` | air | air,ranged | ground,air | — |
| `howitzer_ind` | ground | antiArmor,siege | ground,naval | armored |
| `sub_early` | naval | naval | naval | naval |
| `ww1_infantry` | ground | infantry | ground,air | — |
| `ww2_infantry` | ground | infantry | ground,air | — |
| `dragoon_mech` | ground | ranged,armored,cavalry | ground,air | — |
| `tank_ww2` | ground | armored,antiArmor,cavalry | ground,naval | armored |
| `fighter_ww2` | air | air,ranged | air,ground | — |
| `bomber_ww2` | air | air,antiArmor | ground,naval | — |
| `battleship` | naval | naval,armored | naval,ground,air | — |
| `carrier_ww2` | naval | naval,armored | air | — |
| `soldier_modern` | ground | infantry | ground,air | — |
| `tank_abrams` | ground | armored,antiArmor,cavalry | ground,naval | armored |
| `fighter_jet` | air | air,antiArmor | air,ground,naval | — |
| `destroyer_modern` | naval | naval,antiArmor | naval,air,ground | — |
| `dragoon_modern` | ground | armored,ranged,cavalry | ground,air,naval | — |
| `drone` | air | air,ranged | ground | — |
| `attack_heli` | air | air,antiArmor | ground,naval,air | — |
| `artillery_modern` | ground | antiArmor,siege | ground,naval | — |
| `sub_nuclear` | naval | naval | naval,ground | — |
| `carrier_nuclear` | naval | naval,armored | air | — |
| `special_forces` | ground | infantry | ground,air | — |
| `bomber_stealth` | air | air,antiArmor | ground,naval | — |
| `satellite` | air | air |  | — |
| `orbital_laser` | air | air,antiArmor,siege | ground,naval | — |
| `mech_suit` | ground | armored,antiArmor,cavalry | ground,air,naval | — |
| `starship` | air | armored,infantry | ground,air,naval | — |

## Encounters (24)

| key | name | age | year | boss | enemy army | victory bonuses | unlocks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `age0_1_first_fire` | First Fire | 0 | -8000 |  | wolf×8 | attributeMultiplier → military (1.5); attributeMultiplier → townHallCapacity (2); attributeMultiplier → barracksCapacity (2) | — |
| `age0_2_wolf_pack` | Wolf Pack | 0 | -8000 |  | wolf×35, bear×8 | attributeMultiplier → military (1.5); attributeMultiplier → townHallCapacity (5); attributeMultiplier → wood (4); attributeMultiplier → science (2) | — |
| `age0_3_bronze_raid` | Bronze Raid | 0 | -3000 |  | axeman_bronze×100, slinger×50 | attributeMultiplier → military (2); attributeMultiplier → metalwork (3); attributeMultiplier → smithyCapacity (2) | — |
| `age0_boss_troy` | Fall of Troy | 0 | -1180 | **yes** | spearman_bronze×80, bowman_bronze×120, chariot_bronze×20, trireme_bronze×15 | attributeMultiplier → military (4); attributeMultiplier → metalwork (4); attributeMultiplier → universityCapacity (2) | — |
| `age1_1_kadesh_iron` | Kadesh | 1 | -1274 |  | chariot_bronze×2500, spearman_bronze×10000, bowman_bronze×2000 | attributeMultiplier → military (2); attributeMultiplier → barracksCapacity (2) | — |
| `age1_2_assyrian_siege` | Assyrian Siege | 1 | -700 |  | spearman_iron×20000, ballista×10, bowman_bronze×10000, war_galley_iron×1000 | attributeMultiplier → trade (2); attributeMultiplier → marketCapacity (2) | — |
| `age1_boss_iron_collapse` | The Sea Peoples | 1 | -500 | **yes** | spearman_iron×100000, cavalry_iron×10000, elephant_iron×200, bowman_bronze×50000, quinquereme×2000 | attributeMultiplier → wood (50); attributeMultiplier → food (1.000e+3); attributeMultiplier → stone (50) | — |
| `age2_1_marathon` | Marathon | 2 | -490 |  | archer_classical×150000, spearman_iron×200000 | attributeMultiplier → military (5) | — |
| `age2_2_cannae` | Cannae | 2 | -216 |  | legionary×300000, elephant_iron×4000 | attributeMultiplier → military (5) | — |
| `age2_boss_gaugamela` | Gaugamela | 2 | -331 | **yes** | chariot_iron×500000, elephant_iron×100000, spearman_iron×6000000 | attributeMultiplier → military (1.1); attributeMultiplier → unitAll.hp (1.05); attributeMultiplier → unitAll.attack (1.05) | — |
| `age3_1_tours` | Battle of Tours | 3 | 732 |  | knight×3 | attributeMultiplier → military (1.05) | — |
| `age3_2_hastings` | Hastings | 3 | 1066 |  | man_at_arms×4 | attributeMultiplier → military (1.05) | — |
| `age3_boss_castillon` | Castillon | 3 | 1453 | **yes** | longbow×3, man_at_arms×2 | attributeMultiplier → military (1.1); attributeMultiplier → unitAll.hp (1.05); attributeMultiplier → unitAll.attack (1.05) | — |
| `age4_1_pavia` | Pavia | 4 | 1525 |  | knight×2, man_at_arms×3 | attributeMultiplier → military (1.05) | — |
| `age4_2_lepanto` | Lepanto | 4 | 1571 |  | war_galley_iron×4, privateer×2 | attributeMultiplier → military (1.05) | — |
| `age4_boss_vienna` | Vienna 1683 | 4 | 1683 | **yes** | musketeer×6, cannon×4 | attributeMultiplier → military (1.1); attributeMultiplier → unitAll.hp (1.05); attributeMultiplier → unitAll.attack (1.05) | — |
| `age5_1_waterloo` | Waterloo | 5 | 1815 |  | line_infantry×7, lancer×1, howitzer_ind×2 | attributeMultiplier → military (1.05) | — |
| `age5_2_gettysburg` | Gettysburg | 5 | 1863 |  | rifleman×4, lancer×2 | attributeMultiplier → military (1.05) | — |
| `age5_boss_somme` | The Somme | 5 | 1916 | **yes** | rifleman×8, gatling×3 | attributeMultiplier → military (1.1); attributeMultiplier → unitAll.hp (1.05); attributeMultiplier → unitAll.attack (1.05) | — |
| `age6_1_midway` | Midway | 6 | 1942 |  | carrier_ww2×2, battleship×1 | attributeMultiplier → military (1.05) | — |
| `age6_2_berlin_1945` | Berlin 1945 | 6 | 1945 |  | tank_ww2×2, ww2_infantry×4 | attributeMultiplier → military (1.05) | — |
| `age6_3_desert_storm` | Desert Storm | 6 | 1991 |  | tank_ww2×4, soldier_modern×3 | attributeMultiplier → military (1.05) | — |
| `age6_4_drone_war` | Drone War | 6 | 2022 |  | tank_abrams×2, artillery_modern×2 | attributeMultiplier → military (1.05) | — |
| `age6_boss_orbital` | Orbital War | 6 | 2100 | **yes** | mech_suit×3, orbital_laser×1, satellite×2 | attributeMultiplier → military (1.1); attributeMultiplier → unitAll.hp (1.05); attributeMultiplier → unitAll.attack (1.05) | — |

## Ages

| key | name | building threshold | research base | research factor | bonuses |
| --- | --- | --- | --- | --- | --- |
| `age0` | Ancient | 0 | 200 | 12 | attributeMultiplier → townHallCapacity (5); attributeMultiplier → buildingPower (1.2); costReductionFactor → townHall (1.913) |
| `age1` | Iron Age | 1.500e+3 | 1.000e+9 | 230 | attributeMultiplier → townHallCapacity (2); attributeMultiplier → buildingPower (1.5) |
| `age2` | Classical | 1.500e+4 | 1.000e+15 | 2.000e+3 | — |
| `age3` | Middle Ages | 1.500e+6 | 1.000e+21 | 2.000e+4 | — |
| `age4` | Renaissance | 1.500e+8 | 1.000e+27 | 2.000e+5 | — |
| `age5` | Industrial | 1.500e+9 | 1.000e+33 | 2.000e+6 | — |
| `age6` | Modern / Space | 1.500e+10 | 1.000e+39 | 2.000e+7 | — |

## Upgrades

65 upgrades.

| key | name | building | tier | threshold | costs | bonuses |
| --- | --- | --- | --- | --- | --- | --- |
| `farmEnhancer9` | Enhanced Farm I | farm | 0 | 9 | food 2.086e+3×1 + wood 557×1 | attributeFlat → farmPower (1); attributeMultiplier → farmCapacity (10); attributeMultiplier → food (2) |
| `farmEnhancer98` | Enhanced Farm II | farm | 1 | 98 | food 5.000e+10×1 + wood 1.000e+9×1 | attributeFlat → farmPower (1); attributeMultiplier → farmCapacity (10); attributeMultiplier → food (2) |
| `farmEnhancer980` | Enhanced Farm III | farm | 2 | 980 | food 2.041e+43×1 + wood 5.443e+42×1 + metalwork 1.000e+3×1 | attributeFlat → farmPower (1); attributeMultiplier → farmCapacity (10); attributeMultiplier → food (2); costReductionPercent → farm (0.5) |
| `farmEnhancer9800` | Enhanced Farm IV | farm | 3 | 9800 | food 4.93981576360875e401×1 + wood 6.58642101814543e400×1 + metalwork 1.000e+3×1 | attributeFlat → farmPower (1); attributeMultiplier → farmCapacity (10); attributeMultiplier → food (2); costReductionPercent → farm (0.5) |
| `farmEnhancer98000` | Enhanced Farm V | farm | 4 | 98000 | food 6.49942720156444e3979×1 + wood 8.66590293541983e3978×1 + metalwork 1.000e+3×1 | attributeFlat → farmPower (1); attributeMultiplier → farmCapacity (10); attributeMultiplier → food (2); costReductionPercent → farm (0.5) |
| `farmEnhancer980000` | Enhanced Farm VI | farm | 5 | 980000 | food 1.97355140436919e39758×1 + wood 2.63140187246763e39757×1 + metalwork 1.000e+3×1 | attributeFlat → farmPower (1); attributeMultiplier → farmCapacity (10); attributeMultiplier → food (2); costReductionFactor → farm (0.99) |
| `farmEnhancer9800000` | Enhanced Farm VII | farm | 6 | 9800000 | food 2.56869223394204e397540×1 + wood 3.42492297861471e397539×1 + metalwork 1.000e+3×1 | attributeFlat → farmPower (1); attributeMultiplier → farmCapacity (10); attributeMultiplier → food (2); costReductionFactor → farm (0.99) |
| `farmEnhancer98000000` | Enhanced Farm VIII | farm | 7 | 98000000 | food 6.99968361806327e3975358×1 + wood 9.33291149207092e3975357×1 + metalwork 1.000e+3×1 | attributeFlat → farmPower (1); attributeMultiplier → farmCapacity (10); attributeMultiplier → food (2); costReductionFactor → farm (0.99) |
| `lumberYardEnhancer9` | Enhanced Lumber Yard I | lumberYard | 0 | 9 | wood 557×1 + stone 557×1 | attributeFlat → lumberYardPower (1); attributeMultiplier → lumberYardCapacity (10); attributeMultiplier → wood (2) |
| `lumberYardEnhancer98` | Enhanced Lumber Yard II | lumberYard | 1 | 98 | wood 1.000e+9×1 + stone 1.000e+9×1 | attributeFlat → lumberYardPower (1); attributeMultiplier → lumberYardCapacity (10); attributeMultiplier → wood (2) |
| `lumberYardEnhancer980` | Enhanced Lumber Yard III | lumberYard | 2 | 980 | wood 5.443e+42×1 + stone 5.443e+42×1 + metalwork 1.000e+3×1 | attributeFlat → lumberYardPower (1); attributeMultiplier → lumberYardCapacity (10); attributeMultiplier → wood (2); costReductionPercent → lumberYard (0.5) |
| `lumberYardEnhancer9800` | Enhanced Lumber Yard IV | lumberYard | 3 | 9800 | wood 6.58642101814543e400×1 + stone 6.58642101814543e400×1 + metalwork 1.000e+3×1 | attributeFlat → lumberYardPower (1); attributeMultiplier → lumberYardCapacity (10); attributeMultiplier → wood (2); costReductionPercent → lumberYard (0.5) |
| `lumberYardEnhancer98000` | Enhanced Lumber Yard V | lumberYard | 4 | 98000 | wood 8.66590293541983e3978×1 + stone 8.66590293541983e3978×1 + metalwork 1.000e+3×1 | attributeFlat → lumberYardPower (1); attributeMultiplier → lumberYardCapacity (10); attributeMultiplier → wood (2); costReductionPercent → lumberYard (0.5) |
| `lumberYardEnhancer980000` | Enhanced Lumber Yard VI | lumberYard | 5 | 980000 | wood 2.63140187246763e39757×1 + stone 2.63140187246763e39757×1 + metalwork 1.000e+3×1 | attributeFlat → lumberYardPower (1); attributeMultiplier → lumberYardCapacity (10); attributeMultiplier → wood (2); costReductionFactor → lumberYard (0.99) |
| `lumberYardEnhancer9800000` | Enhanced Lumber Yard VII | lumberYard | 6 | 9800000 | wood 3.42492297861471e397539×1 + stone 3.42492297861471e397539×1 + metalwork 1.000e+3×1 | attributeFlat → lumberYardPower (1); attributeMultiplier → lumberYardCapacity (10); attributeMultiplier → wood (2); costReductionFactor → lumberYard (0.99) |
| `lumberYardEnhancer98000000` | Enhanced Lumber Yard VIII | lumberYard | 7 | 98000000 | wood 9.33291149207092e3975357×1 + stone 9.33291149207092e3975357×1 + metalwork 1.000e+3×1 | attributeFlat → lumberYardPower (1); attributeMultiplier → lumberYardCapacity (10); attributeMultiplier → wood (2); costReductionFactor → lumberYard (0.99) |
| `quarryEnhancer9` | Enhanced Quarry I | quarry | 0 | 9 | stone 557×1 | attributeFlat → quarryPower (1); attributeMultiplier → quarryCapacity (10); attributeMultiplier → stone (2) |
| `quarryEnhancer98` | Enhanced Quarry II | quarry | 1 | 98 | stone 1.000e+9×1 | attributeFlat → quarryPower (1); attributeMultiplier → quarryCapacity (10); attributeMultiplier → stone (2) |
| `quarryEnhancer980` | Enhanced Quarry III | quarry | 2 | 980 | stone 5.443e+42×1 + metalwork 1.000e+3×1 | attributeFlat → quarryPower (1); attributeMultiplier → quarryCapacity (10); attributeMultiplier → stone (2); costReductionPercent → quarry (0.5) |
| `quarryEnhancer9800` | Enhanced Quarry IV | quarry | 3 | 9800 | stone 6.58642101814543e400×1 + metalwork 1.000e+3×1 | attributeFlat → quarryPower (1); attributeMultiplier → quarryCapacity (10); attributeMultiplier → stone (2); costReductionPercent → quarry (0.5) |
| `quarryEnhancer98000` | Enhanced Quarry V | quarry | 4 | 98000 | stone 8.66590293541983e3978×1 + metalwork 1.000e+3×1 | attributeFlat → quarryPower (1); attributeMultiplier → quarryCapacity (10); attributeMultiplier → stone (2); costReductionPercent → quarry (0.5) |
| `quarryEnhancer980000` | Enhanced Quarry VI | quarry | 5 | 980000 | stone 2.63140187246763e39757×1 + metalwork 1.000e+3×1 | attributeFlat → quarryPower (1); attributeMultiplier → quarryCapacity (10); attributeMultiplier → stone (2); costReductionFactor → quarry (0.99) |
| `quarryEnhancer9800000` | Enhanced Quarry VII | quarry | 6 | 9800000 | stone 3.42492297861471e397539×1 + metalwork 1.000e+3×1 | attributeFlat → quarryPower (1); attributeMultiplier → quarryCapacity (10); attributeMultiplier → stone (2); costReductionFactor → quarry (0.99) |
| `quarryEnhancer98000000` | Enhanced Quarry VIII | quarry | 7 | 98000000 | stone 9.33291149207092e3975357×1 + metalwork 1.000e+3×1 | attributeFlat → quarryPower (1); attributeMultiplier → quarryCapacity (10); attributeMultiplier → stone (2); costReductionFactor → quarry (0.99) |
| `goldMineEnhancer9` | Enhanced Gold Mine I | goldMine | 0 | 9 | wood 557×1 + stone 557×1 | attributeFlat → goldMinePower (1); attributeMultiplier → goldMineCapacity (10); attributeMultiplier → gold (2) |
| `goldMineEnhancer98` | Enhanced Gold Mine II | goldMine | 1 | 98 | wood 1.000e+9×1 + stone 1.000e+9×1 | attributeFlat → goldMinePower (1); attributeMultiplier → goldMineCapacity (10); attributeMultiplier → gold (2) |
| `goldMineEnhancer980` | Enhanced Gold Mine III | goldMine | 2 | 980 | wood 5.443e+42×1 + stone 5.443e+42×1 + metalwork 1.000e+3×1 | attributeFlat → goldMinePower (1); attributeMultiplier → goldMineCapacity (10); attributeMultiplier → gold (2); costReductionPercent → goldMine (0.5) |
| `goldMineEnhancer9800` | Enhanced Gold Mine IV | goldMine | 3 | 9800 | wood 6.58642101814543e400×1 + stone 6.58642101814543e400×1 + metalwork 1.000e+3×1 | attributeFlat → goldMinePower (1); attributeMultiplier → goldMineCapacity (10); attributeMultiplier → gold (2); costReductionPercent → goldMine (0.5) |
| `goldMineEnhancer98000` | Enhanced Gold Mine V | goldMine | 4 | 98000 | wood 8.66590293541983e3978×1 + stone 8.66590293541983e3978×1 + metalwork 1.000e+3×1 | attributeFlat → goldMinePower (1); attributeMultiplier → goldMineCapacity (10); attributeMultiplier → gold (2); costReductionPercent → goldMine (0.5) |
| `goldMineEnhancer980000` | Enhanced Gold Mine VI | goldMine | 5 | 980000 | wood 2.63140187246763e39757×1 + stone 2.63140187246763e39757×1 + metalwork 1.000e+3×1 | attributeFlat → goldMinePower (1); attributeMultiplier → goldMineCapacity (10); attributeMultiplier → gold (2); costReductionFactor → goldMine (0.99) |
| `goldMineEnhancer9800000` | Enhanced Gold Mine VII | goldMine | 6 | 9800000 | wood 3.42492297861471e397539×1 + stone 3.42492297861471e397539×1 + metalwork 1.000e+3×1 | attributeFlat → goldMinePower (1); attributeMultiplier → goldMineCapacity (10); attributeMultiplier → gold (2); costReductionFactor → goldMine (0.99) |
| `goldMineEnhancer98000000` | Enhanced Gold Mine VIII | goldMine | 7 | 98000000 | wood 9.33291149207092e3975357×1 + stone 9.33291149207092e3975357×1 + metalwork 1.000e+3×1 | attributeFlat → goldMinePower (1); attributeMultiplier → goldMineCapacity (10); attributeMultiplier → gold (2); costReductionFactor → goldMine (0.99) |
| `barracksEnhancer9` | Enhanced Barracks I | barracks | 0 | 9 | wood 3.000e+5×1 + stone 5.000e+5×1 + food 1.000e+6×1 | attributeFlat → barracksPower (1); attributeMultiplier → military (2) |
| `barracksEnhancer98` | Enhanced Barracks II | barracks | 1 | 98 | wood 4.000e+14×1 + stone 1.000e+14×1 + food 4.535e+15×1 | attributeFlat → barracksPower (1); attributeMultiplier → military (2) |
| `barracksEnhancer980` | Enhanced Barracks III | barracks | 2 | 980 | wood 5.443e+42×1 + stone 5.443e+42×1 + food 5.443e+42×1 + metalwork 1.000e+3×1 | attributeFlat → barracksPower (1); attributeMultiplier → military (2); costReductionPercent → barracks (0.5) |
| `barracksEnhancer9800` | Enhanced Barracks IV | barracks | 3 | 9800 | wood 6.58642101814543e400×1 + stone 6.58642101814543e400×1 + food 6.58642101814543e400×1 + metalwork 1.000e+3×1 | attributeFlat → barracksPower (1); attributeMultiplier → military (2); costReductionPercent → barracks (0.5) |
| `barracksEnhancer98000` | Enhanced Barracks V | barracks | 4 | 98000 | wood 8.66590293541983e3978×1 + stone 8.66590293541983e3978×1 + food 8.66590293541983e3978×1 + metalwork 1.000e+3×1 | attributeFlat → barracksPower (1); attributeMultiplier → military (2); costReductionPercent → barracks (0.5) |
| `barracksEnhancer980000` | Enhanced Barracks VI | barracks | 5 | 980000 | wood 2.63140187246763e39757×1 + stone 2.63140187246763e39757×1 + food 2.63140187246763e39757×1 + metalwork 1.000e+3×1 | attributeFlat → barracksPower (1); attributeMultiplier → military (2); costReductionFactor → barracks (0.99) |
| `barracksEnhancer9800000` | Enhanced Barracks VII | barracks | 6 | 9800000 | wood 3.42492297861471e397539×1 + stone 3.42492297861471e397539×1 + food 3.42492297861471e397539×1 + metalwork 1.000e+3×1 | attributeFlat → barracksPower (1); attributeMultiplier → military (2); costReductionFactor → barracks (0.99) |
| `barracksEnhancer98000000` | Enhanced Barracks VIII | barracks | 7 | 98000000 | wood 9.33291149207092e3975357×1 + stone 9.33291149207092e3975357×1 + food 9.33291149207092e3975357×1 + metalwork 1.000e+3×1 | attributeFlat → barracksPower (1); attributeMultiplier → military (2); costReductionFactor → barracks (0.99) |
| `universityEnhancer9` | Enhanced University I | university | 0 | 9 | wood 6.000e+5×1 + stone 1.000e+6×1 + gold 4.000e+5×1 | attributeFlat → universityPower (1); attributeMultiplier → science (2) |
| `universityEnhancer98` | Enhanced University II | university | 1 | 98 | wood 1.000e+15×1 + stone 4.000e+14×1 + gold 1.000e+14×1 | attributeFlat → universityPower (1); attributeMultiplier → science (2) |
| `universityEnhancer980` | Enhanced University III | university | 2 | 980 | wood 5.443e+42×1 + stone 5.443e+42×1 + gold 5.443e+42×1 + metalwork 1.000e+3×1 | attributeFlat → universityPower (1); attributeMultiplier → science (2); costReductionPercent → university (0.5) |
| `universityEnhancer9800` | Enhanced University IV | university | 3 | 9800 | wood 6.58642101814543e400×1 + stone 6.58642101814543e400×1 + gold 6.58642101814543e400×1 + metalwork 1.000e+3×1 | attributeFlat → universityPower (1); attributeMultiplier → science (2); costReductionPercent → university (0.5) |
| `universityEnhancer98000` | Enhanced University V | university | 4 | 98000 | wood 8.66590293541983e3978×1 + stone 8.66590293541983e3978×1 + gold 8.66590293541983e3978×1 + metalwork 1.000e+3×1 | attributeFlat → universityPower (1); attributeMultiplier → science (2); costReductionPercent → university (0.5) |
| `universityEnhancer980000` | Enhanced University VI | university | 5 | 980000 | wood 2.63140187246763e39757×1 + stone 2.63140187246763e39757×1 + gold 2.63140187246763e39757×1 + metalwork 1.000e+3×1 | attributeFlat → universityPower (1); attributeMultiplier → science (2); costReductionFactor → university (0.99) |
| `universityEnhancer9800000` | Enhanced University VII | university | 6 | 9800000 | wood 3.42492297861471e397539×1 + stone 3.42492297861471e397539×1 + gold 3.42492297861471e397539×1 + metalwork 1.000e+3×1 | attributeFlat → universityPower (1); attributeMultiplier → science (2); costReductionFactor → university (0.99) |
| `universityEnhancer98000000` | Enhanced University VIII | university | 7 | 98000000 | wood 9.33291149207092e3975357×1 + stone 9.33291149207092e3975357×1 + gold 9.33291149207092e3975357×1 + metalwork 1.000e+3×1 | attributeFlat → universityPower (1); attributeMultiplier → science (2); costReductionFactor → university (0.99) |
| `smithyEnhancer9` | Enhanced Smithy I | smithy | 0 | 9 | wood 557×1 + stone 557×1 | attributeFlat → smithyPower (1); attributeMultiplier → metalwork (2) |
| `smithyEnhancer98` | Enhanced Smithy II | smithy | 1 | 98 | wood 2.535e+16×1 + stone 2.535e+16×1 | attributeFlat → smithyPower (1); attributeMultiplier → metalwork (2) |
| `smithyEnhancer980` | Enhanced Smithy III | smithy | 2 | 980 | wood 5.443e+42×1 + stone 5.443e+42×1 + metalwork 1.000e+3×1 | attributeFlat → smithyPower (1); attributeMultiplier → metalwork (2); costReductionPercent → smithy (0.5) |
| `smithyEnhancer9800` | Enhanced Smithy IV | smithy | 3 | 9800 | wood 6.58642101814543e400×1 + stone 6.58642101814543e400×1 + metalwork 1.000e+3×1 | attributeFlat → smithyPower (1); attributeMultiplier → metalwork (2); costReductionPercent → smithy (0.5) |
| `smithyEnhancer98000` | Enhanced Smithy V | smithy | 4 | 98000 | wood 8.66590293541983e3978×1 + stone 8.66590293541983e3978×1 + metalwork 1.000e+3×1 | attributeFlat → smithyPower (1); attributeMultiplier → metalwork (2); costReductionPercent → smithy (0.5) |
| `smithyEnhancer980000` | Enhanced Smithy VI | smithy | 5 | 980000 | wood 2.63140187246763e39757×1 + stone 2.63140187246763e39757×1 + metalwork 1.000e+3×1 | attributeFlat → smithyPower (1); attributeMultiplier → metalwork (2); costReductionFactor → smithy (0.99) |
| `smithyEnhancer9800000` | Enhanced Smithy VII | smithy | 6 | 9800000 | wood 3.42492297861471e397539×1 + stone 3.42492297861471e397539×1 + metalwork 1.000e+3×1 | attributeFlat → smithyPower (1); attributeMultiplier → metalwork (2); costReductionFactor → smithy (0.99) |
| `smithyEnhancer98000000` | Enhanced Smithy VIII | smithy | 7 | 98000000 | wood 9.33291149207092e3975357×1 + stone 9.33291149207092e3975357×1 + metalwork 1.000e+3×1 | attributeFlat → smithyPower (1); attributeMultiplier → metalwork (2); costReductionFactor → smithy (0.99) |
| `marketEnhancer9` | Enhanced Market I | market | 0 | 9 | wood 557×1 + stone 557×1 | attributeFlat → marketPower (1); attributeMultiplier → trade (2) |
| `marketEnhancer98` | Enhanced Market II | market | 1 | 98 | wood 4.535e+16×1 + stone 4.535e+16×1 | attributeFlat → marketPower (1); attributeMultiplier → trade (2) |
| `marketEnhancer980` | Enhanced Market III | market | 2 | 980 | wood 5.443e+42×1 + stone 5.443e+42×1 + metalwork 1.000e+3×1 | attributeFlat → marketPower (1); attributeMultiplier → trade (2); costReductionPercent → market (0.5) |
| `marketEnhancer9800` | Enhanced Market IV | market | 3 | 9800 | wood 6.58642101814543e400×1 + stone 6.58642101814543e400×1 + metalwork 1.000e+3×1 | attributeFlat → marketPower (1); attributeMultiplier → trade (2); costReductionPercent → market (0.5) |
| `marketEnhancer98000` | Enhanced Market V | market | 4 | 98000 | wood 8.66590293541983e3978×1 + stone 8.66590293541983e3978×1 + metalwork 1.000e+3×1 | attributeFlat → marketPower (1); attributeMultiplier → trade (2); costReductionPercent → market (0.5) |
| `marketEnhancer980000` | Enhanced Market VI | market | 5 | 980000 | wood 2.63140187246763e39757×1 + stone 2.63140187246763e39757×1 + metalwork 1.000e+3×1 | attributeFlat → marketPower (1); attributeMultiplier → trade (2); costReductionFactor → market (0.99) |
| `marketEnhancer9800000` | Enhanced Market VII | market | 6 | 9800000 | wood 3.42492297861471e397539×1 + stone 3.42492297861471e397539×1 + metalwork 1.000e+3×1 | attributeFlat → marketPower (1); attributeMultiplier → trade (2); costReductionFactor → market (0.99) |
| `marketEnhancer98000000` | Enhanced Market VIII | market | 7 | 98000000 | wood 9.33291149207092e3975357×1 + stone 9.33291149207092e3975357×1 + metalwork 1.000e+3×1 | attributeFlat → marketPower (1); attributeMultiplier → trade (2); costReductionFactor → market (0.99) |
| `wonder0` | Great Monument | people | 0 | 5000 | gold 1.000e+18×1 + wood 5.000e+17×1 + stone 5.000e+18×1 | costReductionFactor → allBuildings (0.9); costReductionFactor → allUnits (0.8); costReductionFactor → people (0.95) |

---

Payloads in `src/game/data`: `achievements.json`, `ages.json`, `buildings.json`, `encounters.json`, `research.json`, `researchLayout.json`, `stats.json`, `units.json`, `upgrades.json`. Offline-gain contract vectors are in `tools/simulation/tests/offlineGainVectors.json`. Anything absent above is absent from the dump, not missing from the game.