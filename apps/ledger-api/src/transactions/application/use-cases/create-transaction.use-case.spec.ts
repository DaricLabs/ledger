import type { TenantTransaction } from '@ledger/database';
import { InvalidAccountAddressError, Money } from '@ledger/domain';
import type { IIdGenerator } from '../../../ids/application/ports/id-generator.port.js';
import type { ILedgerLogWriter } from '../../../journal/application/ports/ledger-log-writer.port.js';
import type { IOutboxWriter } from '../../../journal/application/ports/outbox-writer.port.js';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { Ledger } from '../../../ledgers/domain/entities/ledger.entity.js';
import { AccountBalance, balanceKeyText } from '../../../accounts/domain/account-balance.js';
import { InsufficientFundsError } from '../../../accounts/domain/insufficient-funds.error.js';
import { InvalidPostingError } from '../../domain/invalid-posting.error.js';
import { InvalidTransactionError } from '../../domain/invalid-transaction.error.js';
import { TransactionReferenceAlreadyExistsError } from '../../domain/transaction-reference-already-exists.error.js';
import type { IAccountBalanceRepository } from '../../../accounts/application/ports/account-balance-repository.port.js';
import type { ITransactionRepository } from '../ports/transaction-repository.port.js';
import { CreateTransactionUseCase } from './create-transaction.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';
const TRANSACTION_ID = '0190a5d4-7b3c-7abc-8def-0123456789ad';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: {},
  createdAt: new Date('2026-11-04T10:00:00.000Z'),
});

/** What the fake database holds, by balance key text. Missing means zero. */
type Held = Record<string, bigint>;

function setup(held: Held = {}) {
  const trx = { marker: 'trx' } as unknown as TenantTransaction;
  const calls: string[] = [];

  const transactions = {
    // Like the real runner: hand the transaction to the work and return its result.
    run: vi.fn(
      async (_organizationId: string, work: (t: TenantTransaction) => Promise<unknown>) => {
        calls.push('begin');
        const result = await work(trx);
        calls.push('commit');
        return result;
      },
    ),
  };
  const ids = { next: vi.fn<IIdGenerator['next']>(() => TRANSACTION_ID) };
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
  const balances = {
    open: vi.fn<IAccountBalanceRepository['open']>(async () => {
      calls.push('open');
    }),
    // The fake database gives the amounts of `held`, and world may go below zero.
    lock: vi.fn<IAccountBalanceRepository['lock']>(async (_trx, _ledgerId, keys) => {
      calls.push('lock');
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

  const useCase = new CreateTransactionUseCase(
    ids,
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
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
    balances,
    transactionRepository,
    logs,
    outbox,
  };
}

const posting = (source: string, destination: string, amount: bigint, asset = 'USD') => ({
  source,
  destination,
  asset,
  amount,
});

const input = {
  organizationId: ORG_ID,
  ledgerName: 'main',
  reference: 'order-1',
  postings: [posting('world', 'users:1', 1000n), posting('users:1', 'platform:fees', 25n)],
};

describe('CreateTransactionUseCase', () => {
  it('runs inside the transaction of the organization', async () => {
    const { useCase, transactions } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
  });

  it('does the steps in the right order, in one transaction', async () => {
    const { useCase, calls } = setup();

    await useCase.execute(input);

    // The journal is last, so the ledger lock it takes is held for the shortest time.
    expect(calls).toEqual([
      'begin',
      'find ledger',
      'open',
      'lock',
      'save balances',
      'insert',
      'log',
      'outbox',
      'commit',
    ]);
  });

  it('gives the same transaction to every port', async () => {
    const { useCase, trx, ledgers, balances, transactionRepository, logs, outbox } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName.mock.calls[0]?.[0]).toBe(trx);
    expect(balances.open.mock.calls[0]?.[0]).toBe(trx);
    expect(balances.lock.mock.calls[0]?.[0]).toBe(trx);
    expect(balances.save.mock.calls[0]?.[0]).toBe(trx);
    expect(transactionRepository.insert.mock.calls[0]?.[0]).toBe(trx);
    expect(logs.append.mock.calls[0]?.[0]).toBe(trx);
    expect(outbox.append.mock.calls[0]?.[0]).toBe(trx);
  });

  it('finds the ledger by the name it was given', async () => {
    const { useCase, ledgers } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName.mock.calls[0]?.[1]).toBe('main');
  });

  it('returns the transaction it saved', async () => {
    const { useCase, transactionRepository } = setup();

    const transaction = await useCase.execute(input);

    expect(transactionRepository.insert.mock.calls[0]?.[1]).toBe(transaction);
    expect(transaction.id).toBe(TRANSACTION_ID);
    expect(transaction.organizationId).toBe(ORG_ID);
    expect(transaction.ledgerId).toBe(LEDGER_ID);
    expect(transaction.reference).toBe('order-1');
    expect(
      transaction.postings.map((p) => [p.source.value, p.destination.value, p.money.amount]),
    ).toEqual([
      ['world', 'users:1', 1000n],
      ['users:1', 'platform:fees', 25n],
    ]);
    expect(transaction.postedAt).toEqual(transaction.createdAt);
  });

  it('uses no reference when none is given', async () => {
    const { useCase } = setup();

    const transaction = await useCase.execute({ ...input, reference: undefined });

    expect(transaction.reference).toBeNull();
  });

  it('opens and locks every touched balance, once, in the lock order', async () => {
    const { useCase, balances } = setup();

    await useCase.execute(input);

    const opened = balances.open.mock.calls[0]!;
    expect(opened[1]).toBe(LEDGER_ID);
    expect(opened[2].map((b) => [balanceKeyText(b.key), b.balance.isZero()])).toEqual([
      ['platform:fees USD', true],
      ['users:1 USD', true],
      ['world USD', true],
    ]);
    const locked = balances.lock.mock.calls[0]!;
    expect(locked[1]).toBe(LEDGER_ID);
    expect(locked[2].map(balanceKeyText)).toEqual([
      'platform:fees USD',
      'users:1 USD',
      'world USD',
    ]);
  });

  it('saves the balances that the postings give', async () => {
    const { useCase, balances } = setup({ 'users:1 USD': 500n });

    await useCase.execute(input);

    const saved = balances.save.mock.calls[0]!;
    expect(saved[1]).toBe(LEDGER_ID);
    expect(saved[2].map((b) => [balanceKeyText(b.key), b.balance.amount])).toEqual([
      ['platform:fees USD', 25n],
      ['users:1 USD', 1475n],
      ['world USD', -1000n],
    ]);
  });

  it('writes a TRANSACTION_CREATED log that is about the transaction', async () => {
    const { useCase, logs, trx } = setup();

    const transaction = await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'TRANSACTION_CREATED',
      transactionId: TRANSACTION_ID,
      payload: {
        reference: 'order-1',
        postedAt: transaction.postedAt.toISOString(),
        postings: [
          { source: 'world', destination: 'users:1', asset: 'USD', amount: '1000' },
          { source: 'users:1', destination: 'platform:fees', asset: 'USD', amount: '25' },
        ],
      },
    });
  });

  it('writes a ledger.transaction.created outbox event with amounts as strings', async () => {
    const { useCase, outbox, trx } = setup();

    const transaction = await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      aggregateType: 'transaction',
      aggregateId: TRANSACTION_ID,
      eventType: 'ledger.transaction.created',
      payload: {
        transactionId: TRANSACTION_ID,
        ledgerId: LEDGER_ID,
        organizationId: ORG_ID,
        reference: 'order-1',
        postedAt: transaction.postedAt.toISOString(),
        createdAt: transaction.createdAt.toISOString(),
        postings: [
          { source: 'world', destination: 'users:1', asset: 'USD', amount: '1000' },
          { source: 'users:1', destination: 'platform:fees', asset: 'USD', amount: '25' },
        ],
      },
    });
    // The payload must be real JSON: a bigint would throw here.
    expect(() => JSON.stringify(outbox.append.mock.calls[0]?.[1].payload)).not.toThrow();
  });

  describe('when something is wrong', () => {
    it('throws LedgerNotFoundError and writes nothing when the ledger is missing', async () => {
      const { useCase, ledgers, balances, transactionRepository, logs, outbox } = setup();
      ledgers.findByName.mockResolvedValueOnce(null);

      await expect(useCase.execute(input)).rejects.toThrow(new LedgerNotFoundError('main'));

      expect(balances.open).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('checks the postings before it opens a transaction', async () => {
      const { useCase, transactions } = setup();

      await expect(
        useCase.execute({ ...input, postings: [posting('world', 'world', 1n)] }),
      ).rejects.toBeInstanceOf(InvalidPostingError);
      await expect(
        useCase.execute({ ...input, postings: [posting('world', 'Not Valid', 1n)] }),
      ).rejects.toBeInstanceOf(InvalidAccountAddressError);
      await expect(
        useCase.execute({ ...input, postings: [posting('world', 'a', 0n)] }),
      ).rejects.toBeInstanceOf(InvalidPostingError);
      await expect(
        useCase.execute({ ...input, postings: [posting('world', 'a', 1n, 'usd')] }),
      ).rejects.toMatchObject({ code: 'INVALID_ASSET_CODE' });

      expect(transactions.run).not.toHaveBeenCalled();
    });

    it('lets the domain refuse a transaction with no postings', async () => {
      const { useCase, balances } = setup();

      await expect(useCase.execute({ ...input, postings: [] })).rejects.toBeInstanceOf(
        InvalidTransactionError,
      );

      expect(balances.open).not.toHaveBeenCalled();
    });

    it('stops before it saves anything when an account has not enough money', async () => {
      const { useCase, calls, balances, transactionRepository, logs, outbox } = setup({
        'users:1 USD': 10n,
      });

      await expect(
        useCase.execute({ ...input, postings: [posting('users:1', 'users:2', 11n)] }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);

      expect(balances.save).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
      expect(calls).not.toContain('commit');
    });

    it('does not hide a duplicate reference, and writes no log or event', async () => {
      const { useCase, transactionRepository, logs, outbox } = setup();
      transactionRepository.insert.mockRejectedValueOnce(
        new TransactionReferenceAlreadyExistsError('order-1'),
      );

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(
        TransactionReferenceAlreadyExistsError,
      );

      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });
});
