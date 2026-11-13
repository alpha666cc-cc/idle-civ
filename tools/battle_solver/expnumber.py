"""Faithful Python port of src/game/expNumber.ts.

ExpNumber stores sign * mantissa * 10**exponent with mantissa in [1, 10).
Keep the arithmetic bit-for-bit aligned with the TypeScript implementation:
the battle solver compares outcomes against the TS engine, so shortcuts that
change rounding or cancellation behaviour are not acceptable here.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import ClassVar, Union

NumberLike = Union["ExpNumber", int, float, str]


def _pow10(exponent: float) -> float:
    try:
        return 10.0 ** exponent
    except OverflowError:
        return math.inf


def _js_round(value: float) -> float:
    # Math.round rounds half toward +Infinity; floor(x + 0.5) matches that for
    # the finite values ExpNumber.snap can produce.
    return math.floor(value + 0.5)


@dataclass(frozen=True)
class ExpNumber:
    sign: int
    mantissa: float
    exponent: float

    ZERO: ClassVar["ExpNumber"]
    ONE: ClassVar["ExpNumber"]
    TEN: ClassVar["ExpNumber"]
    INFINITY: ClassVar["ExpNumber"]
    NEGATIVE_INFINITY: ClassVar["ExpNumber"]
    NAN: ClassVar["ExpNumber"]

    @staticmethod
    def _make(sign: int, mantissa: float, exponent: float) -> "ExpNumber":
        return ExpNumber(sign, mantissa, exponent)

    @staticmethod
    def zero() -> "ExpNumber":
        return ExpNumber.ZERO

    @staticmethod
    def one() -> "ExpNumber":
        return ExpNumber.ONE

    @staticmethod
    def from_number(value: float | int) -> "ExpNumber":
        value = float(value)
        if math.isnan(value):
            return ExpNumber.NAN
        if math.isinf(value):
            return ExpNumber.INFINITY if value > 0 else ExpNumber.NEGATIVE_INFINITY
        if value == 0:
            return ExpNumber.ZERO
        sign = -1 if value < 0 else 1
        abs_value = abs(value)
        exponent = math.floor(math.log10(abs_value))
        return ExpNumber(sign, abs_value / _pow10(exponent), float(exponent))

    @staticmethod
    def from_serialized(value: dict) -> "ExpNumber":
        return ExpNumber(int(value["s"]), float(value["m"]), float(value["e"]))

    @staticmethod
    def from_log10(log10: float) -> "ExpNumber":
        if math.isnan(log10):
            return ExpNumber.NAN
        if math.isinf(log10):
            return ExpNumber.INFINITY if log10 > 0 else ExpNumber.ZERO
        exponent = math.floor(log10)
        mantissa = _pow10(log10 - exponent)
        return ExpNumber(1, mantissa, float(exponent))

    def serialize(self) -> dict:
        return {"s": self.sign, "m": self.mantissa, "e": self.exponent}

    def __str__(self) -> str:
        if math.isnan(self.mantissa):
            return "NaN"
        if not self.is_finite():
            return "Infinity" if self.sign >= 0 else "-Infinity"
        if self.is_zero:
            return "0"
        prefix = "-" if self.sign < 0 else ""
        return f"{prefix}{self.mantissa}e{self.exponent}"

    @property
    def is_zero(self) -> bool:
        return self.sign == 0

    @property
    def is_negative(self) -> bool:
        return self.sign < 0

    def is_finite(self) -> bool:
        return (
            self.sign != 0
            and math.isfinite(self.mantissa)
            and math.isfinite(self.exponent)
        )

    def neg(self) -> "ExpNumber":
        if self.is_zero:
            return self
        return ExpNumber(-self.sign, self.mantissa, self.exponent)

    def abs(self) -> "ExpNumber":
        if self.sign < 0:
            return ExpNumber(1, self.mantissa, self.exponent)
        return self

    def log10(self) -> float:
        if self.is_zero:
            return -math.inf
        if self.exponent == math.inf:
            return math.inf if self.sign > 0 else -math.inf
        return self.exponent + math.log10(self.mantissa)

    def to_number(self) -> float:
        if self.is_zero:
            return 0.0
        try:
            return self.sign * self.mantissa * _pow10(self.exponent)
        except OverflowError:
            return math.copysign(math.inf, self.sign * self.mantissa)

    @staticmethod
    def max(*values: "ExpNumber") -> "ExpNumber":
        result = ExpNumber.NEGATIVE_INFINITY
        for value in values:
            if value.gte(result):
                result = value
        return result

    @staticmethod
    def min(*values: "ExpNumber") -> "ExpNumber":
        result = ExpNumber.INFINITY
        for value in values:
            if value.lte(result):
                result = value
        return result

    def add(self, other: "ExpNumber") -> "ExpNumber":
        if self.is_zero:
            return other
        if other.is_zero:
            return self

        if not self.is_finite() or not other.is_finite():
            if math.isnan(self.mantissa) or math.isnan(other.mantissa):
                return ExpNumber.NAN
            this_inf = 0 if self.is_finite() else self.sign
            other_inf = 0 if other.is_finite() else other.sign
            if this_inf != 0 and other_inf != 0 and this_inf != other_inf:
                return ExpNumber.NAN
            return self if this_inf != 0 else other

        if self.sign == other.sign:
            bigger = self if self.exponent >= other.exponent else other
            smaller = other if self.exponent >= other.exponent else self
            difference = bigger.exponent - smaller.exponent
            if difference > 15:
                return bigger
            mantissa = bigger.mantissa + smaller.mantissa / _pow10(difference)
            exponent = bigger.exponent
            if mantissa >= 10:
                mantissa /= 10
                exponent += 1
            return ExpNumber(self.sign, mantissa, exponent)

        comparison = self._compare_abs(other)
        if comparison == 0:
            return ExpNumber.ZERO
        bigger = self if comparison > 0 else other
        smaller = other if comparison > 0 else self
        difference = bigger.exponent - smaller.exponent
        mantissa = bigger.mantissa
        if difference <= 15:
            mantissa -= smaller.mantissa / _pow10(difference)
        exponent = bigger.exponent
        while mantissa < 1:
            mantissa *= 10
            exponent -= 1
        value = bigger.sign * mantissa * _pow10(exponent)
        if math.isfinite(value) and value != 0:
            whole = _js_round(value)
            if abs(value - whole) <= abs(value) * 1e-9:
                return ExpNumber.from_number(whole)
        return ExpNumber(bigger.sign, mantissa, exponent)

    def sub(self, other: "ExpNumber") -> "ExpNumber":
        return self.add(other.neg())

    def mul(self, other: "ExpNumber") -> "ExpNumber":
        if self.is_zero or other.is_zero:
            return ExpNumber.ZERO
        if math.isnan(self.mantissa) or math.isnan(other.mantissa):
            return ExpNumber.NAN
        sign = self.sign * other.sign
        exponent = self.exponent + other.exponent
        if (
            self.exponent == math.inf
            or other.exponent == math.inf
        ):
            return ExpNumber.INFINITY if sign >= 0 else ExpNumber.NEGATIVE_INFINITY
        mantissa = self.mantissa * other.mantissa
        exp = exponent
        if mantissa >= 10:
            mantissa /= 10
            exp += 1
        return ExpNumber(sign, mantissa, exp)

    def div(self, other: "ExpNumber") -> "ExpNumber":
        if other.is_zero:
            if self.is_zero:
                return ExpNumber.NAN
            return ExpNumber.INFINITY if self.sign >= 0 else ExpNumber.NEGATIVE_INFINITY
        if self.is_zero:
            return ExpNumber.ZERO
        sign = self.sign * other.sign
        exponent = self.exponent - other.exponent
        if self.exponent == math.inf or other.exponent == math.inf:
            if math.isnan(exponent):
                return ExpNumber.NAN
            return ExpNumber.INFINITY if sign > 0 else ExpNumber.NEGATIVE_INFINITY
        mantissa = self.mantissa / other.mantissa
        exp = exponent
        if mantissa < 1:
            mantissa *= 10
            exp -= 1
        return ExpNumber(sign, mantissa, exp)

    def pow(self, exponent: Union[float, int, "ExpNumber"]) -> "ExpNumber":
        if isinstance(exponent, ExpNumber):
            return ExpNumber.from_log10(self.log10() * exponent.to_number())
        exponent = float(exponent)
        if exponent == 0:
            return ExpNumber.ONE
        if self.is_zero:
            return ExpNumber.ZERO
        if self.sign < 0:
            if not exponent.is_integer():
                return ExpNumber.NAN
            magnitude = ExpNumber.from_log10(self.log10() * exponent)
            return magnitude if int(exponent) % 2 == 0 else magnitude.neg()
        return ExpNumber.from_log10(self.log10() * exponent)

    def _rounded_value(self, rounding) -> "ExpNumber":
        if self.is_zero or not self.is_finite() or self.exponent > 308:
            return self
        value = self.to_number()
        if math.isnan(value):
            return ExpNumber.NAN
        if math.isinf(value):
            return ExpNumber.INFINITY if value > 0 else ExpNumber.NEGATIVE_INFINITY
        return ExpNumber.from_number(rounding(value))

    def floor(self) -> "ExpNumber":
        return self._rounded_value(math.floor)

    def ceil(self) -> "ExpNumber":
        return self._rounded_value(math.ceil)

    def round(self) -> "ExpNumber":
        return self._rounded_value(_js_round)

    def compare_to(self, other: "ExpNumber") -> int:
        if self.sign != other.sign:
            return -1 if self.sign < other.sign else 1
        if self.sign == 0:
            return 0
        comparison = self._compare_abs(other)
        if comparison == 0:
            return 0
        return -comparison if self.sign < 0 else comparison

    def _compare_abs(self, other: "ExpNumber") -> int:
        if self.exponent != other.exponent:
            return -1 if self.exponent < other.exponent else 1
        if self.mantissa != other.mantissa:
            return -1 if self.mantissa < other.mantissa else 1
        return 0

    def eq(self, other: "ExpNumber") -> bool:
        return self.compare_to(other) == 0

    def gt(self, other: "ExpNumber") -> bool:
        return self.compare_to(other) > 0

    def gte(self, other: "ExpNumber") -> bool:
        return self.compare_to(other) >= 0

    def lt(self, other: "ExpNumber") -> bool:
        return self.compare_to(other) < 0

    def lte(self, other: "ExpNumber") -> bool:
        return self.compare_to(other) <= 0


ExpNumber.ZERO = ExpNumber(0, 0, 0)
ExpNumber.ONE = ExpNumber(1, 1, 0)
ExpNumber.TEN = ExpNumber(1, 1, 1)
ExpNumber.INFINITY = ExpNumber(1, 1, math.inf)
ExpNumber.NEGATIVE_INFINITY = ExpNumber(-1, 1, math.inf)
ExpNumber.NAN = ExpNumber(math.nan, math.nan, math.nan)
