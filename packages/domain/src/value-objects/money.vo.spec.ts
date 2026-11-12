import { MoneyAmountOutOfRangeError } from '../errors/money-amount-out-of-range.error.js';
import { MoneyAssetMismatchError } from '../errors/money-asset-mismatch.error.js';
import { AssetCode } from './asset-code.vo.js';
import { MAX_MONEY_AMOUNT, MIN_MONEY_AMOUNT, Money } from './money.vo.js';

const USD = AssetCode.of('USD');
const EUR = AssetCode.of('EUR');

describe('Money', () => {
  describe('limits', () => {
    it('are the biggest and smallest numbers with 78 digits', () => {
      expect(MAX_MONEY_AMOUNT.toString()).toBe('9'.repeat(78));
      expect(MIN_MONEY_AMOUNT).toBe(-MAX_MONEY_AMOUNT);
    });

    it('are above the biggest 256-bit unsigned integer', () => {
      expect(MAX_MONEY_AMOUNT).toBeGreaterThan(2n ** 256n - 1n);
    });
  });

  describe('of', () => {
    it.each([0n, 1n, -1n, 1050n, MAX_MONEY_AMOUNT, MIN_MONEY_AMOUNT, 2n ** 256n - 1n])(
      'accepts %s',
      (amount) => {
        const money = Money.of(USD, amount);

        expect(money.asset).toBe(USD);
        expect(money.amount).toBe(amount);
      },
    );

    it.each([MAX_MONEY_AMOUNT + 1n, MIN_MONEY_AMOUNT - 1n, 10n ** 100n])('rejects %s', (amount) => {
      expect(() => Money.of(USD, amount)).toThrow(MoneyAmountOutOfRangeError);
    });

    it('rejects an amount that is not a bigint', () => {
      expect(() => Money.of(USD, 1.5 as unknown as bigint)).toThrow(TypeError);
      expect(() => Money.of(USD, 10 as unknown as bigint)).toThrow(TypeError);
      expect(() => Money.of(USD, '10' as unknown as bigint)).toThrow(TypeError);
    });
  });

  describe('zero', () => {
    it('is zero of the asset', () => {
      const money = Money.zero(EUR);

      expect(money.isZero()).toBe(true);
      expect(money.asset).toBe(EUR);
      expect(money.amount).toBe(0n);
    });
  });

  describe('plus', () => {
    it('adds amounts of the same asset', () => {
      expect(Money.of(USD, 100n).plus(Money.of(USD, 50n)).amount).toBe(150n);
    });

    it('works with negative amounts', () => {
      expect(Money.of(USD, 100n).plus(Money.of(USD, -250n)).amount).toBe(-150n);
    });

    it('keeps exact values above 2^53', () => {
      const big = Money.of(USD, 2n ** 80n);

      expect(big.plus(Money.of(USD, 1n)).amount).toBe(2n ** 80n + 1n);
    });

    it('does not change the original amounts', () => {
      const left = Money.of(USD, 100n);
      const right = Money.of(USD, 50n);

      left.plus(right);

      expect(left.amount).toBe(100n);
      expect(right.amount).toBe(50n);
    });

    it('allows a result at the limit', () => {
      expect(Money.of(USD, MAX_MONEY_AMOUNT - 1n).plus(Money.of(USD, 1n)).amount).toBe(
        MAX_MONEY_AMOUNT,
      );
    });

    it('rejects a result out of range', () => {
      expect(() => Money.of(USD, MAX_MONEY_AMOUNT).plus(Money.of(USD, 1n))).toThrow(
        MoneyAmountOutOfRangeError,
      );
      expect(() => Money.of(USD, MIN_MONEY_AMOUNT).plus(Money.of(USD, -1n))).toThrow(
        MoneyAmountOutOfRangeError,
      );
    });

    it('rejects another asset', () => {
      expect(() => Money.of(USD, 1n).plus(Money.of(EUR, 1n))).toThrow(MoneyAssetMismatchError);
    });
  });

  describe('minus', () => {
    it('takes away an amount of the same asset', () => {
      expect(Money.of(USD, 100n).minus(Money.of(USD, 30n)).amount).toBe(70n);
    });

    it('can give a negative result', () => {
      const result = Money.of(USD, 10n).minus(Money.of(USD, 30n));

      expect(result.amount).toBe(-20n);
      expect(result.isNegative()).toBe(true);
    });

    it('rejects a result out of range', () => {
      expect(() => Money.of(USD, MIN_MONEY_AMOUNT).minus(Money.of(USD, 1n))).toThrow(
        MoneyAmountOutOfRangeError,
      );
      expect(() => Money.of(USD, MAX_MONEY_AMOUNT).minus(Money.of(USD, -1n))).toThrow(
        MoneyAmountOutOfRangeError,
      );
    });

    it('rejects another asset', () => {
      expect(() => Money.of(USD, 1n).minus(Money.of(EUR, 1n))).toThrow(MoneyAssetMismatchError);
    });
  });

  describe('negate', () => {
    it('changes the sign', () => {
      expect(Money.of(USD, 5n).negate().amount).toBe(-5n);
      expect(Money.of(USD, -5n).negate().amount).toBe(5n);
    });

    it('keeps zero as zero', () => {
      expect(Money.zero(USD).negate().isZero()).toBe(true);
    });

    it('works at both limits', () => {
      expect(Money.of(USD, MAX_MONEY_AMOUNT).negate().amount).toBe(MIN_MONEY_AMOUNT);
      expect(Money.of(USD, MIN_MONEY_AMOUNT).negate().amount).toBe(MAX_MONEY_AMOUNT);
    });
  });

  describe('sign checks', () => {
    it('tell zero, negative and positive apart', () => {
      expect(Money.of(USD, 0n).isZero()).toBe(true);
      expect(Money.of(USD, 0n).isPositive()).toBe(false);
      expect(Money.of(USD, 0n).isNegative()).toBe(false);

      expect(Money.of(USD, 1n).isZero()).toBe(false);
      expect(Money.of(USD, 1n).isPositive()).toBe(true);
      expect(Money.of(USD, 1n).isNegative()).toBe(false);

      expect(Money.of(USD, -1n).isZero()).toBe(false);
      expect(Money.of(USD, -1n).isPositive()).toBe(false);
      expect(Money.of(USD, -1n).isNegative()).toBe(true);
    });
  });

  describe('equals', () => {
    it('is true for the same asset and amount', () => {
      expect(Money.of(USD, 5n).equals(Money.of(AssetCode.of('USD'), 5n))).toBe(true);
    });

    it('is false for another amount or another asset', () => {
      expect(Money.of(USD, 5n).equals(Money.of(USD, 6n))).toBe(false);
      expect(Money.of(USD, 5n).equals(Money.of(EUR, 5n))).toBe(false);
    });
  });

  describe('toString', () => {
    it('shows the amount and the asset', () => {
      expect(Money.of(USD, 1050n).toString()).toBe('1050 USD');
      expect(Money.of(EUR, -7n).toString()).toBe('-7 EUR');
    });
  });
});
