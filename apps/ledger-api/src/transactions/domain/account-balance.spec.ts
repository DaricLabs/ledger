import { AccountAddress, AssetCode, Money, MoneyAssetMismatchError } from '@ledger/domain';
import {
  AccountBalance,
  balanceKeyText,
  compareBalanceKeys,
  type IBalanceKey,
} from './account-balance.js';
import { InsufficientFundsError } from './insufficient-funds.error.js';

const usd = AssetCode.of('USD');
const eur = AssetCode.of('EUR');
const address = (value: string) => AccountAddress.of(value);
const key = (account: string, asset: AssetCode): IBalanceKey => ({
  address: address(account),
  asset,
});
const balance = (account: string, amount: bigint, allowOverdraft = false) =>
  AccountBalance.reconstitute({
    address: address(account),
    balance: Money.of(usd, amount),
    allowOverdraft,
  });

describe('AccountBalance.open', () => {
  it('starts at zero', () => {
    const opened = AccountBalance.open(address('users:1'), usd);

    expect(opened.balance.isZero()).toBe(true);
    expect(opened.asset.value).toBe('USD');
    expect(opened.key).toEqual(key('users:1', usd));
  });

  it('lets only world go below zero', () => {
    expect(AccountBalance.open(AccountAddress.WORLD, usd).allowOverdraft).toBe(true);
    expect(AccountBalance.open(address('users:1'), usd).allowOverdraft).toBe(false);
    expect(AccountBalance.open(address('world:1'), usd).allowOverdraft).toBe(false);
  });
});

describe('AccountBalance.credit', () => {
  it('adds money and leaves the old balance as it was', () => {
    const before = balance('a', 10n);

    const after = before.credit(Money.of(usd, 5n));

    expect(after.balance.amount).toBe(15n);
    expect(before.balance.amount).toBe(10n);
  });

  it('refuses money of another asset', () => {
    expect(() => balance('a', 10n).credit(Money.of(eur, 1n))).toThrow(MoneyAssetMismatchError);
  });
});

describe('AccountBalance.debit', () => {
  it('takes money out, down to exactly zero', () => {
    expect(balance('a', 10n).debit(Money.of(usd, 10n)).balance.amount).toBe(0n);
  });

  it('refuses to go below zero, and says what was missing', () => {
    const error = (() => {
      try {
        balance('users:1', 10n).debit(Money.of(usd, 11n));
      } catch (thrown) {
        return thrown as InsufficientFundsError;
      }
    })();

    expect(error).toBeInstanceOf(InsufficientFundsError);
    expect(error).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      account: 'users:1',
      asset: 'USD',
      balance: '10',
      needed: '11',
    });
    expect(error?.message).toBe(
      'Account "users:1" has not enough USD: balance is 10, but 11 is needed',
    );
  });

  it('goes below zero when the account allows overdraft', () => {
    const after = balance('world', 0n, true).debit(Money.of(usd, 25n));

    expect(after.balance.amount).toBe(-25n);
    expect(after.allowOverdraft).toBe(true);
  });

  it('keeps going down for an account that is already below zero and may overdraft', () => {
    expect(balance('world', -5n, true).debit(Money.of(usd, 5n)).balance.amount).toBe(-10n);
  });
});

describe('balance keys', () => {
  it('gives the same text only for the same account and asset', () => {
    expect(balanceKeyText(key('a', usd))).toBe(balanceKeyText(key('a', usd)));
    expect(balanceKeyText(key('a', usd))).not.toBe(balanceKeyText(key('a', eur)));
    expect(balanceKeyText(key('a', usd))).not.toBe(balanceKeyText(key('b', usd)));
  });

  it('sorts by address, then by asset, by character code', () => {
    const sorted = [
      key('b', usd),
      key('a:b', usd),
      key('a', usd),
      key('a', eur),
      key('a-1', usd),
    ].sort(compareBalanceKeys);

    // ":" (58) comes after "-" (45) and before letters.
    expect(sorted.map(balanceKeyText)).toEqual(['a EUR', 'a USD', 'a-1 USD', 'a:b USD', 'b USD']);
  });

  it('says two equal keys are equal', () => {
    expect(compareBalanceKeys(key('a', usd), key('a', usd))).toBe(0);
  });
});
