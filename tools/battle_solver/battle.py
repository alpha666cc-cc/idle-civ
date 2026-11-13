"""Outcome-only port of src/game/battle.ts simulateBattleInternal.

The TypeScript engine is the source of truth. This module mirrors its fighter
construction, formation stat application, movement/engagement rules, targeting
orders, screening and matchup multipliers, but skips round-log allocation.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .expnumber import ExpNumber

BONUS_VS_MULTIPLIER = 1.5
SCREENING_SHARE = 0.25
MAXIMUM_ROUNDS = 101
DEFAULT_FORMATION = "standard"
DEFAULT_ORDER = "focus_weak"


@dataclass
class Fighter:
    unit_id: str
    side: str
    stats: dict[str, Any]
    domain: str
    can_hit: list[str]
    bonus_vs: list[str]
    tags: list[str]
    hit_points: ExpNumber
    initial_count: ExpNumber
    hp_pool: ExpNumber
    initial_hp_pool: ExpNumber
    order: str
    target_domain: str | None
    target_tag: str | None
    formation: str
    attack_advance: int = 0


def _exp(value) -> ExpNumber:
    return value if isinstance(value, ExpNumber) else ExpNumber.from_serialized(value)


def _stats_from_serialized(raw: dict) -> dict[str, Any]:
    return {
        "hp": ExpNumber.from_serialized(raw["hp"]),
        "attack": ExpNumber.from_serialized(raw["attack"]),
        "armor": float(raw["armor"]),
        "range": float(raw["range"]),
        "speed": float(raw["speed"]),
        "accuracy": float(raw["accuracy"]),
    }


def _formation(problem: dict, formation_id: str | None) -> dict:
    return problem.get("formations", {}).get(formation_id or DEFAULT_FORMATION, {})


def _apply_bonus_number(value: float, bonus: dict | None) -> float:
    if not bonus:
        return value
    if "multiplier" in bonus:
        return value * float(bonus["multiplier"])
    if "additive" in bonus:
        return value + float(bonus["additive"])
    return value


def _apply_bonus_exp(value: ExpNumber, bonus: dict | None) -> ExpNumber:
    if not bonus:
        return value
    if "multiplier" in bonus:
        return value.mul(ExpNumber.from_number(float(bonus["multiplier"])))
    if "additive" in bonus:
        return value.add(ExpNumber.from_number(float(bonus["additive"])))
    return value


def effective_battle_stats(stats: dict[str, Any], formation_id: str, problem: dict) -> dict[str, Any]:
    formation = _formation(problem, formation_id)
    bonuses = formation.get("statBonuses") or []
    if not bonuses:
        return stats
    bonus_map = {bonus["attribute"]: bonus for bonus in bonuses}
    new_stats = dict(stats)
    new_stats["hp"] = _apply_bonus_exp(stats["hp"], bonus_map.get("unitAll.hp"))
    new_stats["attack"] = _apply_bonus_exp(stats["attack"], bonus_map.get("unitAll.attack"))
    new_stats["accuracy"] = _apply_bonus_number(stats["accuracy"], bonus_map.get("unitAll.accuracy"))
    new_stats["range"] = _apply_bonus_number(stats["range"], bonus_map.get("unitAll.range"))
    cavalry_bonus = bonus_map.get("tag.cavalry.attack")
    if cavalry_bonus:
        new_stats["attack"] = _apply_bonus_exp(new_stats["attack"], cavalry_bonus)
    ranged_bonus = bonus_map.get("tag.ranged.attack")
    if ranged_bonus:
        new_stats["attack"] = _apply_bonus_exp(new_stats["attack"], ranged_bonus)
    return new_stats


def build_fighters(problem: dict, stacks: list[dict], side: str) -> list[Fighter]:
    units = problem["units"]
    ordered = sorted(stacks, key=lambda stack: stack["unitId"])
    fighters: list[Fighter] = []
    for stack in ordered:
        unit_id = stack["unitId"]
        definition = units.get(unit_id)
        count = _exp(stack["count"])
        if definition is None or count.lte(ExpNumber.ZERO):
            continue
        formation = stack.get("formation") or DEFAULT_FORMATION
        stats = effective_battle_stats(_stats_from_serialized(stack["stats"]), formation, problem)
        hit_points = stats["hp"].div(
            ExpNumber.ONE.sub(ExpNumber.from_number(min(stats["armor"], 0.9)))
        )
        fighters.append(
            Fighter(
                unit_id=unit_id,
                side=side,
                stats=stats,
                domain=definition["domain"],
                can_hit=list(definition["canHit"]),
                bonus_vs=list(definition["bonusVs"]),
                tags=list(definition["tags"]),
                hit_points=hit_points,
                initial_count=count,
                hp_pool=hit_points.mul(count),
                initial_hp_pool=hit_points.mul(count),
                order=stack.get("order") or DEFAULT_ORDER,
                target_domain=stack.get("targetDomain"),
                target_tag=stack.get("targetTag"),
                formation=formation,
            )
        )
    return fighters


def living_count(fighter: Fighter) -> ExpNumber:
    if fighter.hp_pool.lte(ExpNumber.ZERO):
        return ExpNumber.ZERO
    return ExpNumber.min(
        fighter.initial_count,
        fighter.hp_pool.div(fighter.hit_points).ceil(),
    )


def effective_position(fighter: Fighter, army_position: int, problem: dict) -> float:
    offset = float(_formation(problem, fighter.formation).get("positionOffset", 0))
    return army_position + (-offset if fighter.side == "player" else offset)


def army_front_position(fighters: list[Fighter], army_position: int, problem: dict) -> float:
    positions = [
        effective_position(fighter, army_position, problem)
        for fighter in fighters
        if fighter.hp_pool.gt(ExpNumber.ZERO)
    ]
    if not positions:
        return army_position
    if fighters[0].side == "player":
        return max(positions)
    return min(positions)


def can_attack_domain(attacker: Fighter, target: Fighter) -> bool:
    if target.domain not in attacker.can_hit:
        return False
    if target.domain == "air" and attacker.stats["range"] <= 1:
        return False
    if attacker.domain == "ground" and target.domain == "naval" and attacker.stats["range"] <= 3:
        return False
    return True


def can_reach(
    attacker: Fighter,
    target: Fighter,
    player_position: int,
    enemy_position: int,
    problem: dict,
    attack_advance: int = 0,
    extra_range: float = 0,
) -> bool:
    if not can_attack_domain(attacker, target):
        return False
    attacker_pos = effective_position(
        attacker,
        player_position if attacker.side == "player" else enemy_position,
        problem,
    )
    target_pos = effective_position(
        target,
        player_position if target.side == "player" else enemy_position,
        problem,
    )
    attack_position = attacker_pos + (
        attack_advance if attacker.side == "player" else -attack_advance
    )
    return abs(attack_position - target_pos) <= attacker.stats["range"] + extra_range


def matchup_multiplier(attacker: Fighter, target: Fighter, problem: dict) -> float:
    multiplier = 1.0
    attacker_formation = _formation(problem, attacker.formation)
    for rule in attacker_formation.get("damageDealtVs", []):
        if rule["tag"] in target.tags:
            multiplier *= float(rule["multiplier"])
    target_formation = _formation(problem, target.formation)
    for rule in target_formation.get("damageTakenVs", []):
        if rule["tag"] in attacker.tags:
            multiplier *= float(rule["multiplier"])
    if any(tag in target.tags for tag in attacker.bonus_vs):
        multiplier *= BONUS_VS_MULTIPLIER
    if attacker.domain == "air" and target.domain == "naval":
        multiplier *= 1.2
    if attacker.domain == "naval" and target.domain == "ground":
        multiplier *= attacker.stats["range"] / 10
    if target.domain == "air" and attacker.stats["range"] <= 1:
        multiplier *= 0.3
    return multiplier


def weakest_first(foes: list[Fighter]) -> Fighter:
    weakest = foes[0]
    for foe in foes[1:]:
        if foe.hp_pool.lt(weakest.hp_pool):
            weakest = foe
    return weakest


def counter_targets(attacker: Fighter, foes: list[Fighter]) -> list[Fighter]:
    return [foe for foe in foes if any(tag in foe.tags for tag in attacker.bonus_vs)]


def pick_target_by_order(attacker: Fighter, foes: list[Fighter]) -> Fighter:
    if attacker.target_domain:
        domain_targets = [foe for foe in foes if foe.domain == attacker.target_domain]
        if domain_targets:
            return weakest_first(domain_targets)
    if attacker.target_tag:
        tag_targets = [foe for foe in foes if attacker.target_tag in foe.tags]
        if tag_targets:
            return weakest_first(tag_targets)

    if attacker.order == "focus_counter":
        counters = counter_targets(attacker, foes)
        return weakest_first(counters) if counters else weakest_first(foes)
    if attacker.order == "focus_strong":
        strongest = foes[0]
        for foe in foes[1:]:
            if foe.hp_pool.gt(strongest.hp_pool):
                strongest = foe
        return strongest
    return weakest_first(foes)


def apply_screening(
    target: Fighter,
    damage: ExpNumber,
    target_allies: list[Fighter],
    attacker: Fighter,
    problem: dict,
) -> ExpNumber:
    protected_target = any(tag in ("ranged", "siege") for tag in target.tags)
    living_allies = [
        ally
        for ally in target_allies
        if ally.unit_id != target.unit_id and living_count(ally).gt(ExpNumber.ZERO)
    ]
    normal_screens = (
        [
            ally
            for ally in living_allies
            if ally.domain == "ground" and "infantry" in ally.tags
        ]
        if protected_target
        else []
    )
    protect_screens = [ally for ally in living_allies if ally.order == "protect_ranged"]

    screen_shares: dict[int, tuple[Fighter, float]] = {}

    def add_screen_pool(screens: list[Fighter]) -> None:
        if not screens:
            return
        share_per_screen = SCREENING_SHARE / len(screens)
        for screen in screens:
            key = id(screen)
            if key in screen_shares:
                fighter, share = screen_shares[key]
                screen_shares[key] = (fighter, share + share_per_screen)
            else:
                screen_shares[key] = (screen, share_per_screen)

    add_screen_pool(normal_screens)
    add_screen_pool(protect_screens)
    total_share = sum(share for _, share in screen_shares.values())
    if total_share == 0:
        return damage

    capped_share = min(0.5, total_share)
    shared = damage.mul(ExpNumber.from_number(capped_share))
    for fighter, share in screen_shares.values():
        allocated_share = capped_share * (share / total_share)
        screen_multiplier = matchup_multiplier(attacker, fighter, problem)
        reduced = damage.mul(ExpNumber.from_number(allocated_share)).mul(
            ExpNumber.from_number(screen_multiplier)
        )
        fighter.hp_pool = ExpNumber.max(ExpNumber.ZERO, fighter.hp_pool.sub(reduced))
    return damage.sub(shared)


def has_living(fighters: list[Fighter]) -> bool:
    return any(fighter.hp_pool.gt(ExpNumber.ZERO) for fighter in fighters)


def total_living(fighters: list[Fighter]) -> ExpNumber:
    total = ExpNumber.ZERO
    for fighter in fighters:
        total = total.add(living_count(fighter))
    return total


def simulate_battle_summary(
    problem: dict,
    player_stacks: list[dict],
    enemy_stacks: list[dict],
    max_rounds: int = MAXIMUM_ROUNDS,
) -> dict[str, Any]:
    player = build_fighters(problem, player_stacks, "player")
    enemy = build_fighters(problem, enemy_stacks, "enemy")
    all_fighters = player + enemy
    maximum_range = max([0.0] + [fighter.stats["range"] for fighter in all_fighters])
    starting_gap = math.ceil(maximum_range) + 1
    player_front_offset = army_front_position(player, 0, problem)
    enemy_front_offset = army_front_position(enemy, 0, problem)
    player_position = -math.floor(starting_gap / 2) - player_front_offset
    enemy_position = math.ceil(starting_gap / 2) - enemy_front_offset
    order = sorted(all_fighters, key=lambda fighter: -fighter.stats["speed"])

    round_number = 0
    while round_number < max_rounds and has_living(player) and has_living(enemy):
        round_number += 1
        front_gap = army_front_position(enemy, enemy_position, problem) - army_front_position(
            player, player_position, problem
        )
        if front_gap > 1:
            player_position += 1
            enemy_position -= 1
        engaged = (
            abs(
                army_front_position(enemy, enemy_position, problem)
                - army_front_position(player, player_position, problem)
            )
            <= 1
        )

        for attacker in order:
            attackers = living_count(attacker)
            if attackers.lte(ExpNumber.ZERO):
                continue
            enemy_forces = enemy if attacker.side == "player" else player
            living_foes = [fighter for fighter in enemy_forces if fighter.hp_pool.gt(ExpNumber.ZERO)]

            def position_of(fighter: Fighter) -> float:
                return effective_position(
                    fighter,
                    player_position if fighter.side == "player" else enemy_position,
                    problem,
                )

            attacker_position = position_of(attacker)
            own_forces = player if attacker.side == "player" else enemy
            own_army_position = player_position if attacker.side == "player" else enemy_position
            own_front_position = army_front_position(own_forces, own_army_position, problem)
            distance_to_front = (
                own_front_position - attacker_position
                if attacker.side == "player"
                else attacker_position - own_front_position
            )
            if engaged and attacker.attack_advance < distance_to_front:
                attacker.attack_advance += 1
            has_reached_front = attacker.attack_advance >= distance_to_front

            def reachable_foes(extra_range: float) -> list[Fighter]:
                return [
                    fighter
                    for fighter in living_foes
                    if can_reach(
                        attacker,
                        fighter,
                        player_position,
                        enemy_position,
                        problem,
                        attacker.attack_advance,
                        extra_range,
                    )
                ]

            extra_range = 0
            foes = reachable_foes(extra_range)
            while (
                not foes
                and engaged
                and has_reached_front
                and any(can_attack_domain(attacker, fighter) for fighter in living_foes)
            ):
                extra_range += 1
                foes = reachable_foes(extra_range)
            if not foes:
                continue

            melee = attacker.stats["range"] <= 1
            if melee:
                eligible = sorted(
                    [foe for foe in foes if foe.domain in attacker.can_hit],
                    key=lambda foe: abs(position_of(foe) - attacker_position),
                )[:1]
            else:
                eligible = foes
            if not eligible:
                continue

            target = pick_target_by_order(attacker, eligible)
            attacker_pos = attacker_position
            target_pos = position_of(target)
            attack_position = attacker_pos + (
                attacker.attack_advance if attacker.side == "player" else -attacker.attack_advance
            )
            distance = abs(attack_position - target_pos)
            hit_chance = max(
                0.05,
                min(
                    1.0,
                    attacker.stats["accuracy"]
                    * (1 - min(1.0, distance / max(1.0, attacker.stats["range"])) * 0.3),
                ),
            )
            target_allies = enemy if attacker.side == "player" else player
            attack_order_multiplier = 0.75 if attacker.order == "protect_ranged" else 1.0
            intended_damage = attackers.mul(attacker.stats["attack"]).mul(
                ExpNumber.from_number(hit_chance * attack_order_multiplier)
            )
            damage = apply_screening(target, intended_damage, target_allies, attacker, problem)
            target_damage = damage.mul(
                ExpNumber.from_number(matchup_multiplier(attacker, target, problem))
            )
            target.hp_pool = ExpNumber.max(ExpNumber.ZERO, target.hp_pool.sub(target_damage))

    player_survivors = total_living(player)
    enemy_survivors = total_living(enemy)
    player_holds = has_living(player)
    enemy_holds = has_living(enemy)
    if enemy_holds and not player_holds:
        outcome = "enemy"
    elif player_holds and not enemy_holds:
        outcome = "player"
    else:
        outcome = "stalemate"
    return {
        "outcome": outcome,
        "playerSurvivors": player_survivors,
        "enemySurvivors": enemy_survivors,
    }
