import type { AssetCode } from './asset-code.js';
import { MoneyAmountOutOfRangeError } from './money-amount-out-of-range.error.js';
import { MoneyAssetMismatchError } from './money-asset-mismatch.error.js';

/**
 * The biggest amount `Money` can hold: 10^78 - 1, the biggest number with
 * 78 digits.
 *
 * It is the limit of `numeric(78, 0)`, the column type of amounts and
 * balances in `0001_init.sql`. It is also bigger than the biggest 256-bit
 * unsigned integer (about 1.16 * 10^77), so token amounts from blockchains
 * fit. If you change this, change the column type too.
 */
export const MAX_MONEY_AMOUNT: bigint = 10n ** 78n - 1n;

/** The smallest amount `Money` can hold. The range is the same on both sides of zero. */
export const MIN_MONEY_AMOUNT: bigint = -MAX_MONEY_AMOUNT;

/** The data a `Money` is made of. */
interface MoneyProps {
  asset: AssetCode;
  amount: bigint;
}

/**
 * An amount of one asset, for example 1050 USD cents.
 *
 * It is a value object: it never changes, and two `Money` with the same
 * asset and amount are equal. `plus`, `minus` and `negate` give a new `Money`
 * and leave the old one as it was.
 *
 * - The amount is a `bigint` of the smallest unit of the asset. There are no
 *   decimals, so there are no rounding errors. A JavaScript `number` is not
 *   used because it loses exact values above 2^53.
 * - The amount can be negative. A balance can go below zero when overdraft is
 *   allowed, and `minus` can give a negative result. The rule "a posting
 *   must be positive" belongs to the posting, not to this class.
 * - The amount is always inside `MIN_MONEY_AMOUNT` and `MAX_MONEY_AMOUNT`, so
 *   a `Money` can always be stored.
 * - Amounts of different assets never mix. That is a rule of accounting, and
 *   it is easy to break by mistake, so this class does not allow it.
 *
 * There is no `toJSON` on purpose. A `bigint` cannot go into JSON, and how
 * the API shows amounts (as a string or as a number) is decided by the HTTP
 * layer, not here.
 */
export class Money {
  private constructor(private readonly props: Readonly<MoneyProps>) {}

  /**
   * Makes an amount of money.
   *
   * @throws {MoneyAmountOutOfRangeError} If the amount is outside `MIN_MONEY_AMOUNT` and `MAX_MONEY_AMOUNT`.
   * @throws {TypeError} If the amount is not a `bigint`. TypeScript stops this at build time, so it is a bug in the caller.
   */
  static of(asset: AssetCode, amount: bigint): Money {
    if (typeof amount !== 'bigint') {
      throw new TypeError('Money amount must be a bigint');
    }
    assertInRange(amount);
    return new Money({ asset, amount });
  }

  /** Zero of an asset. */
  static zero(asset: AssetCode): Money {
    return new Money({ asset, amount: 0n });
  }

  get asset(): AssetCode {
    return this.props.asset;
  }

  /** Whole number of the smallest unit of the asset. Negative when below zero. */
  get amount(): bigint {
    return this.props.amount;
  }

  /**
   * Adds another amount of the same asset.
   *
   * @throws {MoneyAssetMismatchError} If the assets are different.
   * @throws {MoneyAmountOutOfRangeError} If the result is out of range.
   */
  plus(other: Money): Money {
    this.assertSameAsset(other);
    const amount = this.props.amount + other.props.amount;
    assertInRange(amount);
    return new Money({ asset: this.props.asset, amount });
  }

  /**
   * Takes away another amount of the same asset. The result can be negative.
   *
   * @throws {MoneyAssetMismatchError} If the assets are different.
   * @throws {MoneyAmountOutOfRangeError} If the result is out of range.
   */
  minus(other: Money): Money {
    this.assertSameAsset(other);
    const amount = this.props.amount - other.props.amount;
    assertInRange(amount);
    return new Money({ asset: this.props.asset, amount });
  }

  /** The same amount with the other sign. It cannot go out of range, because the range is the same on both sides of zero. */
  negate(): Money {
    return new Money({ asset: this.props.asset, amount: -this.props.amount });
  }

  isZero(): boolean {
    return this.props.amount === 0n;
  }

  /** True when the amount is below zero. */
  isNegative(): boolean {
    return this.props.amount < 0n;
  }

  /** True when the amount is above zero. */
  isPositive(): boolean {
    return this.props.amount > 0n;
  }

  /** True when the asset and the amount are both the same. */
  equals(other: Money): boolean {
    return this.props.asset.equals(other.props.asset) && this.props.amount === other.props.amount;
  }

  /** For logs and messages, for example `1050 USD`. */
  toString(): string {
    return `${this.props.amount} ${this.props.asset.toString()}`;
  }

  private assertSameAsset(other: Money): void {
    if (!this.props.asset.equals(other.props.asset)) {
      throw new MoneyAssetMismatchError(this.props.asset.value, other.props.asset.value);
    }
  }
}

function assertInRange(amount: bigint): void {
  if (amount > MAX_MONEY_AMOUNT || amount < MIN_MONEY_AMOUNT) {
    throw new MoneyAmountOutOfRangeError();
  }
}
