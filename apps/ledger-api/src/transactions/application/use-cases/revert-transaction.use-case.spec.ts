import type { TenantTransaction } from '@ledger/database';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import {
  AccountBalance,
  balanceKeyText,
} from '../../../accounts/domain/entities/account-balance.entity.js';
import { InsufficientFundsError } from '../../../accounts/domain/errors/insufficient-funds.error.js';
import type { IAccountBalanceRepository } from '../../../accounts/application/ports/account-balance-repository.port.js';
import type { IIdempotencyKeyRepository } from '../../../idempotency/application/ports/idempotency-key-repository.port.js';
import { IdempotencyKeyReusedError } from '../../../idempotency/domain/errors/idempotency-key-reused.error.js';
import type { IIdGenerator } from '../../../ids/application/ports/id-generator.port.js';
import type { ILedgerLogWriter } from '../../../journal/application/ports/ledger-log-writer.port.js';
import type { IOutboxWriter } from '../../../journal/application/ports/outbox-writer.port.js';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { Ledger } from '../../../ledgers/domain/entities/ledger.entity.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { Transaction } from '../../domain/entities/transaction.entity.js';
import { TransactionAlreadyRevertedError } from '../../domain/errors/transaction-already-reverted.error.js';
import { TransactionNotFoundError } from '../../domain/errors/transaction-not-found.error.js';
import { Posting } from '../../domain/value-objects/posting.vo.js';
import { toRevertTransactionRequestHash } from '../mappers/revert-transaction-request-hash.mapper.js';
import type { ITransactionRepository } from '../ports/transaction-repository.port.js';
import { RevertTransactionUseCase } from './revert-transaction.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';
const ORIGINAL_ID = '0190a5d4-7b3c-7abc-8def-0123456789ad';
const REVERSAL_ID = '0190a5d4-7b3c-7abc-8def-0123456789ae';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: {},
  createdAt: new Date('2026-11-04T10:00:00.000Z'),
});

const usd = AssetCode.of('USD');
const posting = (source: string, destination: string, amount: bigint) =>
  Posting.of(AccountAddress.of(source), AccountAddress.of(destination), Money.of(usd, amount));

/** The transaction to revert: 1000 from world to users:1, then 25 of it to platform:fees. */
const original = (overrides: { reverted?: boolean } = {}) =>
  Transaction.reconstitute({
    id: ORIGINAL_ID,
    organizationId: ORG_ID,
    ledgerId: LEDGER_ID,
    reference: 'order-1',
    postings: [posting('world', 'users:1', 1000n), posting('users:1', 'platform:fees', 25n)],
    postedAt: new Date('2026-11-16T10:00:00.000Z'),
    createdAt: new Date('2026-11-16T10:00:00.000Z'),
    revertedAt: overrides.reverted ? new Date('2026-11-16T11:00:00.000Z') : null,
    revertedByTransactionId: overrides.reverted ? '0190a5d4-7b3c-7abc-8def-0123456789af' : null,
  });

/** What the fake database holds, by balance key text. Missing means zero. */
type Held = Record<string, bigint>;

/** The balances after the original transaction: nothing was spent since. */
const afterOriginal: Held = {
  'users:1 USD': 975n,
  'platform:fees USD': 25n,
  'world USD': -1000n,
};

function setup(held: Held = afterOriginal) {
  const trx = { marker: 'trx' } as unknown as TenantTransaction;
  const calls: string[] = [];

  const transactions = {
    run: vi.fn(
      async (_organizationId: string, work: (t: TenantTransaction) => Promise<unknown>) => {
        calls.push('begin');
        const result = await work(trx);
        calls.push('commit');
        return result;
      },
    ),
  };
  const ids = { next: vi.fn<IIdGenerator['next']>(() => REVERSAL_ID) };
  const ledgers = {
    insert: vi.fn<ILedgerRepository['insert']>(),
    findByName: vi.fn<ILedgerRepository['findByName']>(async () => {
      calls.push('find ledger');
      return storedLedger;
    }),
    findByNameForUpdate: vi.fn<ILedgerRepository['findByNameForUpdate']>(),
    updateMetadata: vi.fn<ILedgerRepository['updateMetadata']>(),
    findPage: vi.fn<ILedgerRepository['findPage']>(),
  };
  const idempotencyKeys = {
    claim: vi.fn<IIdempotencyKeyRepository['claim']>(async () => {
      calls.push('claim');
      return { replayed: false };
    }),
  };
  const balances = {
    open: vi.fn<IAccountBalanceRepository['open']>(),
    lock: vi.fn<IAccountBalanceRepository['lock']>(async (_trx, _ledgerId, keys) => {
      calls.push('lock balances');
      return keys.map((key) =>
        AccountBalance.reconstitute({
          address: key.address,
          balance: Money.of(key.asset, held[balanceKeyText(key)] ?? 0n),
          allowOverdraft: key.address.isWorld(),
        }),
      );
    }),
    save: vi.fn<IAccountBalanceRepository['save']>(async () => {
      calls.push('save balances');
    }),
  };
  const transactionRepository = {
    insert: vi.fn<ITransactionRepository['insert']>(async () => {
      calls.push('insert');
    }),
    findById: vi.fn<ITransactionRepository['findById']>(),
    lockById: vi.fn<ITransactionRepository['lockById']>(async () => {
      calls.push('lock transaction');
      return original();
    }),
    markReverted: vi.fn<ITransactionRepository['markReverted']>(async () => {
      calls.push('mark reverted');
    }),
    findPage: vi.fn<ITransactionRepository['findPage']>(),
  };
  const logs = {
    append: vi.fn<ILedgerLogWriter['append']>(async () => {
      calls.push('log');
    }),
  };
  const outbox = {
    append: vi.fn<IOutboxWriter['append']>(async () => {
      calls.push('outbox');
    }),
  };

  const useCase = new RevertTransactionUseCase(
    ids,
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    idempotencyKeys,
    balances,
    transactionRepository,
    logs,
    outbox,
  );
  return {
    useCase,
    trx,
    calls,
    transactions,
    ids,
    ledgers,
    idempotencyKeys,
    balances,
    transactionRepository,
    logs,
    outbox,
  };
}

const input = { organizationId: ORG_ID, ledgerName: 'main', transactionId: ORIGINAL_ID };

describe('RevertTransactionUseCase', () => {
  it('runs inside the transaction of the organization', async () => {
    const { useCase, transactions } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
  });

  it('does the steps in the right order, in one transaction', async () => {
    const { useCase, calls } = setup();

    await useCase.execute(input);

    // The transaction row is locked before the balances, and the journal is last.
    expect(calls).toEqual([
      'begin',
      'find ledger',
      'lock transaction',
      'lock balances',
      'save balances',
      'insert',
      'mark reverted',
      'log',
      'outbox',
      'commit',
    ]);
  });

  it('gives the same transaction to every port', async () => {
    const { useCase, trx, ledgers, balances, transactionRepository, logs, outbox } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName.mock.calls[0]?.[0]).toBe(trx);
    expect(transactionRepository.lockById.mock.calls[0]?.[0]).toBe(trx);
    expect(balances.lock.mock.calls[0]?.[0]).toBe(trx);
    expect(balances.save.mock.calls[0]?.[0]).toBe(trx);
    expect(transactionRepository.insert.mock.calls[0]?.[0]).toBe(trx);
    expect(transactionRepository.markReverted.mock.calls[0]?.[0]).toBe(trx);
    expect(logs.append.mock.calls[0]?.[0]).toBe(trx);
    expect(outbox.append.mock.calls[0]?.[0]).toBe(trx);
  });

  it('finds the ledger by name, and locks the transaction in that ledger', async () => {
    const { useCase, ledgers, transactionRepository } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName.mock.calls[0]?.[1]).toBe('main');
    expect(transactionRepository.lockById.mock.calls[0]?.slice(1)).toEqual([
      LEDGER_ID,
      ORIGINAL_ID,
    ]);
  });

  it('returns the new transaction: the postings turned around, in the opposite order', async () => {
    const { useCase } = setup();

    const { transaction, replayed } = await useCase.execute(input);

    expect(replayed).toBe(false);
    expect(transaction.id).toBe(REVERSAL_ID);
    expect(transaction.reference).toBeNull();
    expect(
      transaction.postings.map((p) => [p.source.value, p.destination.value, p.money.amount]),
    ).toEqual([
      ['platform:fees', 'users:1', 25n],
      ['users:1', 'world', 1000n],
    ]);
  });

  it('saves the new transaction, then marks the old one with it', async () => {
    const { useCase, transactionRepository, trx } = setup();

    const { transaction } = await useCase.execute(input);

    expect(transactionRepository.insert).toHaveBeenCalledExactlyOnceWith(trx, transaction);
    expect(transactionRepository.markReverted).toHaveBeenCalledExactlyOnceWith(
      trx,
      LEDGER_ID,
      ORIGINAL_ID,
      transaction,
    );
  });

  it('locks every touched balance once, in the lock order, and creates no account', async () => {
    const { useCase, balances } = setup();

    await useCase.execute(input);

    expect(balances.open).not.toHaveBeenCalled();
    expect(balances.lock.mock.calls[0]?.[2].map(balanceKeyText)).toEqual([
      'platform:fees USD',
      'users:1 USD',
      'world USD',
    ]);
  });

  it('saves the balances that the reverse postings give: every balance goes back to zero', async () => {
    const { useCase, balances } = setup();

    await useCase.execute(input);

    expect(
      balances.save.mock.calls[0]?.[2].map((b) => [balanceKeyText(b.key), b.balance.amount]),
    ).toEqual([
      ['platform:fees USD', 0n],
      ['users:1 USD', 0n],
      ['world USD', 0n],
    ]);
  });

  it('writes a TRANSACTION_REVERTED log that is about the new transaction', async () => {
    const { useCase, logs, trx } = setup();

    const { transaction } = await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'TRANSACTION_REVERTED',
      transactionId: REVERSAL_ID,
      payload: {
        revertedTransactionId: ORIGINAL_ID,
        postedAt: transaction.postedAt.toISOString(),
        postings: [
          { source: 'platform:fees', destination: 'users:1', asset: 'USD', amount: '25' },
          { source: 'users:1', destination: 'world', asset: 'USD', amount: '1000' },
        ],
      },
    });
  });

  it('writes a ledger.transaction.reverted outbox event with amounts as strings', async () => {
    const { useCase, outbox, trx } = setup();

    const { transaction } = await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      aggregateType: 'transaction',
      aggregateId: REVERSAL_ID,
      eventType: 'ledger.transaction.reverted',
      payload: {
        transactionId: REVERSAL_ID,
        revertedTransactionId: ORIGINAL_ID,
        ledgerId: LEDGER_ID,
        organizationId: ORG_ID,
        postedAt: transaction.postedAt.toISOString(),
        createdAt: transaction.createdAt.toISOString(),
        postings: [
          { source: 'platform:fees', destination: 'users:1', asset: 'USD', amount: '25' },
          { source: 'users:1', destination: 'world', asset: 'USD', amount: '1000' },
        ],
      },
    });
    // The payload must be real JSON: a bigint would throw here.
    expect(() => JSON.stringify(outbox.append.mock.calls[0]?.[1].payload)).not.toThrow();
  });

  it('returns replayed: false and does not touch the idempotency port without a key', async () => {
    const { useCase, idempotencyKeys } = setup();

    const result = await useCase.execute(input);

    expect(result.replayed).toBe(false);
    expect(idempotencyKeys.claim).not.toHaveBeenCalled();
  });

  describe('when something is wrong', () => {
    it('throws LedgerNotFoundError and writes nothing when the ledger is missing', async () => {
      const { useCase, ledgers, transactionRepository, balances } = setup();
      ledgers.findByName.mockResolvedValueOnce(null);

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(LedgerNotFoundError);

      expect(transactionRepository.lockById).not.toHaveBeenCalled();
      expect(balances.save).not.toHaveBeenCalled();
    });

    it('throws TransactionNotFoundError and writes nothing when the ledger has no such transaction', async () => {
      const { useCase, transactionRepository, balances, logs, outbox } = setup();
      transactionRepository.lockById.mockResolvedValueOnce(null);

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(TransactionNotFoundError);

      expect(balances.lock).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('throws TransactionAlreadyRevertedError and writes nothing for a transaction that was reverted', async () => {
      const { useCase, transactionRepository, balances, logs, outbox } = setup();
      transactionRepository.lockById.mockResolvedValueOnce(original({ reverted: true }));

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(TransactionAlreadyRevertedError);

      expect(balances.lock).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
      expect(transactionRepository.markReverted).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('stops before it saves anything when the money was spent since', async () => {
      // users:1 paid 900 away after the original transaction: it cannot give back 1000.
      const { useCase, calls, balances, transactionRepository, logs, outbox } = setup({
        ...afterOriginal,
        'users:1 USD': 75n,
      });

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(InsufficientFundsError);

      expect(calls).not.toContain('commit');
      expect(balances.save).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
      expect(transactionRepository.markReverted).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  describe('with an idempotency key', () => {
    const keyed = { ...input, idempotencyKey: 'key-1' };

    it('claims the key after the ledger is found and before the transaction is locked', async () => {
      const { useCase, calls } = setup();

      await useCase.execute(keyed);

      expect(calls.slice(0, 4)).toEqual(['begin', 'find ledger', 'claim', 'lock transaction']);
    });

    it('claims in the same transaction, for the ledger, with the id of the new transaction', async () => {
      const { useCase, idempotencyKeys, trx } = setup();

      const { replayed } = await useCase.execute(keyed);

      expect(replayed).toBe(false);
      expect(idempotencyKeys.claim).toHaveBeenCalledExactlyOnceWith(trx, LEDGER_ID, {
        operation: 'transactions.revert',
        key: 'key-1',
        requestHash: toRevertTransactionRequestHash({ transactionId: ORIGINAL_ID }),
        transactionId: REVERSAL_ID,
      });
    });

    it('returns the first result and writes nothing when the key was used before', async () => {
      const { useCase, idempotencyKeys, transactionRepository, balances, logs, outbox, trx } =
        setup();
      const first = original().reverse({
        id: '0190a5d4-7b3c-7abc-8def-0123456789b0',
        at: new Date('2026-11-16T12:00:00.000Z'),
      });
      idempotencyKeys.claim.mockResolvedValueOnce({ replayed: true, transactionId: first.id });
      transactionRepository.findById.mockResolvedValueOnce(first);

      const result = await useCase.execute(keyed);

      expect(result).toEqual({ transaction: first, replayed: true });
      expect(transactionRepository.findById).toHaveBeenCalledExactlyOnceWith(
        trx,
        LEDGER_ID,
        first.id,
      );
      expect(transactionRepository.lockById).not.toHaveBeenCalled();
      expect(balances.lock).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
      expect(transactionRepository.markReverted).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('passes IdempotencyKeyReusedError through and writes nothing', async () => {
      const { useCase, idempotencyKeys, transactionRepository } = setup();
      idempotencyKeys.claim.mockRejectedValueOnce(new IdempotencyKeyReusedError());

      await expect(useCase.execute(keyed)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

      expect(transactionRepository.lockById).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
    });

    it('does not claim a key for a ledger that does not exist', async () => {
      const { useCase, ledgers, idempotencyKeys } = setup();
      ledgers.findByName.mockResolvedValueOnce(null);

      await expect(useCase.execute(keyed)).rejects.toBeInstanceOf(LedgerNotFoundError);

      expect(idempotencyKeys.claim).not.toHaveBeenCalled();
    });

    it('fails without a commit when the transaction does not exist, so the key is rolled back', async () => {
      const { useCase, calls, transactionRepository } = setup();
      transactionRepository.lockById.mockResolvedValueOnce(null);

      await expect(useCase.execute(keyed)).rejects.toBeInstanceOf(TransactionNotFoundError);

      expect(calls).toContain('claim');
      expect(calls).not.toContain('commit');
    });

    it('fails loudly when a key points to a transaction that is missing', async () => {
      const { useCase, idempotencyKeys, transactionRepository } = setup();
      idempotencyKeys.claim.mockResolvedValueOnce({ replayed: true, transactionId: 'gone' });
      transactionRepository.findById.mockResolvedValueOnce(null);

      await expect(useCase.execute(keyed)).rejects.toThrow('missing transaction');
    });
  });
});
