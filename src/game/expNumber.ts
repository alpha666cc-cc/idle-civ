/**
 * ExpNumber — an extended-precision number type for idle-civ.
 *
 * JS doubles cap out near 1.8e308, so exponential idle-game growth such as
 * `10 * 1.3^1e10` (≈ 10^1.14e9) overflows to `Infinity` almost immediately.
 * ExpNumber stores a magnitude as
 *
 *     sign * mantissa * 10^exponent
 *
 * with `mantissa` in [1, 10) and `exponent` itself a double, extending the
 * representable range to roughly 10^(1.8e308) — far beyond anything the game
 * can reach. Precision is ~15 significant digits, matching doubles.
 *
 * Integer counts that stay small (building counts, worker assignments and
 * array lengths) remain ordinary `number`s; this type is used for the
 * quantities that grow without bound: resource amounts, production rates,
 * multipliers and building costs.
 */
export class ExpNumber {
  /** -1, 0 or 1. */
  readonly sign: number;
  /** Mantissa in [1, 10); 0 when the value is zero. */
  readonly mantissa: number;
  /** Base-10 exponent, stored as a double so it can itself be enormous. */
  readonly exponent: number;

  constructor(sign: number, mantissa: number, exponent: number) {
    this.sign = sign;
    this.mantissa = mantissa;
    this.exponent = exponent;
  }

  static readonly ZERO = new ExpNumber(0, 0, 0);
  static readonly ONE = new ExpNumber(1, 1, 0);
  static readonly TEN = new ExpNumber(1, 1, 1);
  static readonly INFINITY = new ExpNumber(1, 1, Number.POSITIVE_INFINITY);
  static readonly NEGATIVE_INFINITY = new ExpNumber(
    -1,
    1,
    Number.POSITIVE_INFINITY,
  );
  static readonly NAN = new ExpNumber(Number.NaN, Number.NaN, Number.NaN);

  /** Accepts a number, scientific-notation string, or normalized ExpNumber. */
  static from(value: number | string | ExpNumber): ExpNumber {
    return value instanceof ExpNumber
      ? value
      : typeof value === "string"
        ? ExpNumber.fromScientific(value)
        : ExpNumber.fromNumber(value);
  }

  static fromScientific(value: string): ExpNumber {
    const match = value
      .trim()
      .match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:e([+-]?\d+))?$/i);
    if (!match) throw new Error(`Invalid scientific number: ${value}`);
    const coefficient = Number(match[1]);
    const exponent = Number(match[2] ?? 0);
    if (!Number.isFinite(coefficient) || !Number.isSafeInteger(exponent)) {
      throw new Error(`Invalid scientific number: ${value}`);
    }
    return ExpNumber.fromNumber(coefficient).mul(
      ExpNumber.fromNumber(10).pow(exponent),
    );
  }

  static fromNumber(value: number): ExpNumber {
    if (!Number.isFinite(value)) {
      if (Number.isNaN(value)) return ExpNumber.NAN;
      return value > 0 ? ExpNumber.INFINITY : ExpNumber.NEGATIVE_INFINITY;
    }
    if (value === 0) return ExpNumber.ZERO;
    const sign = value < 0 ? -1 : 1;
    const abs = Math.abs(value);
    const exponent = Math.floor(Math.log10(abs));
    return new ExpNumber(sign, abs / 10 ** exponent, exponent);
  }

  /** Builds the value 10^log10. */
  static fromLog10(log10: number): ExpNumber {
    if (!Number.isFinite(log10)) {
      if (Number.isNaN(log10)) return ExpNumber.NAN;
      return log10 > 0 ? ExpNumber.INFINITY : ExpNumber.ZERO;
    }
    const exponent = Math.floor(log10);
    const mantissa = 10 ** (log10 - exponent);
    return new ExpNumber(1, mantissa, exponent);
  }

  static max(...values: ExpNumber[]): ExpNumber {
    return values.reduce(
      (result, value) => (result.gte(value) ? result : value),
      ExpNumber.NEGATIVE_INFINITY,
    );
  }

  static min(...values: ExpNumber[]): ExpNumber {
    return values.reduce(
      (result, value) => (result.lte(value) ? result : value),
      ExpNumber.INFINITY,
    );
  }

  get isZero(): boolean {
    return this.sign === 0;
  }

  get isNegative(): boolean {
    return this.sign < 0;
  }

  get isFinite(): boolean {
    return (
      this.sign !== 0 &&
      Number.isFinite(this.mantissa) &&
      Number.isFinite(this.exponent)
    );
  }

  neg(): ExpNumber {
    if (this.isZero) return this;
    return new ExpNumber(-this.sign, this.mantissa, this.exponent);
  }

  abs(): ExpNumber {
    return this.sign < 0
      ? new ExpNumber(1, this.mantissa, this.exponent)
      : this;
  }

  /** Base-10 logarithm of the magnitude (negative infinity for zero). */
  log10(): number {
    if (this.isZero) return Number.NEGATIVE_INFINITY;
    return this.exponent + Math.log10(this.mantissa);
  }

  toNumber(): number {
    if (this.isZero) return 0;
    return this.sign * this.mantissa * 10 ** this.exponent;
  }

  add(other: ExpNumber): ExpNumber {
    if (this.isZero) return other;
    if (other.isZero) return this;

    if (!this.isFinite || !other.isFinite) {
      if (Number.isNaN(this.mantissa) || Number.isNaN(other.mantissa))
        return ExpNumber.NAN;
      const thisInf = this.isFinite ? 0 : this.sign;
      const otherInf = other.isFinite ? 0 : other.sign;
      if (thisInf !== 0 && otherInf !== 0 && thisInf !== otherInf)
        return ExpNumber.NAN;
      return thisInf !== 0 ? this : other;
    }

    if (this.sign === other.sign) {
      const bigger = this.exponent >= other.exponent ? this : other;
      const smaller = this.exponent >= other.exponent ? other : this;
      const difference = bigger.exponent - smaller.exponent;
      if (difference > 15) return bigger;
      let mantissa = bigger.mantissa + smaller.mantissa / 10 ** difference;
      let exponent = bigger.exponent;
      if (mantissa >= 10) {
        mantissa /= 10;
        exponent += 1;
      }
      return new ExpNumber(this.sign, mantissa, exponent);
    }

    const comparison = this.abs().compareAbs(other.abs());
    if (comparison === 0) return ExpNumber.ZERO;
    const bigger = comparison > 0 ? this : other;
    const smaller = comparison > 0 ? other : this;
    const difference = bigger.exponent - smaller.exponent;
    let mantissa = bigger.mantissa;
    if (difference <= 15) mantissa -= smaller.mantissa / 10 ** difference;
    let exponent = bigger.exponent;
    while (mantissa < 1) {
      mantissa *= 10;
      exponent -= 1;
    }
    return new ExpNumber(bigger.sign, mantissa, exponent);
  }

  sub(other: ExpNumber): ExpNumber {
    return this.add(other.neg());
  }

  mul(other: ExpNumber): ExpNumber {
    if (this.isZero || other.isZero) return ExpNumber.ZERO;
    if (Number.isNaN(this.mantissa) || Number.isNaN(other.mantissa))
      return ExpNumber.NAN;
    const sign = this.sign * other.sign;
    const exponent = this.exponent + other.exponent;
    if (
      this.exponent === Number.POSITIVE_INFINITY ||
      other.exponent === Number.POSITIVE_INFINITY
    ) {
      return sign >= 0 ? ExpNumber.INFINITY : ExpNumber.NEGATIVE_INFINITY;
    }
    let mantissa = this.mantissa * other.mantissa;
    let exp = exponent;
    if (mantissa >= 10) {
      mantissa /= 10;
      exp += 1;
    }
    return new ExpNumber(sign, mantissa, exp);
  }

  div(other: ExpNumber): ExpNumber {
    if (other.isZero) {
      if (this.isZero) return ExpNumber.NAN;
      return this.sign >= 0 ? ExpNumber.INFINITY : ExpNumber.NEGATIVE_INFINITY;
    }
    if (this.isZero) return ExpNumber.ZERO;
    const sign = this.sign * other.sign;
    const exponent = this.exponent - other.exponent;
    if (
      this.exponent === Number.POSITIVE_INFINITY ||
      other.exponent === Number.POSITIVE_INFINITY
    ) {
      return Number.isNaN(exponent)
        ? ExpNumber.NAN
        : sign > 0
          ? ExpNumber.INFINITY
          : ExpNumber.NEGATIVE_INFINITY;
    }
    let mantissa = this.mantissa / other.mantissa;
    let exp = exponent;
    if (mantissa < 1) {
      mantissa *= 10;
      exp -= 1;
    }
    return new ExpNumber(sign, mantissa, exp);
  }

  pow(exponent: number | ExpNumber): ExpNumber {
    if (exponent instanceof ExpNumber) {
      return ExpNumber.fromLog10(this.log10() * exponent.toNumber());
    }
    if (exponent === 0) return ExpNumber.ONE;
    if (this.isZero) return ExpNumber.ZERO;
    if (this.sign < 0) {
      if (!Number.isInteger(exponent)) return ExpNumber.NAN;
      const magnitude = ExpNumber.fromLog10(this.log10() * exponent);
      return exponent % 2 === 0 ? magnitude : magnitude.neg();
    }
    return ExpNumber.fromLog10(this.log10() * exponent);
  }

  floor(): ExpNumber {
    if (this.isZero || !this.isFinite || this.exponent > 308) return this;
    return ExpNumber.fromNumber(Math.floor(this.toNumber()));
  }

  ceil(): ExpNumber {
    if (this.isZero || !this.isFinite || this.exponent > 308) return this;
    return ExpNumber.fromNumber(Math.ceil(this.toNumber()));
  }

  eq(other: ExpNumber): boolean {
    return this.compareTo(other) === 0;
  }

  gt(other: ExpNumber): boolean {
    return this.compareTo(other) > 0;
  }

  gte(other: ExpNumber): boolean {
    return this.compareTo(other) >= 0;
  }

  lt(other: ExpNumber): boolean {
    return this.compareTo(other) < 0;
  }

  lte(other: ExpNumber): boolean {
    return this.compareTo(other) <= 0;
  }

  /** Full ordering; NaN comparisons are undefined but harmless. */
  compareTo(other: ExpNumber): number {
    if (this.sign !== other.sign) return this.sign < other.sign ? -1 : 1;
    if (this.sign === 0) return 0;
    const comparison = this.compareAbs(other);
    if (comparison === 0) return 0;
    return this.sign < 0 ? -comparison : comparison;
  }

  private compareAbs(other: ExpNumber): number {
    if (this.exponent !== other.exponent)
      return this.exponent < other.exponent ? -1 : 1;
    if (this.mantissa !== other.mantissa)
      return this.mantissa < other.mantissa ? -1 : 1;
    return 0;
  }

  toString(): string {
    if (Number.isNaN(this.mantissa)) return "NaN";
    if (!Number.isFinite(this.exponent))
      return this.sign >= 0 ? "Infinity" : "-Infinity";
    if (this.isZero) return "0";
    const prefix = this.sign < 0 ? "-" : "";
    return `${prefix}${this.mantissa}e${this.exponent}`;
  }
}
