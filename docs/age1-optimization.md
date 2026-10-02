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
   *action* that consumes an action slot, not a passive state.

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

| # | Constraint | Engine path that enforces it |
|---|---|---|
| C1 | Affordability; balances never negative (clamped) | `build`, `buyUnit`, `buyResearch`, `tick` |
| C2 | `T(n) = base·(F^{√n} − 1)` cumulative curve, §13.1 reductions `base → factor → percent → flat` per unit, clamped at 0 | `costSeries`, `costParameters` |
| C3 | Research priced by the **current age**: `200 · 12^{√i − 1}` science, $i$ = age-0 techs bought. `allBuildings` discounts never reach research | `getResearchCostForCount` |
| C4 | Workers integer, $\sum w_r \le P(t)$, reassignment free but costs an action slot | `assignWorker` |
| C5 | Capacities: `people ≤ peopleCapacity`, houses ≤ `houseCapacity`, production buildings ≤ 10 until an enhancer multiplies ×10 (threshold 9) | `getBuildingMax` |
| C6 | `barracks` ⇐ 90 people; `university` ⇐ First Fire won; `smithy` ⇐ 5 town halls; `market` ⇐ age1 (vacuous here) | `isBuildingAvailable` |
| C7 | Research DAG + age gate, e.g. `agriculture → tribal_organization/mining → bronze_smelting → bronze_casting → {wheel_axle, composite_bowcraft, galley_design}` | `isResearchUnlocked` |
| C8 | Units ⇐ unlock research (only `warrior` is base-available) | `isUnitAvailable` |
| C9 | Upgrades ⇐ building count ≥ threshold, plus their costs | `isUpgradeUnlocked` |
| C10 | Achievements ⇐ requirement, re-checked each tick | `checkAchievements` |
| C11 | A battle is won by `launchBattle` iff `simulateEncounter` returns `outcome: "player"` | `launchBattle` |
| C12 | Army recipes come from `solveMinimumArmy`; armies are never lost, so an army is a **one-time investment that persists** | `battleSimulator` |
| C13 | `getNextBattle` offers only the first unwon age-0 encounter — the campaign is sequential by construction | `getNextBattle` |
| C14 | Terminal: all four battles ∧ ≥1500 buildings ∧ `enterAge` fired | `canEnterAge`, `enterAge` |

## 5. Why it is not a plain MILP

The cost curves are `F^{√n}`, the research curve is `12^{√i}`, bonuses stack
multiplicatively, capacities are integer slots, and the battle predicate is a
black box (deterministic, but not a closed form). Piecewise-linear surrogates are
possible and would take the interesting structure out. What *does* work is the
decomposition in §6.

## 6. The decomposition that works

**RCPSP with nonlinear resource accumulation.** The project DAG is:

```text
barracks gate (90 pop) → First Fire → university → science tech chain
   → smithy (5 town halls) → Bronze Raid → full bronze tree → Fall of Troy
```

with the housing/population ramp and the 1500-building count as parallel
resource-consuming tasks. Battles become *milestones with precedence* rather than
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
3. **The science curve makes tech *order* nearly as important as tech *count*.**
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

Measured at this objective (`{ type: "ageReach", ageId: "age1" }`,
`gatherClicksPerAction: 10`, `actionsPerSecond: 5`, seed 42, from scratch):

| Policy | Age-1 arrival |
|---|---|
| `fast-age` (best shipped strategy) | 4020 s |
| `production` | 4088 s |
| `balanced` | 4221 s |
| `cheapest` | 5531 s |
| `speedrun` | 7866 s |
| `AgeOnePolicy` with `defaultPolicy()` | ~4600 s |

`defaultPolicy()` mirrors the shipped `fast-age` ratios so the search starts from a
competitive point rather than climbing out of a strawman.

**These are best-known feasible values, not proven optima.** The gap to $T_{LB}$ is
not closed, and the event-driven NLP of §6 is documented but not implemented, so
no statement of the form "the minimum is $T$" is currently justified.

## 9. Running the search

```powershell
.\tools\node\npx.cmd tsx tools\age1-optimize.ts --iterations=8 --population=12 --elite=3 --horizon=20000 --baseline
```

Flags: `--iterations`, `--population`, `--elite`, `--horizon`, `--seed`,
`--baseline` (re-run the shipped strategies to the same objective for a
like-for-like comparison), `--out`. Reports land in `sim-output/age1-optimize/`
(gitignored). Runtime scales roughly linearly in `iterations × population`; a
20 000 s run is a few seconds, so 6 × 10 takes a few minutes.

## 10. Caveats

- **`SimulationResult.events` under-reports objective-terminated runs.** `run()`
  returns before the next `tick()` records events, so the final action of a run
  that ends on its objective never appears there. Any tooling that diffs
  `events` to time the last step is blind to it — diffing the state's own id
  lists (or reconciling against `finalState`) is the fix. This is an engine-level
  issue, not a tool one, and affects any future consumer of `events`.
- **Determinism.** Battles have no damage RNG, so results are reproducible; the
  search itself is seeded (`--seed`) and reproducible for the same flags.
- **`ExpNumber` everywhere.** Anything that grows without bound is an
  `ExpNumber`; a float-based optimizer formulation would need log-space care.
- **The search optimizes a policy family, not the game.** A better $T$ found here
  means *the ladder can be ordered differently*, not that the engine has more
  headroom. It is a pacing tool and a balance signal (AGENTS.md §7.2), not a
  proof of a lower bound.