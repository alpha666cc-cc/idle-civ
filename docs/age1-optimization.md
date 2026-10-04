# Reaching the Iron Age (age1): the optimization problem

> Companion to `tools/age1-policy.ts` (the search space) and
> `tools/age1-optimize.ts` (the search). The tool finds a good policy; this
> document states the problem the search is solving, why it is shaped the way it
> is, and where the current answer sits relative to what is provable.

## 1. The problem

Reaching the Iron Age is a **deterministic hybrid optimal-control problem** — a
shortest-path problem over a combinatorial state space whose only randomness is
absent by construction (battles are a deterministic stack simulation, so the same
army always gives the same result).

$$\min_{a}\ T \qquad \text{s.t.}\qquad \text{currentAge}(T) = \texttt{age1}$$

where the decision sequence `a` is a policy over the `SimulationAction`
vocabulary, and the terminal predicate is **engine-exact**. From
`CivilizationState.canEnterAge("age0")` plus one `enterAge` action:

1. all four age-0 encounters won — `age0_1_first_fire`, `age0_2_wolf_pack`,
   `age0_3_bronze_raid`, `age0_boss_troy`;
2. total buildings ≥ `age1.buildingThreshold` = **1500**;
3. the `enterAge("age0")` action has actually fired — reaching an age is an
   _action_ that consumes an action slot, not a passive state.

Note (2): the target is a **building count**, not a population. `people` is by
far the cheapest per-building (10 food, factor 2.5), and population is derived
from the number of `people` buildings, so ~1000 citizens is roughly 1000 of the
1500 and the rest is housing plus production capacity.

## 2. State and dynamics

$$x(t) = \big(r(t),\; w(t),\; n(t),\; \kappa(t),\; Q(t),\; E(t),\; A(t),\; W(t),\; m(t),\; \iota(t)\big)$$

- $r(t)$ — resource balances; $w(t)$ — worker split over the four gatherable
  resources; $n(t)$ — building counts, with **population $P(t) = n_{\text{people}}(t)$**;
  $\kappa(t)$ — capacities; $Q$ / $E$ / $A$ / $W$ — bought research, upgrades,
  earned achievements, defeated encounters; $m$ — unit counts; $\iota$ — entered ages.

**Rate law** — `computeResourceRate`, evaluated once per tick:

$$\dot r_j(x) = \Big(\textstyle\sum_j \text{additional}_j\Big)\times\Big(\prod \mu\Big)\times\Big(1 + \sum \text{addMult}\Big) - \Big(\sum \text{drain}\Big)$$

with every multiplier $\mu$ decomposing multiplicatively into layers that switch
on at events — research × achievement × encounter × upgrade × age. Wolf Slayer is
`food x4 · wood x2`; Wolf Pack is `wood x4 · science x2`; domestication is
`food x10`; writing is `science x10`.

**Ordering within a second** — actions first, then the tick:

$$r(t^+) = \Pi_{\text{actions at } t}\big(r(t)\big), \qquad r(t+1) = \max\big(0,\; r(t^+) + \dot r(x(t))\big) + g(t)$$

$g(t)$ is click income. Two facts here are easy to miss and both dominated the
first implementation of the search policy:

- **A `gather` consumes the entire simulated second** (`simulation.ts` sets
  `remainingActions = 0` after it). Ten clicks at `clickPower × multipliers` is
  all one second buys. A single gather placed above a purchase ladder therefore
  starves it — the first version of the policy spent 19 995 of 20 000 actions
  gathering for science and never reached the Iron Age.
- **Achievements are evaluated at the end of `tick()`**, so their bonuses switch
  on with up to one second of lag. At these horizons it is noise, but it is part
  of the exact model.

## 3. Decision variables

At each second and each of the ≤5 action slots: `gather(r)`, `assign/unassignWorker(r,k)`,
`build(b,k)`, `buyResearch(i)`, `buyUpgrade(u)`, `buyUnit(m,k)`, `launchBattle(k)`,
`enterAge`, `setTradeRoute`, `wait`.

Equivalently — and this is the form the event-driven solve would take — a schedule
of event times $0 \le \tau_1 \le \tau_2 \le \dots$ with event types and quantities
between them. Rates are **constant between events**, so resource accumulation on
each segment integrates in closed form. That is what makes a direct-transcription
NLP tractable in principle.

## 4. Constraints

| #   | Constraint                                                                                                                                                    | Engine path that enforces it              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| C1  | Affordability; balances never negative (clamped)                                                                                                              | `build`, `buyUnit`, `buyResearch`, `tick` |
| C2  | `T(n) = base·(F^{√n} − 1)` cumulative curve, §13.1 reductions `base → factor → percent → flat` per unit, clamped at 0                                         | `costSeries`, `costParameters`            |
| C3  | Research priced by the **current age**: `200 · 12^{√i − 1}` science, $i$ = age-0 techs bought. `allBuildings` discounts never reach research                  | `getResearchCostForCount`                 |
| C4  | Workers integer, $\sum w_r \le P(t)$, reassignment free but costs an action slot                                                                              | `assignWorker`                            |
| C5  | Capacities: `people ≤ peopleCapacity`, houses ≤ `houseCapacity`, production buildings ≤ 10 until an enhancer multiplies ×10 (threshold 9)                     | `getBuildingMax`                          |
| C6  | `barracks` ⇐ 90 people; `university` ⇐ First Fire won; `smithy` ⇐ 5 town halls; `market` ⇐ age1 (vacuous here)                                                | `isBuildingAvailable`                     |
| C7  | Research DAG + age gate, e.g. `agriculture → tribal_organization/mining → bronze_smelting → bronze_casting → {wheel_axle, composite_bowcraft, galley_design}` | `isResearchUnlocked`                      |
| C8  | Units ⇐ unlock research (only `warrior` is base-available)                                                                                                    | `isUnitAvailable`                         |
| C9  | Upgrades ⇐ building count ≥ threshold, plus their costs                                                                                                       | `isUpgradeUnlocked`                       |
| C10 | Achievements ⇐ requirement, re-checked each tick                                                                                                              | `checkAchievements`                       |
| C11 | A battle is won by `launchBattle` iff `simulateEncounter` returns `outcome: "player"`                                                                         | `launchBattle`                            |
| C12 | Army recipes come from `solveMinimumArmy`; armies are never lost, so an army is a **one-time investment that persists**                                       | `battleSimulator`                         |
| C13 | `getNextBattle` offers only the first unwon age-0 encounter — the campaign is sequential by construction                                                      | `getNextBattle`                           |
| C14 | Terminal: all four battles ∧ ≥1500 buildings ∧ `enterAge` fired                                                                                               | `canEnterAge`, `enterAge`                 |

## 5. Why it is not a plain MILP

The cost curves are `F^{√n}`, the research curve is `12^{√i}`, bonuses stack
multiplicatively, capacities are integer slots, and the battle predicate is a
black box (deterministic, but not a closed form). Piecewise-linear surrogates are
possible and would take the interesting structure out. What _does_ work is the
decomposition in §6.

## 6. The decomposition that works

**RCPSP with nonlinear resource accumulation.** The project DAG is:

```text
barracks gate (90 pop) → First Fire → university → science tech chain
   → smithy (5 town halls) → Bronze Raid → full bronze tree → Fall of Troy
```

with the housing/population ramp and the 1500-building count as parallel
resource-consuming tasks. Battles become _milestones with precedence_ rather than
decisions, once `solveMinimumArmy` has precomputed each recipe. Variables are then
event times and purchase quantities, and constraints are resource balances
integrated in closed form between events — a direct-transcription NLP.

**Admissible lower bound.** A continuous relaxation — all multipliers hypothetically
live from $t = 0$, perfect worker allocation, zero action waste — gives $T_{LB}$,
against which any found $T$ can be compared for headroom.

**Practical search.** What ships in `tools/age1-optimize.ts` is the third option:
parameterize the policy and let a **cross-entropy method** search it. The
objective is a step function of simulation time, so there is no gradient; CEM is
derivative-free, handles the mixed encoding (17 continuous parameters + a build
order permutation + a boolean), and — because every evaluation is a real
`GameSimulation` run — produces **engine-exact feasible** solutions rather than a
surrogate's approximation of them.

## 7. Structural levers the math exposes

1. **Food is the growth bottleneck.** Every citizen drains 1 food/second, so the
   timing of the food multipliers (agriculture ×2, Wolf Slayer ×4, domestication
   ×10) dominates the population ramp. Clicking alone provably deadlocks past a
   few dozen citizens; only passive production scales.
2. **Battle bonuses are multiplicative economy jumps.** Winning early compounds
   through the whole tech phase — Wolf Pack alone is `wood x4 · science x2`.
3. **The science curve makes tech _order_ nearly as important as tech _count_.**
   Buying an off-plan tech advances $i$ and makes every later tech dearer, so the
   battle plan's research must be bought before any weighted preference applies.
   This is why `AgeOnePolicy.researchAction` consults the battle plan first and
   only falls back to its weighted preference afterwards.
4. **The 1500-building target is co-reached with the final battle**, not
   independently: the boss kill is what unlocks the last capacity, and the count
   arrives within seconds of it. Minimizing $T$ is therefore mostly minimizing the
   Troy recipe's time.
5. **Capacity enhancers are step functions in throughput** (×10 at threshold 9).
   Their buy time has a discontinuous payoff, so the optimum sits close to a
   breakpoint rather than in the smooth interior.
6. **Action slots are a scarce resource.** Five per second, and a gather burns
   all five. Every gather placed above a purchase is a direct tax on growth — the
   single biggest lesson from building the first version of this search.

## 8. Current bounds

> **Provenance.** Re-measured on the engine *after* the `isResourceGatherable`
> fix landed (assigning workers to `science` / `military` / `metalwork` / `trade`
> now requires their source building). That fix is a genuine economy change —
> before it, science workers produced science from turn zero with no university —
> and it moved the numbers below by 5–10 %. Anything measured earlier on the
> pre-fix engine is marked as such. Objective `{ type: "ageReach", ageId: "age1" }`,
> `gatherClicksPerAction: 10`, `actionsPerSecond: 5`, from scratch. The sim is
> seedless and deterministic, but **re-run before trusting absolute digits** — the
> tree is under active edit.

| Policy                                   | Age-1 arrival |
| ---------------------------------------- | ------------- |
| **`player` (hand-authored)**             | **2147 s**    |
| `economy`                                | 3371 s        |
| `fast-age`                               | 4074 s        |
| `production`                             | 4107 s        |
| `military`                               | 4177 s        |
| `balanced`                               | 4233 s        |
| `trader`                                 | 4776 s        |
| `cheapest`                               | 5544 s        |
| `speedrun`                               | 8243 s        |
| `research`                               | never arrives |
| best CEM policy (pre-fix engine only)    | 4134 s        |

**The hand-authored `player` is ~1.6× faster than the best machine-found policy.**
`AgeOnePolicy` assigns workers only to the four gatherable resources; `player`
sends half its workers to science and 17.4 % to metalwork
(`getResearchWorkerRatios`). That axis was absent from the search space — a hole
in the policy family, not a tuning miss.

### 8.0 What the worker-gating fix invalidated

The same measurement run on both engines:

| science worker share | pre-fix | post-fix (current) |
| ------------------- | ------- | ------------------ |
| 0                   | 2988 s  | 2988 s             |
| 0.25                | 2178 s  | 2352 s             |
| **0.5**             | **1895 s** | **2169 s**      |
| 0.7                 | 2074 s  | 2308 s             |

The lever is real and still peaks at 0.5, but a third of the apparent effect
(−36.6 % → −27.4 %) was the bug — workers earning science with no university.
`player` already sits at the optimum, so this axis has nothing left to give.

The fix also made `PlayerStrategy`'s **research pause inert**. The pause withheld
research until First Fire was won; gating science workers behind the university
(which unlocks on First Fire) now enforces the same ordering in the engine. A
subclass with the pause removed arrives at **2147 s — bit-identical to
`player`** — so it was deleted rather than shipped as a duplicate.

### 8.1 Feasibility is free; speed is not

> Measured on the **pre-fix** engine. The feasibility frontier depends on unit
> unlocks and the battle sim, neither of which the worker-gating fix touches, so
> it should still hold — but it has not been re-run. Treat as indicative.

The minimum research count that can *win* each battle, with a probe that has
unlimited resources and free recruits (so cost is ignored entirely):

| Battle                  | min techs to win |
| ----------------------- | ---------------- |
| `age0_1_first_fire`     | 0                |
| `age0_2_wolf_pack`      | **0**            |
| `age0_3_bronze_raid`    | **0**            |
| `age0_boss_troy`        | 3 (`agriculture`, `pottery`, `sling_throwing`) |

This is the single most useful result for the research decision, and it kills the
obvious formulation. Three of four battles are winnable with **no research at
all** — pure warriors — so "can this set win?" screens almost every candidate to
"yes" and discriminates nothing. `researchIdsForBattle` reporting "0 techs" for
Wolf Pack is therefore *not* evidence that research is unnecessary before it; it
only says the army can be paid for out of production. The costed question — how
much research is optimal *before* each battle — is a different one, and it is the
one worth asking.

Note also that `researchIdsForBattle` demands all 23 techs for Troy purely
because of its `isBoss` rule (`research.age < battleAge || (isBoss && age === battleAge)`).
That is a conservative advisor heuristic, **not** a proven requirement; the real
floor is 3.

### 8.2 The research *count* is nearly the wrong axis

> Measured on the **pre-fix** engine and not re-run since. The conclusion is
> about research, which the worker fix does not touch, but treat the thresholds
> as indicative rather than current.

Capping the research budget at N (intercepting every `buyResearch` out of
`decideAction`, which is the only interception point that binds — overriding
`getResearchAction` still leaves the simulator advisor free to buy) and running
the `player` ladder under the cap:

| Budget N                | result                          |
| ----------------------- | ------------------------------- |
| 0 – 17                  | never reaches age1, stalls at 2 battles |
| 18 – 20                 | 3 battles                       |
| 21 – 22                 | all 4 battles, still no age1 (never assembles 1500 buildings) |
| 23                      | 2147 s — the only budget that works |

Only N = 23 arrives. So the count is *not* a tunable budget: below the full set
the ladder stalls outright, and at 21–22 it wins every battle yet still cannot
reach the building target. **Which** techs are bought — the membership and the
sequence — is what decides, not how many.

That reframes the search. The subset space is large (~1.9 M+ prerequisite-closed
sets of the 23-node age-0 DAG), and simulating all of them is hopeless (~5 s
each). But since price depends only on the purchase ordinal, any 23-element ideal
costs the same 10 131 950 science, so the free variable is **the topological
order** — a much better-conditioned space, reachable by local search over
"swap two adjacent techs" / "move one tech earlier", one simulation per neighbour.

### 8.3 The cost curve is a red herring — cost reduction is 280×

> Measured on the **pre-fix** engine. The 280× figure is a ratio between the
> unreduced curve and what a run actually paid, and the reduction stack
> (four `allBuildings` 50 % cuts compounding to 1/16, plus `hallOfHalls` and the
> enhancer tiers) has not changed — but the run that produced it has not been
> re-measured.

An attempted lower bound (total citizen bill ÷ peak food rate) **failed, and the
way it failed is the useful result.** It returned a "floor" *larger* than the time
actually achieved, which is the signature of an invalid bound. Two independent
reasons:

1. **The bill is not the curve.** The unreduced `people` curve for 1000 citizens
   is `10·(2.5^√1000 − 1)` = **3.84 × 10¹³ food**. What the `player` run
   *actually paid* for those same 1000 citizens was **1.37 × 10¹¹ food** — a
   **280× reduction**. `stone_working`, `forestry`, `city_planning` and `writing`
   each cut `allBuildings` by 50 % (compounding to 1/16), and `hallOfHalls` plus
   the enhancer tiers cut further.
2. **Peak rate is not an upper bound over time.** Peak food output is reached only
   at the *end* of the run (pop 1000, a 16.8 M× food multiplier). Dividing a total
   bill by a rate you only have at the end is not a floor.

Together these kill any raw-production lower bound and expose the real structure
of the problem:

> **The optimisation is not "produce faster", it is "buy research that makes
> production cheaper and stronger".** Cost reduction is the dominant lever, and it
> is itself bought with science, which needs universities, which need First Fire.
> That circularity — reduction costs science, science costs the army, the army
> costs reductions — is the actual problem, and it is why a closed-form bound is
> not available.

The corollary matters for the "within 25 % of optimal" goal: **regret against the
best-known policy is the only metric that is currently computable**, because there
is no valid lower bound to measure regret against. Best-known is itself a moving
target as the search improves.

### 8.4 Research is not varied by the strategies — the benchmark is blind on that axis

A Jaccard comparison of the research set every shipped strategy actually buys,
at the same objective and horizon:

| group | strategies | techs | research set |
| ----- | ---------- | ----- | ------------ |
| A | `balanced`, `production`, `military`, `trader` | 21 | **byte-identical order** |
| B | `fast-age`, `economy` | 21 | identical to each other; differs from A only by a `domestication`/`weaving` swap |
| C | `cheapest` | 22 | 0.95 Jaccard with A/B |
| D | `speedrun` | 23 | different order entirely |
| E | `player` | 23 | different order entirely |
| F | `research` | 10 | different, and never finishes |

Group A spans **4107 s – 4776 s (16 %)** and group B spans **3371 s – 4074 s
(21 %)** — with *identical research decisions*. Everything that separates them is
worker split and building order. (Those arrival times are post-fix; the research
sets themselves are order-of-purchase data that the worker fix does not touch.)

Two consequences:

1. **`economy` (3371 s) and `fast-age` (4074 s) buy the same techs in the same
   order and differ by 703 s.** So worker allocation alone is worth ~21 % with
   research held fixed — a bigger lever than anything my search found, because my
   policy family only ever split workers across the four *gatherable* resources.
2. **The AGENTS.md §7.2 benchmark cannot detect a research-ordering regression.**
   Four of ten strategies share one hardcoded order, so a change that made
   research worse would move all of them together and read as "no regression".
   Every balance number derived from these strategies is conditioned on one
   research assumption that is demonstrably poor: group A never buys
   `galley_design` or `torsion_physics` (it stalls at 21 techs), and `player` —
   buying 23 in a different order — finishes in **2147 s**, roughly **half** of
   `fast-age`.

Order is a *minor* lever, and the earlier reading of this section was wrong.
`player` (2147 s) and `speedrun` (8243 s) both buy all 23 techs and differ only in
sequence — a ~4x spread. But they do not differ *only* in sequence: they also
carry different worker splits, building priorities and research-timing rules.
That ~4x was wrongly attributed to order.

`tools/age1-tech-search.ts --factorial` separates the two by running each base
strategy under both known orders. **Post-fix engine:**

| base strategy | advisor order | `player` order | order effect |
| ------------- | ------------- | ------------- | ------------ |
| `economy`     | 3371 s        | 3196 s        | **+175 s (5.2 %)** |
| `player`      | 2237 s        | 2147 s        | **+90 s (4.0 %)** |
| `fast-age`    | 4074 s        | 4246 s        | **−172 s (−4.2 %)** |

The `player` order is *worse* than the shipped advisor order on `fast-age`. Holding
the order fixed instead, the spread **across base strategies** is:

| order held fixed | spread across bases |
| ---------------- | ------------------- |
| advisor          | 1837 s (**82.1 %**) |
| `player`         | 2099 s (**97.8 %**) |

So the honest attribution is roughly **20 : 1 in favour of the base strategy over
the research order** — and note that `player` + advisor order is still 2237 s
against `fast-age` + advisor at 4074 s, so `player`'s advantage is *entirely* in
its base strategy, not its tech order.

That base strategy is the worker split: `player` sends half its workers to science
and 17.4 % to metalwork, on top of a research *pause* — which, since the
worker-gating fix, has turned out to be inert (§8.0). The worker split is exactly
the axis `AgeOnePolicy` never searched (§8), and it is already at its measured
optimum in `player`, so there is nothing left on this axis for a search to find.

**Everything in this table is best-known feasible, not proven optimal.** The gap
to $T_{LB}$ is not closed and the event-driven NLP of §6 is documented but not
implemented, so no claim of the form "the minimum is $T$" is justified.

### Two bugs the search itself taught us

Both were found by running it, not by reading it, and both are the kind that a
green typecheck does not catch:

1. **A `gather` placed above a purchase ladder starves it.** The first version
   gathered for science whenever a tech was unaffordable; science clicks are worth
   `0.1` each against a university's ~1/s, but the gather _consumes the whole
   simulated second_. The policy spent 19 995 of 20 000 actions gathering and never
   reached the Iron Age.
2. **A monotone CEM refit cannot recover.** Capping sigma at its previous value
   makes the search unidirectional: once a generation's elites are all failures,
   the mean drifts into the dead region and sigma can only shrink, so every later
   generation fails too. The fix is to cap sigma at the _initial_ width and to
   reset the distribution outright when a generation produces zero arrivals.
   Best-so-far elitism is needed for the same reason.

## 9. Running the search

Three tools, all deterministic (the simulation is seedless; only the CEM sampler
is seeded, via `--seed`).

```powershell
# 1. every strategy at the age-1 objective, plus a CEM search over AgeOnePolicy
.\tools\node\npx.cmd tsx tools\age1-optimize.ts --iterations=8 --population=12 --elite=3 --horizon=12000 --baseline

# 2. attribute a strategy's speed to research order vs. base strategy (2x2)
.\tools\node\npx.cmd tsx tools\age1-tech-search.ts --factorial --horizon=12000

# 3. sweep the science-worker share x research gate on a player descendant
.\tools\node\npx.cmd tsx tools\age1-tuned.ts --grid --science=0,0.25,0.5,0.7 --gate=always
```

`--baseline` uses `getStrategyNames()`, not a hand-written list — an earlier
hardcoded list silently omitted both `economy` and `player`, which is how two
successive reports managed to name `fast-age` as the thing to beat.

Reports go to `sim-output/` (gitignored). `age1-tuned.ts` also exports
`TunedPlayer` and `playerParams()` for import. **Caveat:** each evaluation is a
full simulation (~5–90 s depending on how long the run goes), and all three tools
evaluate more than one policy per process — fine, since within a process repeats
are bit-identical, but do not compare numbers across different trees.

### Which of these are still worth running

- `age1-optimize.ts` — **superseded.** Its policy family has no science/metalwork
  worker axis and its 4134 s result is beaten by hand-set parameters. Keep it only
  as a contrast for §8.
- `age1-tech-search.ts --factorial` — **yes.** The 20 : 1 attribution is the
  durable result, and the order search is a well-posed space (ordinal pricing means
  any 23-tech path costs the same).
- `age1-tuned.ts --grid` — **yes.** It is what found the science-share optimum and
  what proved the research pause inert.

## 10. Caveats

- **`SimulationResult.events` under-reports objective-terminated runs.** `run()`
  returns before the next `tick()` records events, so the final action of a run
  that ends on its objective never appears there. Any tooling that diffs
  `events` to time the last step is blind to it — diffing the state's own id
  lists (or reconciling against `finalState`) is the fix. This is an engine-level
  issue, not a tool one, and affects any future consumer of `events`.
- **Determinism.** Simulations have no random draws, so results are reproducible
  for the same initial state and policy. The optimizer's `--seed` controls only
  its candidate-search sequence and reproduces a search for the same flags.
- **`ExpNumber` everywhere.** Anything that grows without bound is an
  `ExpNumber`; a float-based optimizer formulation would need log-space care.
- **The search optimizes a policy family, not the game.** A better $T$ found here
  means _the ladder can be ordered differently_, not that the engine has more
  headroom. It is a pacing tool and a balance signal (AGENTS.md §7.2), not a
## 11. Why `speedrun` stays 8th: the ROI weights are a zero-sum dial

`speedrun` reaches age 1 in **6540 s** against `player`'s 2147 s. The obvious
target is `tools/roi.ts`, and the stall is genuinely there — but fixing it does
not compose with the other strategies. This section records the measurements so
the next attempt does not repeat them.

### The defect, stated exactly

`speedrun`'s army freezes for 3000 s of the age:

```
t=2632  batt=2  army=3812   warrior:46
                                  ← unchanged
t=5632  batt=2  army=3812   warrior:46
t=6232  batt=2  army=98309  spearman_bronze:62, chariot_bronze:8
```

Two things in `roi.ts` cause it together:

1. **`military` is a `logGain` on raw army power.** Growing 3812 → 5000 is a 31%
   gain but only 0.12 of a decade, so an incremental recruit scores ~0.1. A
   logarithm is the wrong shape for a stockpile being filled toward a fixed
   enemy.
2. **The weights are not on a common scale.** `researchTime` and `campaignTime`
   are both ratios capped at 1, yet are weighted **100** and **50**. Any research
   therefore outscores every building and unit by two orders of magnitude.

Together: units can never win a comparison, however badly the age needs them.

### What was measured (all vs. the same 7200/60 baseline, "age1" column)

| Change | speedrun | Other strategies |
| --- | --- | --- |
| `military` → threat-closure ratio, weight 12 | 109 → **105** | player `=`, balanced −1, military −4; cheapest +3, economy +3, fast-age +3, research +7, trader +5 |
| … same, residual credit removed | 109 → 111 | research +5, trader +5, cheapest +3, economy +3, fast-age +3 |
| … same, weight 3 | 109 → 109 `=` | cheapest +3, economy +3, fast-age +3, research +5, trader +5 |
| `military` → closure **and** `researchTime` 100→8, `campaignTime` 50→8 | 109 → **82** | balanced −1, military −4, production −1; cheapest +3, economy +3, fast-age +3, research +7, player +5, trader +5 |

Two things fall out of this table:

- **Only the combined rescale buys a large speedrun win** (−27 min), and it costs
  six strategies. Under AGENTS.md §7.2 that is a failed change, so it was reverted.
- **The regressions survive at weight 3, where `speedrun` is unchanged.** They are
  caused by the metric's *shape*, not its weight. Any evaluator that pays for
  army differently re-ranks the other nine strategies, because they all call the
  same `getBestRoiAction`.

### The real blocker — and the fix that works

`metricWeights` is not a per-strategy preference — it is a **shared objective
function** for every strategy that uses the ROI. Making `speedrun` good at
`roi.ts` means spending other strategies' time, so "speedrun faster, everyone
else unchanged" is not a tuning problem, it is unreachable by editing the dial.

It *is* reachable by making the dial **per call**:

- `RoiOptions.metricWeights` — a partial overlay on the shared defaults.
- `RoiOptions.militaryMetric` — `"logGain"` (the historical metric, still the
  default) or `"threatClosure"`.

`SpeedrunStrategy` opts into `{ military: 12, researchTime: 8, campaignTime: 8 }`
plus `threatClosure`, and nothing else passes either option.

### Result

Measured in **one process against the same balance**, so the two arms cannot
drift apart (the tree had just gained two commits, which invalidated every
earlier recorded baseline):

| | age 1 reached |
| --- | --- |
| `speedrun`, shared defaults | 6531 s |
| `speedrun`, own profile | **4877 s** (−25%) |

Every other strategy, measured in the same process: `player` 2180, `research`
3206, `economy` 3544, `military` 4017, `production` 4124, `balanced` 4168,
`fast-age` 4348, `trader` 5129, `cheapest` 5901 — **all unchanged**, since none
of them passes the new options. `speedrun` moves from 8th to 7th, and the
4877 s matches what the *global* rescale achieved (4920 s) while costing nobody
else anything.

Two things the measurements settled, both now recorded in the code:

- **The metric shape matters, not the weight.** `military: 100` on its own gave
  7448 s — *worse* than baseline. Scaling a signal that is already the wrong
  shape only amplifies the mistake.
- **`researchTime` is load-bearing for `speedrun`.** Cutting it to 8 alongside
  `military: 100` made the strategy stop completing the age at all: it built an
  army and never researched the units that army needed. The tech line is what
  unlocks the recruits, so it cannot be starved.

### Caveat on the surrounding test suite

The suite is **not** green on this branch, independently of this work. At clean
`HEAD` (`800cc89`) five files already fail (16 tests); with the working tree it
is six files (18 tests). The extra two are in `tools/simulation.test.ts` and
come from the **uncommitted dynamic research-order work** already present in
`tools/strategies.ts` — not from the ROI profile. Verified directly: disabling
`speedrun`'s profile entirely (`metricWeights = {}`, `militaryMetric =
"logGain"`) leaves both failures in place.
  proof of a lower bound.
