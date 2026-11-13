"""Port of src/game/buyableCost.ts calculateCostSeries."""
from __future__ import annotations

import math
from typing import Union

from .expnumber import ExpNumber

NumberLike = Union[int, float, ExpNumber]

maximum_unit_purchase = 1_000_000
flat_clamp_window = 256


def _exp(value) -> ExpNumber:
    if isinstance(value, ExpNumber):
        return value
    if isinstance(value, dict):
        return ExpNumber.from_serialized(value)
    return ExpNumber.from_number(value)


def _linear_slope(unit_base: ExpNumber, unit_factor: ExpNumber) -> ExpNumber:
    return unit_base.mul(unit_factor).div(ExpNumber.from_number(25))


def _exponent_curve(
    unit_base: ExpNumber,
    unit_factor: ExpNumber,
    n: NumberLike,
    exponent: float,
) -> ExpNumber:
    if isinstance(n, ExpNumber):
        factor_power = n.pow(exponent).sub(ExpNumber.ONE)
    else:
        factor_power = ExpNumber.from_number(math.pow(float(n), exponent) - 1)
    return unit_base.mul(unit_factor.pow(factor_power))


def _crossover_to_exponent_curve(
    unit_base: ExpNumber,
    unit_factor: ExpNumber,
    exponent: float,
) -> int:
    slope = _linear_slope(unit_base, unit_factor)

    def linear(k: int) -> ExpNumber:
        return unit_base.add(slope.mul(ExpNumber.from_number(k - 1)))

    def curve_price(k: int) -> ExpNumber:
        return _exponent_curve(unit_base, unit_factor, k, exponent).sub(
            _exponent_curve(unit_base, unit_factor, k - 1, exponent)
        )

    def stays_on_linear_floor(k: int) -> bool:
        return curve_price(k).lte(linear(k))

    low = 0
    high = 1
    while high < maximum_unit_purchase and stays_on_linear_floor(high):
        low = high
        high = min(high * 2, maximum_unit_purchase)
    if high == maximum_unit_purchase and stays_on_linear_floor(high):
        return maximum_unit_purchase - 1

    while low + 1 < high:
        middle = (low + high) // 2
        if stays_on_linear_floor(middle):
            low = middle
        else:
            high = middle
    return low


def calculate_cost_series(
    parameters: list[dict],
    already_built: ExpNumber,
    count: NumberLike,
) -> list[dict]:
    """Return [{resource, base: ExpNumber}] for `count` additional units."""
    owned = already_built
    if isinstance(count, ExpNumber):
        requested = ExpNumber.max(ExpNumber.ZERO, count)
    else:
        requested = ExpNumber.max(ExpNumber.ZERO, ExpNumber.from_number(count))

    result = []
    for param in parameters:
        resource = param["resource"]
        unit_base = _exp(param["unitBase"])
        unit_factor = _exp(param["unitFactor"])
        reductions = {key: _exp(value) for key, value in param["reductions"].items()}
        exponent = float(param["exponent"])
        if not requested.gt(ExpNumber.ZERO):
            result.append({"resource": resource, "base": ExpNumber.ZERO})
            continue

        crossover = _crossover_to_exponent_curve(unit_base, unit_factor, exponent)
        crossover_number = ExpNumber.from_number(crossover)
        slope = _linear_slope(unit_base, unit_factor)

        def linear_sum(n: int) -> ExpNumber:
            return unit_base.mul(ExpNumber.from_number(n)).add(
                slope.mul(ExpNumber.from_number((n * (n - 1)) / 2))
            )

        def cumulative(n: ExpNumber) -> ExpNumber:
            if n.lte(crossover_number):
                return linear_sum(int(n.to_number()))
            return linear_sum(crossover).add(
                _exponent_curve(unit_base, unit_factor, n, exponent).sub(
                    _exponent_curve(unit_base, unit_factor, crossover_number, exponent)
                )
            )

        def unit_price(n: ExpNumber) -> ExpNumber:
            return (
                cumulative(n).sub(cumulative(n.sub(ExpNumber.ONE)))
                .mul(reductions["percent"])
            )

        clamped = 0
        if reductions["flat"].gt(ExpNumber.ZERO):
            while clamped < flat_clamp_window and ExpNumber.from_number(clamped).lt(requested):
                if unit_price(owned.add(ExpNumber.from_number(clamped + 1))).gt(
                    reductions["flat"]
                ):
                    break
                clamped += 1

        clamped_count = ExpNumber.from_number(clamped)
        remaining = requested.sub(clamped_count)
        gross = cumulative(owned.add(requested)).sub(
            cumulative(owned.add(clamped_count))
        ).mul(reductions["percent"])
        payable = ExpNumber.max(
            ExpNumber.ZERO,
            gross.sub(reductions["flat"].mul(remaining)),
        )
        floored = payable.floor()
        tolerance = ExpNumber.max(payable, ExpNumber.ONE).mul(ExpNumber.from_number(1e-9))
        snapped = floored if payable.sub(floored).lte(tolerance) else payable
        result.append({"resource": resource, "base": snapped.ceil()})
    return result


def military_cost(parameters: list[dict], count: int) -> ExpNumber:
    total = ExpNumber.ZERO
    for entry in calculate_cost_series(parameters, ExpNumber.ZERO, count):
        if entry["resource"] == "military":
            total = total.add(entry["base"])
    return total
