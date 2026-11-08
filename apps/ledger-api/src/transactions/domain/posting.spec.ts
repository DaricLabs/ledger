import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { InvalidPostingError } from './invalid-posting.error.js';
import { Posting } from './posting.js';

const usd = AssetCode.of('USD');
const a = AccountAddress.of('users:1');
const b = AccountAddress.of('users:2');

describe('Posting.of', () => {
  it('keeps the source, the destination and the money', () => {
    const posting = Posting.of(a, b, Money.of(usd, 150n));

    expect(posting.source).toBe(a);
    expect(posting.destination).toBe(b);
    expect(posting.money.amount).toBe(150n);
    expect(posting.asset.value).toBe('USD');
  });

  it.each([0n, -1n])('refuses the amount %s', (amount) => {
    expect(() => Posting.of(a, b, Money.of(usd, amount))).toThrow(InvalidPostingError);
  });

  it('refuses the same account as source and destination', () => {
    expect(() => Posting.of(a, AccountAddress.of('users:1'), Money.of(usd, 1n))).toThrow(
      InvalidPostingError,
    );
  });

  it('has a stable error code and a message that repeats no value', () => {
    const error = (() => {
      try {
        Posting.of(a, a, Money.of(usd, 1n));
      } catch (thrown) {
        return thrown as InvalidPostingError;
      }
    })();

    expect(error?.code).toBe('INVALID_POSTING');
    expect(error?.message).not.toContain('users:1');
  });
});
