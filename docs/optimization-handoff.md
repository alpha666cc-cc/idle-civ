# Optimization handoff (session notes)

Written to hand context to another model or a fresh session. Everything here was
**measured**, not assumed. Where a claim was tested and failed, the failure is
recorded too — several of them cost real time and are cheap to re-walk.

Companion docs: `age1-optimization.md` (the math and the 2×2 attribution),
`game-scope.md` (content manifest), `mechanics-reference.md` (generated data dump).

---

## 1. The one finding that closes a whole direction

**Research is priced by ordinal, not identity.**

`CivilizationState.getResearchCostForCount(count)` prices the **n-th** tech
bought in the *current age* at `base · factor^(√n − 1)`. It does not read the
research's key. Consequences:

- Every research available in an age costs **exactly the same**.
- Any path that buys all 23 Age-0 techs pays the same total, whatever order.
  (`tools/simulation/age1-tech-search.ts` records the total: 10 131 950 science.)
- Therefore **price cannot rank research options.** Dividing a value score by
  price divides by a constant and cancels.
- Within an age, `canBuyResearch` is true for all unlocked techs or none — so an
  affordability-weighted sort is uniform and cancels too.
- "It will cost more later" is true *in total* and is why idling research is bad,
  but the escalation is uniform, so you cannot exploit it by reordering.

This is why "improve the dynamic research order by making it price-aware" is a
dead end. It was implemented, benchmarked, and moved **no strategy at all** —
nine of ten came back byte-identical. The affordability term and the never-idle
fallback were kept (harmless, defensively correct) but they are not levers.

## 2. What actually moves the number: 20 : 1 in favour of workers

From `docs/age1-optimization.md` §8.4 (`age1-tech-search.ts --factorial`):

| held fixed | spread across base strategies |
| --- | --- |
| research order (advisor) | 1837 s (82.1 %) |
| research order (`player`) | 2099 s (97.8 %) |

vs. the research-order effect, measured 90–175 s (4–5 %) and **sign-flipping**:
the `player` order is *worse* on `fast-age` (−4.2 %).

Corroborating: `economy` and `fast-age` buy the same 21 techs in the same order
and differ by 703 s (21 %) — pure worker split and building order.

**So: worker allocation is the dominant lever, and research order is a small,
strategy-dependent one.** Treat any plan that leads with research ordering as
mis-prioritised.

### ⚠ An unresolved contradiction, worth 11 minutes

`age1-optimization.md` attributes only **175 s** to the order on `economy`.

## 3. Benchmark discipline (a false positive already happened)

**Optimiser numbers are not benchmark numbers.** `military` improved ~2 % in the
scratch optimiser and was **one minute slower** on the §7.2 benchmark. It was
reverted. This is the single most expensive mistake available here.

Rules that follow:

- Every `tools/simulation/strategies.ts` edit needs `snapshot-csv.ts` before **and** after,
  same `--horizon` and `--interval`, then `compare-bench.ts`.
- Optimise, then benchmark. Never ship an optimiser result directly.
- The simulation is **deterministic and has no seed**. Within a process,
  repeats are bit-identical. Timings are **game time**, not wall-clock, so CPU
  contention costs wall-clock but never correctness — parallel search is safe.
- Do not compare numbers across different trees (§9 caveat).

## 4. Current validated worker ratios (`tools/simulation/strategies.ts`)

Benchmark-confirmed, `--horizon=12000 --interval=60`, vs. the pre-tuning baseline:

| strategy | food/wood/stone/gold | science | before → after |
| --- | --- | --- | --- |
| `cheapest` | .504/.126/.270/.100 | 0 | 99 m → **52 m** |
| `trader` | .225/.322/.303/.150 | 0 | 86 m → **68 m** |
| `fast-age` | .263/.198/.240/.099 | 0.20 | 73 m → **61 m** |
| `production` | .347/.223/.160/.070 | 0.20 | 69 m → **58 m** |
| `balanced` | .248/.310/.162/.080 | 0.20 | 70 m → **60 m** |
| `economy` | .200/.276/.064/.060 | 0.40 | 60 m → 53 m |
| `military` | .350/.250/.250/.150 | 0 | 68 m (unchanged) |
| `player` / `research` / `speedrun` | custom paths | — | untouched |

**Science share is large and was badly underestimated.** A science sweep found
interior optima — `balanced` 0.20, `production` 0.20, `fast-age` 0.20,
`economy` ≥0.40 (at the grid edge). A first 4-resource-only search had frozen
science at 0, and "age entry checks no research requirement" was then mistaken
for "research does not matter for age 1". It does: research unlocks the bronze
units that win First Fire / Wolf Pack / **Troy**, which *is* a hard gate.
`economy` 0.40 is still an unexplored edge.

**`military` is still unoptimised.** Its one candidate regressed and was
reverted; it has never had a science-share sweep.

**`research`, `player` and `speedrun` cannot be tuned by ratio at all.**
`ResearchStrategy.assignWorkersByRatio` discards its `_ratios` argument and
substitutes `getResearchWorkerRatios(state)`. `PlayerStrategy` overrides it
again; `speedrun` uses `deriveWorkerRatios(state)`. Editing a static ratio on
those classes is a silent no-op.

A later A/B on the live benchmark measured **53 m → 42 m (660 s)** for
`economy` when given the `player` ladder *plus* its `pottery`/pop-200 pause.

Those cannot both be the whole story. The factorial isolates order only; the
660 s figure also moved the pause. Either the pause is **not** inert (§8.0 says

## 5. The action-slot economy (likely where the next bug lives)

`actionsPerSecond: 5`. Every gather, build, purchase **and worker reassignment**
consumes a slot. Two independent signals that this is the binding constraint:

- `age1-optimization.md` §8.5: one policy spent **19 995 of 20 000** actions
  gathering and never reached the Iron Age. Action budget, not resources, was
  the wall.
- "Worker assignment reverting itself too often" is the same phenomenon seen
  from the strategy side: a reassignment that lands back where it started costs a
  slot and changes nothing.

So the highest-value instrument is a **per-run action ledger** (actions bucketed
by type). It answers at least four open questions at once: how many
reassignments are no-ops, how many ticks buy no research, how much budget goes
to gathering, and how much to unit purchases. The benchmark's blindness (§8.4) is
the same problem at a higher level.

## 6. Research-order search results (measured, for reuse)

`economy` under various ladders, age-1 objective, ~2520 s baseline:

| variant | time |
| --- | --- |
| player order (23) | 2626 s |
| **drop `wheel_axle`/`galley_design`/`torsion_physics`** | **2520 s** |
| cost ascending | 2520 s |
| prefix 16 | 2532 s |
| prefix 13 | 2583 s |
| prefix 10 | 7206 s |
| `bronze` first | 2902 s |
| bonus descending | 4264 s |
| reversed | 8891 s |

- Trimming **further** is worse; 10 techs is a cliff, not a slope.
- A "skip unaffordable, buy the cheapest you can afford" policy was **exactly
  identical** to head-of-queue behaviour on all six families. Head-of-line
  blocking never fires, because of §1.
- The three dropped techs help because they *were* affordable and unlocked in
  Age 0 and got bought, spending science on purchases that do nothing for the
  Age-1 gate — **not** because they blocked anything.

## 7. Tooling notes

**`tools/simulation/age1-tech-search.ts --factorial`** — the 2×2 order-vs-base attribution.
Still worth running. **`tools/simulation/age1-tuned.ts --grid`** — found the science-share
optimum. **`tools/simulation/age1-optimize.ts`** — superseded, no science/metalwork axis.

**Parallel search pattern** (scratch, `temp/`, not committed): a coordinator
spawning one `node --import tsx` child per core, candidates passed as a JSON
argv. Safe because evaluation is deterministic and timing is game time.

Two bugs worth not re-inventing, both in that harness:

1. A crashed candidate yielded `undefined`, and `undefined < x` is `false` — so a
   *crashed* run looked like a *slow* one and the search silently searched a
   partial grid while printing a confident `RESULT`.
2. The fix for (1) was itself broken: `new Array(n)` is **sparse**, and `.map()`
   skips holes, so the failed entries — the only ones needing attention — were
   never visited and the miss counter read zero every time.

Check failures with an indexed `for` loop, never `.map()` over a sparse array.

## 8. Things a model will get wrong unless told

**1. Orders do not exist at Age 0–1.** `standard` is the only option; the other
seven unlock in Age 2–3. A strategy that budgets time for order selection at
Age 1 is optimising a knob that is not there.

**2. Research order cannot be optimised through cost.** Prices key on the
ordinal `n`, not the tech, so every ordering of the same 23 Age-0 techs costs
the identical 10 131 950 science. Research order is worth 4–5% and is
strategy-dependent (the `player` order is *worse* on `fast-age`).

**3. Worker allocation is the dominant lever — 20 : 1.** Holding research order
fixed, the spread across base strategies is 82–98%; holding the base fixed, the
order effect is 4–5%. `economy` and `fast-age` buy the same 21 techs in the same
order and differ by 703 s (21%).

**4. Science wants a much larger worker share than intuition suggests** —
measured interior optima of 0.20 (`balanced`, `production`, `fast-age`) and
≥0.40 (`economy`, at the edge of the grid). A university only makes 1/s on its
own; the share is the real lever.

**5. The action budget is the constraint, not resources.** 5 slots/second, and
reassigning workers costs one. A policy once spent 19 995 of 20 000 actions
gathering and never reached the Iron Age.

**6. Age entry has no research requirement** — only battles won plus a building
count, and the count comes from the *next* age's `buildingThreshold`.

**7. Units are never lost.** A defeat costs the opportunity, not the army, so
losing is cheap and the only question is wall-clock time to the next fight.

---

## 9. Open items, in the order I would take them

1. **Action ledger** (instrument; answers §5's four questions at once).
2. **Worker-assignment idempotence** — make a reassignment that changes nothing
   free, and stop flip-flops. Likely the largest single win, and it re-targets
   every ratio in §4 that was tuned under a possibly-thrashing allocator.
3. **Reconcile 660 s vs 175 s** (§2). Decides whether research ordering is a live
   lever at all.
4. **`economy` science share** past 0.40, and `military`'s first science sweep.
5. **`economy` worker ratios** re-search now that research buys more.
6. Balance items (ship strength, `torsion_physics`) — these live in
   `src/game/data/*.json`, which is user-owned balance work. Do not edit blind.

## 10. Known debt that looks like a bug

- `SimulationResult.events` **under-reports objective-terminated runs** — `run()`
  returns before the next `tick()` records, so the final action of a run that
  ends on its objective never appears. Diff the state's own id lists instead.
- The `getResearchAction` research *pause* (§2) may be inert — verify before
  relying on it either way.
- `age1-optimization.md` §11: `speedrun`'s ROI weights are a zero-sum dial, so it
  stays 8th; that is a defect with a known fix, not a tuning failure.

it became inert after the worker-gating fix — possibly no longer true), or the
worker's `getResearchWorkerRatios` difference leaked in. Reconciling this is
cheap and decides whether the research line is worth anything.
