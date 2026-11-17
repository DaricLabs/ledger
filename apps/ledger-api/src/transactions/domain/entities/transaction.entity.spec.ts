import { AccountAddress, AssetCode, Money, MoneyAmountOutOfRangeError } from '@ledger/domain';
import {
  AccountBalance,
  balanceKeyText,
} from '../../../accounts/domain/entities/account-balance.entity.js';
import { InsufficientFundsError } from '../../../accounts/domain/errors/insufficient-funds.error.js';
import { InvalidTransactionError } from '../errors/invalid-transaction.error.js';
import { TransactionAlreadyRevertedError } from '../errors/transaction-already-reverted.error.js';
import { Posting } from '../value-objects/posting.vo.js';
import {
  TRANSACTION_MAX_POSTINGS,
  TRANSACTION_REFERENCE_MAX_LENGTH,
} from '../constants/transaction-limits.constant.js';
import { Transaction, type ITransactionProps } from './transaction.entity.js';

const usd = AssetCode.of('USD');
const eur = AssetCode.of('EUR');
const posting = (source: string, destination: string, amount: bigint, asset = usd) =>
  Posting.of(AccountAddress.of(source), AccountAddress.of(destination), Money.of(asset, amount));

const props = (overrides: Partial<ITransactionProps> = {}): ITransactionProps => ({
  id: '0190a5d4-7b3c-7abc-8def-0123456789ab',
  organizationId: '0190a5d4-7b3c-7abc-8def-0123456789ac',
  ledgerId: '0190a5d4-7b3c-7abc-8def-0123456789ad',
  reference: null,
  postings: [posting('world', 'a', 100n)],
  postedAt: new Date('2026-11-07T10:00:00.000Z'),
  createdAt: new Date('2026-11-07T10:00:01.000Z'),
  revertedAt: null,
  revertedByTransactionId: null,
  ...overrides,
});

/** The balance of an account that holds `amount` USD. World may go below zero. */
const held = (account: string, amount: bigint, asset = usd) =>
  AccountBalance.reconstitute({
    address: AccountAddress.of(account),
    balance: Money.of(asset, amount),
    allowOverdraft: account === 'world',
  });

describe('Transaction.reconstitute', () => {
  it('keeps what it was given', () => {
    const transaction = Transaction.reconstitute(props({ reference: 'order-1' }));

    expect(transaction.id).toBe('0190a5d4-7b3c-7abc-8def-0123456789ab');
    expect(transaction.organizationId).toBe('0190a5d4-7b3c-7abc-8def-0123456789ac');
    expect(transaction.ledgerId).toBe('0190a5d4-7b3c-7abc-8def-0123456789ad');
    expect(transaction.reference).toBe('order-1');
    expect(transaction.postings).toHaveLength(1);
    expect(transaction.postedAt).toEqual(new Date('2026-11-07T10:00:00.000Z'));
    expect(transaction.createdAt).toEqual(new Date('2026-11-07T10:00:01.000Z'));
  });

  it('trusts storage: it does not check the rules of create again', () => {
    expect(() => Transaction.reconstitute(props({ postings: [] }))).not.toThrow();
  });

  it('is not changed by changes to the list or the dates it was given', () => {
    const postings = [posting('world', 'a', 100n)];
    const createdAt = new Date('2026-11-07T10:00:01.000Z');
    const transaction = Transaction.reconstitute(props({ postings, createdAt }));

    postings.push(posting('a', 'b', 1n));
    createdAt.setFullYear(2000);

    expect(transaction.postings).toHaveLength(1);
    expect(transaction.createdAt).toEqual(new Date('2026-11-07T10:00:01.000Z'));
  });

  it('applies postings like a transaction made with create', () => {
    const transaction = Transaction.reconstitute(props({ postings: [posting('world', 'a', 5n)] }));

    const result = transaction.applyTo([held('a', 0n), held('world', 0n)]);

    expect(result.map((b) => [b.key.address.value, b.balance.amount])).toEqual([
      ['a', 5n],
      ['world', -5n],
    ]);
  });
});

describe('Transaction.create', () => {
  it('keeps what it was given', () => {
    const transaction = Transaction.create(props({ reference: 'order-1' }));

    expect(transaction.id).toBe('0190a5d4-7b3c-7abc-8def-0123456789ab');
    expect(transaction.organizationId).toBe('0190a5d4-7b3c-7abc-8def-0123456789ac');
    expect(transaction.ledgerId).toBe('0190a5d4-7b3c-7abc-8def-0123456789ad');
    expect(transaction.reference).toBe('order-1');
    expect(transaction.postings).toHaveLength(1);
    expect(transaction.postedAt).toEqual(new Date('2026-11-07T10:00:00.000Z'));
    expect(transaction.createdAt).toEqual(new Date('2026-11-07T10:00:01.000Z'));
  });

  it('accepts the most postings and the longest reference', () => {
    const postings = Array.from({ length: TRANSACTION_MAX_POSTINGS }, () =>
      posting('world', 'a', 1n),
    );

    expect(() =>
      Transaction.create(
        props({ postings, reference: 'r'.repeat(TRANSACTION_REFERENCE_MAX_LENGTH) }),
      ),
    ).not.toThrow();
  });

  it('refuses no postings', () => {
    expect(() => Transaction.create(props({ postings: [] }))).toThrow(InvalidTransactionError);
  });

  it('refuses more postings than the limit', () => {
    const postings = Array.from({ length: TRANSACTION_MAX_POSTINGS + 1 }, () =>
      posting('world', 'a', 1n),
    );

    expect(() => Transaction.create(props({ postings }))).toThrow(InvalidTransactionError);
  });

  it.each(['', 'r'.repeat(TRANSACTION_REFERENCE_MAX_LENGTH + 1)])(
    'refuses a reference with a wrong length',
    (reference) => {
      expect(() => Transaction.create(props({ reference }))).toThrow(InvalidTransactionError);
    },
  );

  it('has a stable error code', () => {
    expect(() => Transaction.create(props({ postings: [] }))).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSACTION' }),
    );
  });

  it('is not changed by changes to the list or the dates it was given', () => {
    const postings = [posting('world', 'a', 100n)];
    const postedAt = new Date('2026-11-07T10:00:00.000Z');
    const transaction = Transaction.create(props({ postings, postedAt }));

    postings.push(posting('a', 'b', 1n));
    postedAt.setFullYear(2000);

    expect(transaction.postings).toHaveLength(1);
    expect(transaction.postedAt).toEqual(new Date('2026-11-07T10:00:00.000Z'));
  });

  it('gives safe values from its getters', () => {
    const transaction = Transaction.create(props());

    transaction.postedAt.setFullYear(2000);

    expect(transaction.postedAt.getUTCFullYear()).toBe(2026);
    expect(Object.isFrozen(transaction.postings)).toBe(true);
  });
});

describe('Transaction.touchedBalances', () => {
  it('lists each account and asset once, in the lock order', () => {
    const transaction = Transaction.create(
      props({
        postings: [
          posting('users:2', 'users:1', 1n),
          posting('users:1', 'users:2', 1n),
          posting('users:1', 'users:2', 1n, eur),
          posting('world', 'users:1', 1n),
        ],
      }),
    );

    expect(transaction.touchedBalances().map(balanceKeyText)).toEqual([
      'users:1 EUR',
      'users:1 USD',
      'users:2 EUR',
      'users:2 USD',
      'world USD',
    ]);
  });
});

describe('Transaction.applyTo', () => {
  it('moves the money and returns the new balances in the lock order', () => {
    const transaction = Transaction.create(
      props({ postings: [posting('world', 'b', 100n), posting('b', 'a', 30n)] }),
    );

    const after = transaction.applyTo([held('world', 0n), held('b', 0n), held('a', 0n)]);

    expect(after.map((b) => [b.address.value, b.balance.amount])).toEqual([
      ['a', 30n],
      ['b', 70n],
      ['world', -100n],
    ]);
  });

  it('does not change the balances it was given', () => {
    const world = held('world', 0n);
    const a = held('a', 0n);

    Transaction.create(props()).applyTo([world, a]);

    expect(world.balance.amount).toBe(0n);
    expect(a.balance.amount).toBe(0n);
  });

  it('lets money pass through an account in one transaction', () => {
    const transaction = Transaction.create(
      props({ postings: [posting('world', 'b', 10n), posting('b', 'a', 10n)] }),
    );

    const after = transaction.applyTo([held('world', 0n), held('b', 0n), held('a', 0n)]);

    expect(after.find((b) => b.address.value === 'b')?.balance.amount).toBe(0n);
  });

  it('checks postings in order, so money cannot go out before it comes in', () => {
    const transaction = Transaction.create(
      props({ postings: [posting('b', 'a', 10n), posting('world', 'b', 10n)] }),
    );

    expect(() => transaction.applyTo([held('world', 0n), held('b', 0n), held('a', 0n)])).toThrow(
      InsufficientFundsError,
    );
  });

  it('sees what an earlier posting did when it checks a later one', () => {
    const transaction = Transaction.create(
      props({ postings: [posting('a', 'b', 8n), posting('a', 'b', 8n)] }),
    );

    // Each posting alone is fine (10 >= 8), but together they are not (16 > 10).
    expect(() => transaction.applyTo([held('a', 10n), held('b', 0n)])).toThrow(
      expect.objectContaining({ account: 'a', balance: '2', needed: '8' }),
    );
  });

  it('keeps assets apart', () => {
    const transaction = Transaction.create(props({ postings: [posting('a', 'b', 5n, eur)] }));

    // `a` has 100 USD but no EUR.
    expect(() =>
      transaction.applyTo([held('a', 0n, eur), held('b', 0n, eur), held('a', 100n)]),
    ).toThrow(InsufficientFundsError);
  });

  it('refuses a balance that would be too big to store', () => {
    const big = 10n ** 78n - 1n;
    const transaction = Transaction.create(props({ postings: [posting('world', 'a', 1n)] }));

    expect(() => transaction.applyTo([held('world', 0n), held('a', big)])).toThrow(
      MoneyAmountOutOfRangeError,
    );
  });

  it('throws a plain error when a balance was not loaded', () => {
    const transaction = Transaction.create(props());

    expect(() => transaction.applyTo([held('world', 0n)])).toThrow(
      'Balance of "a" in "USD" was not loaded',
    );
  });
});

describe('revert state', () => {
  it('is not reverted when it is new', () => {
    const transaction = Transaction.create(props());

    expect(transaction.isReverted).toBe(false);
    expect(transaction.revertedAt).toBeNull();
    expect(transaction.revertedByTransactionId).toBeNull();
  });

  it('keeps the revert data it was rebuilt with', () => {
    const transaction = Transaction.reconstitute(
      props({
        revertedAt: new Date('2026-11-08T10:00:00.000Z'),
        revertedByTransactionId: '0190a5d4-7b3c-7abc-8def-0123456789ae',
      }),
    );

    expect(transaction.isReverted).toBe(true);
    expect(transaction.revertedAt).toEqual(new Date('2026-11-08T10:00:00.000Z'));
    expect(transaction.revertedByTransactionId).toBe('0190a5d4-7b3c-7abc-8def-0123456789ae');
  });

  it('gives a new date each time, so the revert time cannot be changed from outside', () => {
    const transaction = Transaction.reconstitute(
      props({
        revertedAt: new Date('2026-11-08T10:00:00.000Z'),
        revertedByTransactionId: '0190a5d4-7b3c-7abc-8def-0123456789ae',
      }),
    );

    transaction.revertedAt?.setFullYear(2000);

    expect(transaction.revertedAt).toEqual(new Date('2026-11-08T10:00:00.000Z'));
  });
});

describe('Transaction.reverse', () => {
  const REVERSAL_ID = '0190a5d4-7b3c-7abc-8def-0123456789ae';
  const at = new Date('2026-11-08T12:00:00.000Z');

  const original = () =>
    Transaction.create(
      props({
        reference: 'order-1',
        postings: [posting('world', 'a', 100n), posting('a', 'b', 40n), posting('a', 'c', 10n)],
      }),
    );

  it('makes a new transaction in the same ledger and organization, with the given id and time', () => {
    const reversal = original().reverse({ id: REVERSAL_ID, at });

    expect(reversal.id).toBe(REVERSAL_ID);
    expect(reversal.organizationId).toBe('0190a5d4-7b3c-7abc-8def-0123456789ac');
    expect(reversal.ledgerId).toBe('0190a5d4-7b3c-7abc-8def-0123456789ad');
    expect(reversal.postedAt).toEqual(at);
    expect(reversal.createdAt).toEqual(at);
  });

  it('turns every posting around and puts them in the opposite order', () => {
    const reversal = original().reverse({ id: REVERSAL_ID, at });

    expect(
      reversal.postings.map((p) => [p.source.value, p.destination.value, p.money.amount]),
    ).toEqual([
      ['c', 'a', 10n],
      ['b', 'a', 40n],
      ['a', 'world', 100n],
    ]);
  });

  it('has no reference, and is not reverted', () => {
    const reversal = original().reverse({ id: REVERSAL_ID, at });

    expect(reversal.reference).toBeNull();
    expect(reversal.isReverted).toBe(false);
  });

  it('does not change the original', () => {
    const transaction = original();

    transaction.reverse({ id: REVERSAL_ID, at });

    expect(transaction.isReverted).toBe(false);
    expect(transaction.reference).toBe('order-1');
    expect(transaction.postings.map((p) => p.source.value)).toEqual(['world', 'a', 'a']);
  });

  it('refuses a transaction that was reverted before', () => {
    const transaction = Transaction.reconstitute(
      props({
        revertedAt: new Date('2026-11-08T10:00:00.000Z'),
        revertedByTransactionId: '0190a5d4-7b3c-7abc-8def-0123456789af',
      }),
    );

    expect(() => transaction.reverse({ id: REVERSAL_ID, at })).toThrow(
      TransactionAlreadyRevertedError,
    );
  });

  it('can be reverted again: a revert is a transaction like any other', () => {
    const reversal = original().reverse({ id: REVERSAL_ID, at });

    const again = reversal.reverse({ id: '0190a5d4-7b3c-7abc-8def-0123456789b0', at });

    expect(again.postings.map((p) => [p.source.value, p.destination.value])).toEqual([
      ['world', 'a'],
      ['a', 'b'],
      ['a', 'c'],
    ]);
  });

  it('puts every balance back to where it was, when applied after the original', () => {
    const transaction = original();
    const afterOriginal = transaction.applyTo([
      held('world', 0n),
      held('a', 0n),
      held('b', 0n),
      held('c', 0n),
    ]);

    const afterReversal = transaction.reverse({ id: REVERSAL_ID, at }).applyTo(afterOriginal);

    expect(afterReversal.map((b) => [b.key.address.value, b.balance.amount])).toEqual([
      ['a', 0n],
      ['b', 0n],
      ['c', 0n],
      ['world', 0n],
    ]);
  });

  it('undoes a chain of postings where the middle account ends at zero', () => {
    // a pays b, and b pays c with the same money: b ends at zero.
    const chain = Transaction.create(
      props({ postings: [posting('a', 'b', 50n), posting('b', 'c', 50n)] }),
    );
    const afterChain = chain.applyTo([held('a', 50n), held('b', 0n), held('c', 0n)]);

    const reversal = chain.reverse({ id: REVERSAL_ID, at });

    expect(() => reversal.applyTo(afterChain)).not.toThrow();
  });

  it('fails with InsufficientFundsError when the money was spent after the original', () => {
    const transaction = Transaction.create(props({ postings: [posting('world', 'a', 100n)] }));
    // `a` got 100 and then paid 70 away: it cannot give 100 back.
    const reversal = transaction.reverse({ id: REVERSAL_ID, at });

    expect(() => reversal.applyTo([held('a', 30n), held('world', -100n)])).toThrow(
      InsufficientFundsError,
    );
  });
});
