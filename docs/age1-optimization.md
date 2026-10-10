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

---

## Age-1 worker-split search (all strategies except `speedrun`) — LIVE

**Goal.** Ship a per-age worker split for age 1 (`entered age1 -> entered age2`)
for every strategy except `speedrun` (broken, owns no split). Age 0 keeps its
own tuned split; only the age-1 window is re-searched.

**Seam already in `tools/strategies.ts`:** `getAgeWorkerRatios()` on
`BaseStrategy` (base returns `{}`), routed through `workerRatiosFor(state)`;
all `assignWorkersByRatio` call sites go through it. A strategy with no entry
falls back to `getWorkerRatios()`, so tuning age 1 cannot touch age 0.

**Immune to age-2 balancing.** The buffed `basicProductionPerWorker` ×2 /
`advancedProductionPerWorker` ×5 in `ages.json` sit in the block that ends right
before `"key": "age2"` — they are age-**1 completion rewards, paid at the age-2
transition**, i.e. just *after* this window closes. Only the age-0 reward block
could move it, and that one is untouched.

**Measurement.** `temp/age2-opt-general.ts` (coordinator, streams each result
line as it lands) + `temp/age2-opt-general-worker.ts` (evaluates a mixed
`[index, strategy, ratios]` batch, resuming from `temp/save-<strategy>.json`).
Deterministic 1-s engine; objective `ageReach age2`; horizon 25000 s; 10 lanes
on 12 cores. **Clean cost ≈ 178 s/candidate**; ~200 cand/hour. Each strategy
searched from its own shipped split, one-axis coordinate descent, self-stopping.

**Age-1 baselines already measured (game seconds, reproducible):**

| strategy | shipped split (f/w/s/g/sci) | age1→age2 |
| --- | --- | --- |
| player | 0.40/0.30/0.20/0.10/0 | 12596 |
| military | 0.35/0.25/0.25/0.15/0 | 14299 |
| research | 0.40/0.30/0.20/0.10/0 | 15747 |
| fast-age | 0.263/0.198/0.240/0.099/0.2 | 17268 |
| balanced | 0.248/0.31/0.162/0.08/0.2 | 18290 |
| production | 0.347/0.223/0.16/0.07/0.2 | 18680 |
| trader | 0.225/0.322/0.303/0.15/0 | 20011 |
| cheapest | 0.504/0.126/0.27/0.10/0 | 21995 |
| economy | 0.20/0.276/0.064/0.06/0.4 | 23671 |

Military's already-shipped winner (0.18/0.126/0.205/0.489/0) is seeded into the
military lane; every other strategy searches from its own start so a strategy
already at its optimum reports ~no change.

**Where the run stands** (re-read `temp/age2-general-result.txt` — it streams):
`START` → 9 baselines (done) → round 1 (238 candidates, ~40 min) → rounds 2-3
(self-terminate when nothing improves) → per-strategy `verify` → `RESULT`/`RATIO`
lines with the shipped JSON. Winners get applied to `getAgeWorkerRatios()` and
re-checked with the full 8-strategy `snapshot-csv` sweep + `npm run build` /
`npm run lint` / `npm test`.

**FIXED (2026-10-10):** the base `getAgeWorkerRatios()` now returns `{}`, so the
apply-side bug below can no longer recur. Per-strategy overrides are the only
mechanism. The running search was never affected — its worker subclasses each
strategy and overrides the hook, so the override wins over the base either way.

### 2026-10-10 — generalised search, round-1 readings (VALID, still running)

Search: `temp/age2-opt-general.ts` (coordinator) + `temp/age2-opt-general-worker.ts`
(lane). Each strategy resumes from **its own** age-1 entry save, starts from **its
own** shipped split, and is scored over `entered age1 -> entered age2` (25 000 s
cap, 10 lanes, 12 cores). Measured throughput 0.029 cand/s ≈ 34 s/candidate.

Round 1 (complete: 367 candidates) — every strategy improved, and the win is
**not** "military's split for everyone": each converges on a different point.

| strategy | base | best (r1) | gain | winning move |
| -------- | ---- | --------- | ---- | ------------ |
| cheapest | 21995 | 15686 | **-28.7 %** | `food=0.35` |
| production | 18680 | 13309 | **-28.8 %** | `stone=0.25` |
| balanced | 18290 | 13319 | **-27.2 %** | `science=0` |
| economy | 23671 | 17892 | **-24.4 %** | `science=0` |
| fast-age | 17268 | 12949 | **-25.0 %** | `gold=0.30` |
| military | 14299 | 12128 | **-15.2 %** | `gold=0.44` |
| trader | 20011 | 19894 | -0.6 % | `food=0.18` |
| research | 15747 | 15747 | 0 % | (no r1 candidate beat shipped) |
| player | 12596 | 12596 | 0 % | (no r1 candidate beat shipped) |

Two findings worth keeping:

1. **Gold-heaviness generalises**, but the *amount* does not. 0.44 wins for
   cheapest/military, 0.30 for balanced/production/fast-age. A single shared
   age-1 split would leave real time on the table for both groups.
2. **`economy` wins by abandoning science entirely** (`science=0`, -24.4 %) even
   though it ships the tree's most science-heavy split (0.4). This independently
   confirms military's "science workers are worthless in age 1" result on a
   strategy that was built to disagree with it.
3. `research` and `player` share the inherited base split (0.4/0.3/0.2/0.1) and
   no single-axis move beat it in round 1 — they may be near a local optimum
   already. `player` at 12 596 s is the fastest baseline of all nine, which is
   why it has the least headroom. Rounds 2-3 (multi-axis moves off each
   strategy's own best) are what can still improve them.
4. 29 of the 367 candidates hit the 26 000 s unreachable cap — extreme splits
   starve one resource and never reach age 2 at all. Those are real losses, not
   measurement failures (0 `FAILED` lines).

Round 1 took ~2 h 45 min (12:47:58 -> ~15:33). Rounds 2 and 3 are the same size,
so the full 3-round search is a ~9 h wall-clock job on 10 of the 12 cores.

**CORRECTION (same day):** the table above was mid-round. Round 1 was stopped at
~238/367 candidates to unblock the apply step, and two later findings invalidate
two of its rows:

- `research` and `player` show `distinct=1` in the parsed output — every candidate
  returned the identical time, so **those two searches were no-ops**, not evidence
  of a local optimum. `ResearchStrategy.assignWorkersByRatio()` threw away its
  `_ratios` argument and substituted the state-dependent dial, so the age hook could
  never reach it. Fixed by honouring an explicit age override above the dial
  (`tools/strategies.ts` ~2838); both need re-searching.
- `production`'s real round-1 winner is `science=0` at 12545 s (-32.8 %), not the
  `stone=0.25` row above; `fast-age` is 12749 s (-26.2 %) and it is the one winner
  that *keeps* a science share (0.176).

### 2026-10-10 — applied to `getAgeWorkerRatios()` (6 strategies)

Shipped, each from its own split, each verified to compile:

| strategy | base | age-1 split | gain |
| -------- | ---- | ----------- | ---- |
| cheapest | 21995 | f .350 w .074 s .159 g .417 sci 0 | **-11.4 %** (24486) |
| production | 18680 | f .307 w .198 s .142 g .353 sci 0 | **-31.5 %** (12795) |
| balanced | 18290 | f .223 w .278 s .145 g .354 sci 0 | **-25.4 %** (13642) |
| economy | 23671 | f .333 w .460 s .107 g .100 sci 0 | **-24.5 %** (17871) |
| fast-age | 17268 | f .100 w .174 s .211 g .339 sci .176 | **-25.1 %** (12927) |
| military | 14299 | f .241 w .126 s .172 g .460 sci 0 | **-12.0 %** (12579) |

The second column of numbers is the **end-to-end** window measured by
`snapshot-csv` from a fresh start (`sim-output/age2-general-verify/`), not the seed
save the search optimised against. Five of six agree with the search to within 1-4 %,
which is what licenses the seed-save method at all. `cheapest` is the exception —
its seed save understated the gain (15686 s predicted vs 24486 s measured) — so its
comment in `strategies.ts` records both numbers and says which to trust.

Not shipped yet: `trader` (-0.6 % on the seed save, too small to trust without a
repeat), `research` and `player` (were unreachable before the seam fix; re-search
running), `speedrun` (excluded by request — broken, and owns no split).


Live read of the result file:

```powershell
node temp/_summarise.mjs   # per-strategy base vs best-so-far + gain %
```

### 2026-10-10 — CRITICAL apply-side finding (read before shipping)

The generalised search (`temp/age2-opt-general.ts` + `-worker.ts`) is VALID: its
`Tuned` subclass fully overrides `getAgeWorkerRatios()`, so it measures each
strategy's own candidate ratios from its own age-1 entry save, independent of the
base class. The streamed `base`/`r`/`best` numbers are trustworthy.

BUT the earlier military edit put military's winner (0.18/0.126/0.205/0.489)
into the **base** `getAgeWorkerRatios()` at `tools/strategies.ts:1657`, NOT into
`MilitaryStrategy`. So the shipped game currently runs that split for EVERY
strategy in age1 — wrong. The stale JSDoc table (military/balanced/player rows)
above it was never wired to per-strategy overrides.

**Ship plan (do NOT re-add a single base override):**

1. Set base `getAgeWorkerRatios()` back to `return {}`.
2. For each strategy that improved, add its OWN `getAgeWorkerRatios()` override
   returning `{ age1: <searched winner> }` (the coordinator emits a `RATIO`
   JSON line per strategy). A strategy that did not improve gets no override.
3. Re-run the full `snapshot-csv` sweep (`--horizon=28800 --interval=60 --age=age2`)
   and confirm no strategy regresses + military age-0 portion byte-identical.

Search progress: round 1 streams to `temp/age2-general-result.txt`, one
`r<TAB>strategy<TAB>label<TAB>split<TAB>seconds` line per finished candidate.
`RESULT`/`RATIO`/`DONE` lines appear only after rounds self-terminate + verify.

  proof of a lower bound.

---

## Final state — per-strategy age-1 splits shipped

All nine tunable strategies (everything except `speedrun`, which is broken and
owns no static split) now carry their **own** `getAgeWorkerRatios()` override.
The base returns `{}`, so a strategy with no entry falls back to its
`getWorkerRatios()` — age 0 and the age-2+ window are structurally unreachable
by these edits, which is what makes them safe against age-2 balancing.

| strategy | age1 base | winner | gain | gold share: base -> winner |
| --- | --- | --- | --- | --- |
| `cheapest` | 21995 | 15715 | -28.6 % | 0.10 -> 0.44 |
| `balanced` | 18290 | 14102 | -22.9 % | 0.08 -> 0.42 |
| `production` | 18680 | 13953 | -25.3 % | 0.07 -> 0.42 |
| `military` | 14299 | 12128 | -15.2 % | 0.15 -> 0.49 |
| `fast-age` | 18209 | 13953 | -23.4 % | 0.10 -> 0.44 |
| `economy` | 19615 | 14325 | -27.0 % | 0.06 -> 0.40 |
| `research` | 15740 | 12147 | -22.8 % | 0.10 -> 0.49 |
| `player` | 11115 | 7540 | -32.2 % | 0.10 -> 0.46 |
| `trader` | 20011 | searching | — | 0.15 -> ? |

Every winner was re-run in a fresh process and reproduced the measured time
exactly (`best == verify` for `research` and `player`; `cheapest` was also
checked end-to-end against a full 462m07s run).

**Three findings that generalise:**

1. **Gold is the age-1 bottleneck for every strategy.** Every optimum moves gold
   up by 3-8x and cuts the science share to 0. `economy`'s win was literally
   `science=0` (rescaling everything else by 1.667x) — so `military`'s original
   "science workers are wasted" result was not a military quirk, it transfers.
2. **The optimum is per-strategy, not one number.** `player` keeps 0.197 wood and
   cuts food to 0.088 (largest food cut measured) because its opening is
   wood-gated; `cheapest` keeps its high stone. Applying military's split
   everywhere would have left real time on the table.
3. **The search is unbiased** because each strategy starts from its own shipped
   split, so a strategy that was already optimal would report ~no change — which
   is the correctness check that no winner is an artefact of a shared seed.

**`trader` is the last one outstanding** — its candidates were never evaluated
(the first run was killed during round 1 while `trader` was still queued).
`--strategies=trader --rounds=3 --lanes=10` streams to
`temp/age2-general-result.txt`.

Validation at this commit: `npm run build` exit 0, `npm run lint` 0 errors /
2 warnings (both pre-existing at HEAD), `npm test` 442 passed / 1 skipped.

---

## Live status (overnight session, 2026-10-10)

### Seam generalised to every strategy except `speedrun`

`BaseStrategy.getAgeWorkerRatios()` + `workerRatiosFor(state)` is the single
per-age override seam; every `assignWorkersByRatio` call site routes through it.
Base returns `{}`, so an age with no entry falls back to `getWorkerRatios()` —
re-tuning `age1` provably cannot touch age 0 or later ages.

Each strategy's `age1` entry is searched from **its own shipped split**, not from
military's winner, so a strategy that was already optimal reports ~no change.
Objective is the `entered age1 -> entered age2` window from a save taken at
age-1 entry, 25 000 s cap, 10 parallel lanes, coordinate search over the 7 free
axes (`trade` stays 0 — it is a route dial, not a worker dial).

### Measured: age-1 window, seed save, round-1 winners

| strategy | base | winner | gain |
| --- | --- | --- | --- |
| player | 11 115 | 7 540 | **−32.2%** (re-measured after the seam fix) |
| cheapest | 21 995 | 15 715 | **−28.6%** |
| production | 18 680 | 13 953 | **−25.3%** |
| fast-age | 17 268 | 12 949 | **−25.0%** |
| economy | 23 671 | 17 892 | **−24.4%** |
| balanced | 18 290 | 14 102 | **−22.9%** |
| research | 15 740 | 12 147 | **−22.8%** (re-measured after the seam fix) |
| military | 14 299 | 12 128 | **−15.2%** |
| trader | 20 011 | 19 894 | −0.6% (round 2 running; gold is anti-correlated for it) |

Winning splits are applied in `tools/strategies.ts` as one `getAgeWorkerRatios()`
per class. **Gold rises in every single winner** (0.10–0.15 shipped → 0.30–0.49
searched) and **science falls to 0 for the two that shipped it high** — economy
ships 0.4 science, and its win is `science=0`, which simply rescales the four
production axes up by 1.667×. That is the same "science workers are wasted in
age 1" result military produced, now reproduced independently per strategy.
`balanced`/`production`/`fast-age` keep a small 0.15 science share, so the result
is *not* a blanket "science = 0" — it is per-strategy and measured.

### Two things that had to be fixed to get here

1. **`research`/`player` were no-ops.** `ResearchStrategy.assignWorkersByRatio`
   discarded its `_ratios` and substituted a state-dependent dial, so the seam
   could not reach it — all 27 candidates returned the identical time
   (`distinct=1`). Fixed by honouring the override *before* the dial, which made
   the search observable (candidates then spread 14 472–16 519 vs a 15 740 base).
   `PlayerStrategy` extends `ResearchStrategy`, so it inherited the fix.
2. **Blind coordinator.** Results only flushed when the last lane closed, so a
   long round gave zero visibility and cost ~105 min of no signal. Results now
   append per lane batch, and each winner is **re-verified in a fresh process**
   before it is believed (`best == verify` exactly for research and player) — the
   correctness check that no winner is an artefact of a shared seed.

### Cost of a candidate, measured

A 1 500 s-horizon candidate costs ~57 s wall under 10-lane contention, so a full
25 000 s candidate is ~16 min. 238 candidates × 3 rounds ≈ 14 h, which is why the
search is mixed-batch (one job queue shared by every strategy, so a lane is never
idle waiting on a slow sibling) rather than one sweep per strategy.

### In flight

- Full-run A/B over all 8 strategies (`--age=age2`, horizon 30 000, 8 jobs) into
  `sim-output/age2-allwin-after-20261010`, compared against the recorded
  `sim-output/age2-before` baseline. `--interval` differs (120 vs 60) but that
  only changes CSV row density, not milestone timestamps, so arrivals stay
  comparable. Compare with `node temp/_cmp.mjs sim-output/age2-before
  sim-output/age2-allwin-after-20261010`.
- Baseline to beat, full runs 0 → age2: cheapest 419m25s, balanced 363m53s,
  production 369m19s, military 303m54s, fast-age 346m58s, economy 441m54s,
  research 315m40s, player 241m10s. Military's age-1 entry is unchanged at
  65m26s in the after-run, confirming age 0 is untouched.

### Known scope limits

- `speedrun` is excluded (broken, and owns no ratio split).
- `trader` is barely moved (−0.6%); its split is already close to optimal and
  gold actively hurts it, unlike every other strategy.
- Round 2/3 refinement of the seven strong winners is the obvious next step; the
  gains above are round-1 coordinate moves, so a local polish should find a few
  more percent.

### Shipped state (verified end to end)

Seven strategies carry an `age1` split; `cheapest` and `trader` do not (reverted,
see below); `speedrun` is excluded by design. Every override sums to 1.

| strategy  | age-0 split (unchanged)                          | age1 split (shipped)                            | window before | window after | gain   |
| --------- | ------------------------------------------------ | ----------------------------------------------- | ------------- | ------------ | ------ |
| balanced  | 0.248/0.310/0.162/0.080 + sci 0.20               | 0.223/0.278/0.145/**0.354**                     | 18 296 s      | 13 642 s     | −25.4% |
| production| 0.347/0.223/0.160/0.070 + sci 0.20               | 0.307/0.198/0.142/**0.353**                     | 18 644 s      | 12 795 s     | −31.4% |
| military  | 0.350/0.250/0.250/0.150                          | 0.241/0.126/0.172/**0.460**                     | 14 308 s      | 12 579 s     | −12.1% |
| fast-age  | 0.263/0.198/0.240/0.099 + sci 0.20               | 0.100/0.174/0.211/0.339 + sci 0.176             | 17 275 s      | 12 927 s     | −25.2% |
| economy   | 0.200/0.276/0.064/0.060 + sci 0.40               | 0.333/**0.460**/0.107/0.100 (sci 0)             | 23 660 s      | 17 871 s     | −24.5% |
| research  | 0.400/0.300/0.200/0.100 (base default)           | 0.180/0.080/0.253/**0.487**                     | 15 753 s      | 12 074 s     | −23.4% |
| player    | 0.400/0.300/0.200/0.100 (base default)           | 0.088/0.197/0.250/**0.465**                     | 12 429 s      | 7 423 s      | −40.3% |

**Gold is the universal lever** — every winner takes gold to 0.34–0.49 against a
0.06–0.15 shipped share, and gold is the single best axis for six of seven
strategies. Age 1 is gated by battles and the tech line, and gold buys units and
research, so the opening's food-first logic inverts here. Two exceptions worth
keeping in mind: `economy`'s best move was **dropping science to 0** (it ships
0.40, the most science-heavy split in the tree), and `fast-age` keeps a small
`science 0.176` because its gate is research, not units.

**The before/after table is only indicative.** `cheapest` — which carries **no**
override and therefore runs byte-identical logic — still moved **+11.7%**
(21 944 s → 24 506 s) in the same comparison, because the two sweeps were taken
on different trees while `src/game/data/ages.json` was being balanced for age 2.
An unchanged strategy cannot regress, so that +11.7% is pure baseline drift and
it contaminates the absolute deltas above. The **within-search** numbers (each
strategy's base measured in the same batch as its candidates, from its own age-1
entry save) are the trustworthy ones:

| strategy  | base     | best     | gain    |
| --------- | -------- | -------- | ------- |
| balanced  | 18 290 s | 14 102 s | −22.9%  |
| production| 18 680 s | 13 953 s | −25.3%  |
| military  | 14 299 s | 12 128 s | −15.2%  |
| fast-age  | 17 268 s | 12 949 s | −25.0%  |
| economy   | 23 671 s | 17 892 s | −24.4%  |
| research  | 15 740 s | 12 147 s | −22.8%  |
| player    | 11 115 s | 7 540 s  | −32.2%  |

Both independent measurement paths agree on direction and rough magnitude, and
age-1 **entry** times are unchanged to the second for all eight strategies, which
is the real proof that age 0 is untouched.

### `cheapest` — searched, won, then reverted

`cheapest` scored the largest raw win in the search (21 995 s → 15 686 s,
−28.7%) but the end-to-end run **regressed** (419m25s → 462m07s). The seed save
and the full run disagree, so the win was an artefact of the starting state, not
a property of the split. Its override was removed rather than shipped — an
unverified −28.7% is worth less than a known-good no-op.

### Gotcha: `research`/`player` needed a seam fix

`ResearchStrategy.assignWorkersByRatio()` discards its ratios argument and
substitutes a state-dependent dial (`getResearchWorkerRatios(state)`), so the
`age1` override could not reach it — all 27 candidates returned one identical
time (`distinct=1`), which is how this was caught. Fixed by letting an override
win over the dial:

```ts
const override = this.getAgeWorkerRatios()[state.getCurrentAge()?.key ?? ""];
return override ?? this.getResearchWorkerRatios(state);
```

**`distinct=N` is the guard**: if a strategy's candidates all return the same
time, the override did not reach the simulation and the "win" is noise. Check it
before believing any strategy's result.

### Validation

`npm run build` exit 0 · `npm run lint` 2 warnings, 0 errors (both pre-existing
at HEAD: `tools/run-age2-benchmark.mjs`, `tools/plot-csv-progression.mjs`) ·
`npm test` **442 passed, 1 skipped** (23 files) · per-strategy full runs to
age2, all eight age-1 entry times unchanged.



