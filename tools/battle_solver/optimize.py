"""Offline minimum-military-cost battle solver.

This is deliberately a best-found search, not a proof engine: it uses the exact
Python port of the battle simulator to evaluate candidates, but reports
`proofStatus="best_found"` unless a bounded exhaustive mode is added later.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Callable

from .battle import simulate_battle_summary
from .costs import calculate_cost_series, military_cost
from .expnumber import ExpNumber
from .problems import iter_problems

MAX_COUNT = 10_000_000_000


def _serialize_count(count: int) -> dict:
    return ExpNumber.from_number(count).serialize()


class ProblemSolver:
    def __init__(self, problem: dict):
        self.problem = problem
        self.candidate_ids = list(problem["candidateIds"])
        self.stats = problem["candidateStats"]
        self.cost_params = problem["candidateCosts"]
        self.enemy_stacks = problem["enemyStacks"]
        self.max_rounds = int(problem.get("maximumRounds", 101))
        self.available_formations = set(problem.get("availableFormations", ["standard"]))
        self.available_orders = set(problem.get("availableOrders", ["focus_weak"]))
        self._cost_cache: dict[tuple[str, int], ExpNumber] = {}
        self._power_cache: dict[str, float] = {}
        self._power_log_cache: dict[str, float] = {}
        self._unit_power_cache: dict[str, ExpNumber] = {}
        self._enemy_power: ExpNumber | None = None
        self._enemy_domains: set[str] | None = None
        self._win_cache: dict[tuple, bool] = {}
        self.deadline: float | None = None
        self.simulations = 0
        self.templates_tested = 0
        self.seeds_tested = 0

    # -- costs -------------------------------------------------------------
    def unit_military_cost(self, unit_id: str, count: int) -> ExpNumber:
        if count <= 0:
            return ExpNumber.ZERO
        key = (unit_id, count)
        cached = self._cost_cache.get(key)
        if cached is not None:
            return cached
        params = self.cost_params.get(unit_id, [])
        value = military_cost(params, count)
        self._cost_cache[key] = value
        return value

    def composition_cost(self, composition: dict[str, int]) -> ExpNumber:
        total = ExpNumber.ZERO
        for unit_id, count in composition.items():
            if count > 0:
                total = total.add(self.unit_military_cost(unit_id, count))
        return total

    def all_costs(self, composition: dict[str, int]) -> list[dict]:
        totals: dict[str, ExpNumber] = {}
        for unit_id, count in composition.items():
            if count <= 0:
                continue
            for entry in calculate_cost_series(
                self.cost_params.get(unit_id, []), ExpNumber.ZERO, count
            ):
                resource = entry["resource"]
                totals[resource] = totals.get(resource, ExpNumber.ZERO).add(entry["base"])
        return [
            {"resource": resource, "base": value.serialize()}
            for resource, value in sorted(totals.items())
        ]

    # -- tactics -----------------------------------------------------------
    def _formation(self, preferred: str) -> str:
        if preferred in self.available_formations:
            return preferred
        if "standard" in self.available_formations:
            return "standard"
        return sorted(self.available_formations)[0] if self.available_formations else "standard"

    def _order(self, preferred: str) -> str:
        if preferred in self.available_orders:
            return preferred
        if "focus_weak" in self.available_orders:
            return "focus_weak"
        return sorted(self.available_orders)[0] if self.available_orders else "focus_weak"

    def template_functions(self) -> list[tuple[str, Callable[[str], tuple[str, str]]]]:
        def unit_traits(unit_id: str) -> tuple[set[str], float, list[str]]:
            unit = self.problem["units"].get(unit_id, {})
            stats = self.stats.get(unit_id, {})
            return (
                set(unit.get("tags", [])),
                float(stats.get("range", 0)),
                list(unit.get("bonusVs", [])),
            )

        def standard(unit_id: str) -> tuple[str, str]:
            return self._formation("standard"), self._order("focus_weak")

        def frontline(unit_id: str) -> tuple[str, str]:
            return self._formation("frontline"), self._order("focus_weak")

        def backline(unit_id: str) -> tuple[str, str]:
            return self._formation("backline"), self._order("focus_weak")

        def heuristic(unit_id: str) -> tuple[str, str]:
            tags, range_, bonus_vs = unit_traits(unit_id)
            formation = "standard"
            order = "focus_weak"
            if range_ > 1 or tags & {"ranged", "siege"}:
                formation = "backline"
                if "protect_ranged" in self.available_orders:
                    order = "protect_ranged"
            elif "cavalry" in tags:
                formation = "rush" if "rush" in self.available_formations else "frontline"
                if "focus_counter" in self.available_orders:
                    order = "focus_counter"
            elif "infantry" in tags:
                formation = "frontline"
            if bonus_vs and order == "focus_weak" and "focus_counter" in self.available_orders:
                order = "focus_counter"
            return self._formation(formation), self._order(order)

        def protect(unit_id: str) -> tuple[str, str]:
            formation, _ = heuristic(unit_id)
            return formation, self._order("protect_ranged")

        def counter(unit_id: str) -> tuple[str, str]:
            _, _, bonus_vs = unit_traits(unit_id)
            return self._formation("standard"), self._order(
                "focus_counter" if bonus_vs else "focus_weak"
            )

        def strong(unit_id: str) -> tuple[str, str]:
            return self._formation("standard"), self._order("focus_strong")

        templates = [
            ("standard", standard),
            ("frontline", frontline),
            ("backline", backline),
            ("heuristic", heuristic),
            ("protect", protect),
            ("counter", counter),
            ("strong", strong),
        ]
        seen = set()
        unique = []
        for name, function in templates:
            probe = tuple(function(unit_id) for unit_id in self.candidate_ids[:3])
            if probe in seen:
                continue
            seen.add(probe)
            unique.append((name, function))
        return unique

    def tactics_for(self, function: Callable[[str], tuple[str, str]], unit_ids) -> tuple[dict, dict]:
        formations: dict[str, str] = {}
        orders: dict[str, str] = {}
        for unit_id in unit_ids:
            formation, order = function(unit_id)
            formations[unit_id] = formation
            orders[unit_id] = order
        return formations, orders

    # -- simulation --------------------------------------------------------
    def player_stacks(self, composition: dict[str, int], tactics: tuple[dict, dict]) -> list[dict]:
        formations, orders = tactics
        stacks = []
        for unit_id, count in sorted(composition.items()):
            if count <= 0 or unit_id not in self.stats:
                continue
            stack = {
                "unitId": unit_id,
                "count": _serialize_count(count),
                "stats": self.stats[unit_id],
            }
            formation = formations.get(unit_id)
            order = orders.get(unit_id)
            if formation:
                stack["formation"] = formation
            if order:
                stack["order"] = order
            stacks.append(stack)
        return stacks

    def simulate(self, composition: dict[str, int], tactics: tuple[dict, dict]) -> dict:
        self.simulations += 1
        return simulate_battle_summary(
            self.problem,
            self.player_stacks(composition, tactics),
            self.enemy_stacks,
            self.max_rounds,
        )

    def wins(self, composition: dict[str, int], tactics: tuple[dict, dict]) -> bool:
        key = (
            tuple(sorted((unit, count) for unit, count in composition.items() if count > 0)),
            tuple(sorted(tactics[0].items())),
            tuple(sorted(tactics[1].items())),
        )
        if self.deadline is not None and time.time() > self.deadline:
            return False
        cached = self._win_cache.get(key)
        if cached is not None:
            return cached
        result = self.simulate(composition, tactics)["outcome"] == "player"
        self._win_cache[key] = result
        return result

    # -- search ------------------------------------------------------------
    @staticmethod
    def _power_from_stats(stats: dict) -> ExpNumber:
        hp = ExpNumber.from_serialized(stats["hp"])
        attack = ExpNumber.from_serialized(stats["attack"])
        armor = min(float(stats.get("armor", 0)), 0.9)
        accuracy = max(0.0, float(stats.get("accuracy", 0)))
        effective_hp = hp.div(ExpNumber.ONE.sub(ExpNumber.from_number(armor)))
        return attack.mul(ExpNumber.from_number(accuracy)).mul(effective_hp.pow(0.5))

    def unit_power(self, unit_id: str) -> ExpNumber:
        cached = self._unit_power_cache.get(unit_id)
        if cached is not None:
            return cached
        stats = self.stats.get(unit_id)
        value = self._power_from_stats(stats) if stats else ExpNumber.ZERO
        self._unit_power_cache[unit_id] = value
        return value

    def power_log(self, unit_id: str) -> float:
        cached = self._power_log_cache.get(unit_id)
        if cached is not None:
            return cached
        power = self.unit_power(unit_id)
        value = power.log10() if not power.is_zero else -math.inf
        self._power_log_cache[unit_id] = value
        return value

    def enemy_power(self) -> ExpNumber:
        if self._enemy_power is None:
            total = ExpNumber.ZERO
            for stack in self.enemy_stacks:
                count = ExpNumber.from_serialized(stack["count"])
                total = total.add(self._power_from_stats(stack["stats"]).mul(count))
            self._enemy_power = total
        return self._enemy_power

    def enemy_domains(self) -> set[str]:
        if self._enemy_domains is None:
            self._enemy_domains = {
                str(self.problem["units"].get(stack["unitId"], {}).get("domain", ""))
                for stack in self.enemy_stacks
            }
            self._enemy_domains.discard("")
        return self._enemy_domains

    def unit_can_hit_domain(self, unit_id: str, domain: str) -> bool:
        unit = self.problem["units"].get(unit_id, {})
        stats = self.stats.get(unit_id, {})
        if domain not in unit.get("canHit", []):
            return False
        range_ = float(stats.get("range", 0))
        if domain == "air" and range_ <= 1:
            return False
        if unit.get("domain") == "ground" and domain == "naval" and range_ <= 3:
            return False
        return True

    def can_cover(self, unit_ids) -> bool:
        units = [unit_id for unit_id in unit_ids if unit_id in self.stats]
        return all(
            any(self.unit_can_hit_domain(unit_id, domain) for unit_id in units)
            for domain in self.enemy_domains()
        )

    def estimate_count(self, unit_id: str, share: float = 1.0, safety: float = 1.0) -> int:
        power = self.unit_power(unit_id)
        if power.is_zero:
            return MAX_COUNT
        ratio = self.enemy_power().mul(ExpNumber.from_number(max(0.0, share * safety))).div(power)
        value = ratio.to_number()
        if not math.isfinite(value) or value >= MAX_COUNT:
            return MAX_COUNT
        return max(1, int(value))

    def efficiency(self, unit_id: str) -> float:
        cached = self._power_cache.get(unit_id)
        if cached is not None:
            return cached
        params = self.cost_params.get(unit_id, [])
        power_log = self.power_log(unit_id)
        if power_log == -math.inf:
            self._power_cache[unit_id] = -math.inf
            return -math.inf
        cost = self.unit_military_cost(unit_id, 1)
        cost_log = cost.log10() if not cost.is_zero else 300.0
        value = power_log - cost_log
        self._power_cache[unit_id] = value
        return value

    def min_count_for(self, make_composition: Callable[[int], dict[str, int]], tactics, cap: int = MAX_COUNT) -> int | None:
        if self.wins(make_composition(0), tactics):
            return 0
        n = 1
        last_fail = 0
        while n < cap:
            if self.wins(make_composition(n), tactics):
                break
            last_fail = n
            n = min(n * 2, cap)
        else:
            n = cap
        if n >= cap and not self.wins(make_composition(cap), tactics):
            return None
        low = last_fail
        high = n if n < cap else cap
        if not self.wins(make_composition(high), tactics):
            return None
        while low + 1 < high:
            mid = (low + high) // 2
            if self.wins(make_composition(mid), tactics):
                high = mid
            else:
                low = mid
        return high

    def ensure_winning(self, composition: dict[str, int], tactics) -> dict[str, int] | None:
        comp = {unit: count for unit, count in composition.items() if count > 0}
        if not comp:
            return None
        for _ in range(48):
            if self.wins(comp, tactics):
                return comp
            comp = {
                unit: min(MAX_COUNT, max(1, int(count * 2)))
                for unit, count in comp.items()
            }
        return comp if self.wins(comp, tactics) else None

    def minimize_unit_count(self, composition: dict[str, int], unit_id: str, tactics) -> int:
        current = composition.get(unit_id, 0)
        if current <= 0:
            return 0

        def with_count(n: int) -> dict[str, int]:
            comp = dict(composition)
            if n <= 0:
                comp.pop(unit_id, None)
            else:
                comp[unit_id] = n
            return comp

        if self.wins(with_count(0), tactics):
            return 0
        low = 0
        high = current
        if not self.wins(with_count(high), tactics):
            return current
        while low + 1 < high:
            mid = (low + high) // 2
            if self.wins(with_count(mid), tactics):
                high = mid
            else:
                low = mid
        return high

    def reduce_all(self, composition: dict[str, int], tactics, passes: int = 3) -> dict[str, int]:
        comp = {unit: count for unit, count in composition.items() if count > 0}
        for _ in range(passes):
            changed = False
            for unit_id in list(comp.keys()):
                minimal = self.minimize_unit_count(comp, unit_id, tactics)
                if minimal != comp.get(unit_id, 0):
                    if minimal <= 0:
                        comp.pop(unit_id, None)
                    else:
                        comp[unit_id] = minimal
                    changed = True
            if not changed:
                break
        return comp

    def polish(self, composition: dict[str, int], template) -> tuple[dict[str, int], ExpNumber] | None:
        comp = {unit: count for unit, count in composition.items() if count > 0}
        if not comp:
            return None
        tactics = self.tactics_for(template, comp.keys())
        comp = self.ensure_winning(comp, tactics)
        if comp is None:
            return None
        comp = self.reduce_all(comp, tactics)
        tactics = self.tactics_for(template, comp.keys())
        best_cost = self.composition_cost(comp)

        inactive_limit = 6
        inactive = sorted(
            (unit for unit in self.candidate_ids if unit not in comp),
            key=lambda unit: self.efficiency(unit),
            reverse=True,
        )[:inactive_limit]

        for _ in range(4):
            improved = False
            # Try removing a unit type entirely.
            for unit_id in list(comp.keys()):
                trial = {unit: count for unit, count in comp.items() if unit != unit_id}
                if not trial:
                    continue
                trial_tactics = self.tactics_for(template, trial.keys())
                trial = self.ensure_winning(trial, trial_tactics)
                if trial is None:
                    continue
                trial = self.reduce_all(trial, trial_tactics, passes=2)
                trial_cost = self.composition_cost(trial)
                if trial_cost.lt(best_cost) and self.wins(trial, trial_tactics):
                    comp, best_cost, tactics = trial, trial_cost, trial_tactics
                    improved = True
                    break
            if improved:
                continue

            # Try introducing one efficient inactive unit.
            for unit_id in inactive:
                if unit_id in comp:
                    continue
                trial = dict(comp)
                total = sum(trial.values())
                trial[unit_id] = max(1, total // max(1, len(trial) + 1))
                trial_tactics = self.tactics_for(template, trial.keys())
                trial = self.ensure_winning(trial, trial_tactics)
                if trial is None:
                    continue
                trial = self.reduce_all(trial, trial_tactics, passes=2)
                trial_cost = self.composition_cost(trial)
                if trial_cost.lt(best_cost) and self.wins(trial, trial_tactics):
                    comp, best_cost, tactics = trial, trial_cost, trial_tactics
                    inactive = [unit for unit in inactive if unit != unit_id]
                    improved = True
                    break
            if not improved:
                break
        return comp, best_cost

    def seed_compositions(self, template, single_counts: dict[str, int]) -> list[dict[str, int]]:
        seeds: list[dict[str, int]] = []
        for unit_id, count in single_counts.items():
            if count:
                seeds.append({unit_id: count})

        ranked = sorted(self.candidate_ids, key=lambda unit: self.efficiency(unit), reverse=True)
        top = ranked[: min(6, len(ranked))]
        counts = {unit: single_counts.get(unit) for unit in top}
        present = [unit for unit in top if counts.get(unit)]

        for index, left in enumerate(present):
            for right in present[index + 1 :]:
                ci, cj = counts[left], counts[right]
                for alpha in (0.25, 0.5, 0.75):
                    seeds.append(
                        {
                            left: max(1, int(ci * alpha * 2)),
                            right: max(1, int(cj * (1 - alpha) * 2)),
                        }
                    )
                seeds.append({left: ci, right: cj})

        if len(present) >= 3:
            for combo in _combinations(present[:4], 3):
                seeds.append({unit: max(1, counts[unit] // 3) for unit in combo})
        if len(present) >= 2:
            seeds.append({unit: max(1, counts[unit] // 2) for unit in present[:4]})

        if single_counts:
            return seeds

        pool: list[str] = []
        for unit_id in sorted(self.candidate_ids, key=self.power_log, reverse=True)[:8]:
            if unit_id not in pool:
                pool.append(unit_id)
        for unit_id in sorted(self.candidate_ids, key=self.efficiency, reverse=True)[:6]:
            if unit_id not in pool:
                pool.append(unit_id)

        pairs: list[tuple[float, str, str]] = []
        for index, left in enumerate(pool):
            for right in pool[index + 1 :]:
                if not self.can_cover((left, right)):
                    continue
                score = self.power_log(left) + self.power_log(right) + 0.25 * (
                    self.efficiency(left) + self.efficiency(right)
                )
                pairs.append((score, left, right))
        pairs.sort(key=lambda item: item[0], reverse=True)
        for _, left, right in pairs[:10]:
            for share in (0.5, 0.7, 0.3):
                seeds.append(
                    {
                        left: self.estimate_count(left, share, 3.0),
                        right: self.estimate_count(right, 1.0 - share, 3.0),
                    }
                )

        triples: list[tuple[float, tuple[str, ...]]] = []
        for combo in _combinations(pool, 3):
            if not self.can_cover(combo):
                continue
            score = sum(self.power_log(unit_id) for unit_id in combo)
            triples.append((score, tuple(combo)))
        triples.sort(key=lambda item: item[0], reverse=True)
        for _, combo in triples[:3]:
            seeds.append(
                {
                    unit_id: self.estimate_count(unit_id, 1.0 / len(combo), 3.0)
                    for unit_id in combo
                }
            )
        return seeds

    def solve(self, time_budget: float = 30.0) -> dict:
        self.deadline = time.time() + time_budget
        deadline = self.deadline
        best: tuple[dict[str, int], tuple[dict, dict], ExpNumber] | None = None
        templates = self.template_functions()

        for template_index, (template_name, template) in enumerate(templates):
            if time.time() > deadline:
                break
            self.templates_tested += 1
            single_counts: dict[str, int] = {}
            for unit_id in self.candidate_ids:
                if time.time() > deadline:
                    break
                if not self.can_cover([unit_id]):
                    continue
                tactics = self.tactics_for(template, [unit_id])
                count = self.min_count_for(lambda n, unit=unit_id: {unit: n}, tactics)
                if count:
                    single_counts[unit_id] = count

            seeds = self.seed_compositions(template, single_counts)
            seed_results: list[tuple[ExpNumber, dict[str, int], tuple[dict, dict]]] = []
            for seed in seeds:
                if time.time() > deadline:
                    break
                if not self.can_cover(seed):
                    continue
                self.seeds_tested += 1
                tactics = self.tactics_for(template, seed.keys())
                comp = self.ensure_winning(seed, tactics)
                if comp is None or not self.wins(comp, tactics):
                    continue
                comp = self.reduce_all(comp, tactics, passes=2)
                tactics = self.tactics_for(template, comp.keys())
                cost = self.composition_cost(comp)
                seed_results.append((cost, comp, tactics))
            seed_results.sort(key=lambda item: item[0].to_number())

            for _, seed_comp, _ in seed_results[:6]:
                if time.time() > deadline:
                    break
                polished = self.polish(seed_comp, template)
                if polished is None:
                    continue
                comp, cost = polished
                tactics = self.tactics_for(template, comp.keys())
                if not self.wins(comp, tactics):
                    continue
                if best is None or cost.lt(best[2]):
                    best = (comp, tactics, cost)

        self.deadline = None
        if best is None:
            return {
                "proofStatus": "failed",
                "reason": "no winning composition found within the search budget",
                "searchStats": {
                    "simulations": self.simulations,
                    "templatesTested": self.templates_tested,
                    "seedsTested": self.seeds_tested,
                },
            }

        composition, tactics, military = best
        summary = self.simulate(composition, tactics)
        total_costs = self.all_costs(composition)
        return {
            "proofStatus": "best_found",
            "plan": {
                "composition": {unit: count for unit, count in sorted(composition.items())},
                "totalComposition": {unit: count for unit, count in sorted(composition.items())},
                "military": military.serialize(),
                "totalCost": total_costs,
                "research": {"ids": [], "costs": []},
                "formations": tactics[0],
                "orders": tactics[1],
                "battle": {
                    "outcome": summary["outcome"],
                    "playerSurvivors": summary["playerSurvivors"].serialize(),
                    "enemySurvivors": summary["enemySurvivors"].serialize(),
                },
            },
            "searchStats": {
                "simulations": self.simulations,
                "templatesTested": self.templates_tested,
                "seedsTested": self.seeds_tested,
            },
        }


def _combinations(items: list[str], size: int):
    if size == 0:
        yield []
        return
    if len(items) < size:
        return
    first, *rest = items
    for combo in _combinations(rest, size - 1):
        yield [first, *combo]
    yield from _combinations(rest, size)


def solve_problem(problem: dict, time_budget: float) -> dict:
    solver = ProblemSolver(problem)
    result = solver.solve(time_budget)
    return {
        "schemaVersion": 1,
        "fingerprint": problem["fingerprint"],
        "battleId": problem["battleId"],
        "researchHash": problem["source"].get("researchHash", ""),
        "researchIds": problem["researchIds"],
        **result,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Solve exported battle problems offline.")
    parser.add_argument("--input", default="sim-output/battle-problems/problems.jsonl")
    parser.add_argument("--output", default="sim-output/battle-plans/plans.jsonl")
    parser.add_argument("--battle")
    parser.add_argument("--research-hash")
    parser.add_argument("--time-budget", type=float, default=30.0)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args(argv)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    battles = {item for item in (args.battle or "").split(",") if item}
    research_hashes = {item for item in (args.research_hash or "").split(",") if item}
    written = 0
    with open(output, "w", encoding="utf-8") as handle:
        for problem in iter_problems(args.input):
            if battles and problem["battleId"] not in battles:
                continue
            if research_hashes and problem["source"].get("researchHash") not in research_hashes:
                continue
            result = solve_problem(problem, args.time_budget)
            handle.write(json.dumps(result, separators=(",", ":")) + "\n")
            handle.flush()
            written += 1
            status = result.get("proofStatus")
            military = result.get("plan", {}).get("military", {})
            print(f"{problem['battleId']} {problem['source'].get('researchHash', '')[:12]} -> {status} military={military}")
            if args.limit and written >= args.limit:
                break
    print(f"Wrote {written} plan(s) to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
