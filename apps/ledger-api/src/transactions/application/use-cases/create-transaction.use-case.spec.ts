import type { TenantTransaction } from '@ledger/database';
import {
  AccountAddress,
  AssetCode,
  InvalidAccountAddressError,
  InvalidMetadataError,
  Metadata,
  MetadataLimitExceededError,
  Money,
} from '@ledger/domain';
import { IdempotencyKeyReusedError } from '../../../idempotency/domain/errors/idempotency-key-reused.error.js';
import type { IIdempotencyKeyRepository } from '../../../idempotency/application/ports/idempotency-key-repository.port.js';
import type { IIdGenerator } from '../../../ids/application/ports/id-generator.port.js';
import type { ILedgerLogWriter } from '../../../journal/application/ports/ledger-log-writer.port.js';
import type { IOutboxWriter } from '../../../journal/application/ports/outbox-writer.port.js';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { Ledger } from '../../../ledgers/domain/entities/ledger.entity.js';
import {
  AccountBalance,
  balanceKeyText,
} from '../../../accounts/domain/entities/account-balance.entity.js';
import { InsufficientFundsError } from '../../../accounts/domain/errors/insufficient-funds.error.js';
import { Transaction } from '../../domain/entities/transaction.entity.js';
import { Posting } from '../../domain/value-objects/posting.vo.js';
import { toCreateTransactionRequestHash } from '../mappers/create-transaction-request-hash.mapper.js';
import { InvalidPostingError } from '../../domain/errors/invalid-posting.error.js';
import { InvalidTransactionError } from '../../domain/errors/invalid-transaction.error.js';
import { TransactionReferenceAlreadyExistsError } from '../../domain/errors/transaction-reference-already-exists.error.js';
import type { IAccountBalanceRepository } from '../../../accounts/application/ports/account-balance-repository.port.js';
import type { ITransactionRepository } from '../ports/transaction-repository.port.js';
import { CreateTransactionUseCase } from './create-transaction.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LOG_SEQ = '7';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';
const TRANSACTION_ID = '0190a5d4-7b3c-7abc-8def-0123456789ad';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: Metadata.reconstitute({}),
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
    markDeleted: vi.fn<ILedgerRepository['markDeleted']>(),
    findPage: vi.fn<ILedgerRepository['findPage']>(),
  };
  const idempotencyKeys = {
    // A new key by default: the work goes on.
    claim: vi.fn<IIdempotencyKeyRepository['claim']>(async () => {
      calls.push('claim');
      return { replayed: false };
    }),
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
    lockById: vi.fn<ITransactionRepository['lockById']>(),
    markReverted: vi.fn<ITransactionRepository['markReverted']>(),
    updateMetadata: vi.fn<ITransactionRepository['updateMetadata']>(),
    findPage: vi.fn<ITransactionRepository['findPage']>(),
  };
  const logs = {
    append: vi.fn<ILedgerLogWriter['append']>(async () => {
      calls.push('log');
      return LOG_SEQ;
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

    const { transaction } = await useCase.execute(input);

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

    const { transaction } = await useCase.execute({ ...input, reference: undefined });

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

    const { transaction } = await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'TRANSACTION_CREATED',
      transactionId: TRANSACTION_ID,
      payload: {
        reference: 'order-1',
        metadata: {},
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

    const { transaction } = await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      logSeq: LOG_SEQ,
      aggregateType: 'transaction',
      aggregateId: TRANSACTION_ID,
      eventType: 'ledger.transaction.created',
      payload: {
        transactionId: TRANSACTION_ID,
        ledgerId: LEDGER_ID,
        organizationId: ORG_ID,
        reference: 'order-1',
        metadata: {},
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

  it('returns replayed: false and does not touch the idempotency port without a key', async () => {
    const { useCase, idempotencyKeys } = setup();

    const result = await useCase.execute(input);

    expect(result.replayed).toBe(false);
    expect(idempotencyKeys.claim).not.toHaveBeenCalled();
  });

  describe('metadata', () => {
    const withMetadata = { ...input, metadata: { orderId: '42', channel: 'web' } };

    it('saves the metadata with the transaction', async () => {
      const { useCase, transactionRepository } = setup();

      const { transaction } = await useCase.execute(withMetadata);

      expect(transaction.metadata.entries).toEqual({ orderId: '42', channel: 'web' });
      expect(transactionRepository.insert.mock.calls[0]?.[1].metadata.entries).toEqual({
        orderId: '42',
        channel: 'web',
      });
    });

    it('uses no metadata when none is given', async () => {
      const { useCase } = setup();

      const { transaction } = await useCase.execute(input);

      expect(transaction.metadata.size).toBe(0);
    });

    it('puts the metadata in the journal entry and in the outbox event', async () => {
      const { useCase, logs, outbox } = setup();

      await useCase.execute(withMetadata);

      expect(logs.append.mock.calls[0]?.[1].payload).toMatchObject({
        metadata: { orderId: '42', channel: 'web' },
      });
      expect(outbox.append.mock.calls[0]?.[1].payload).toMatchObject({
        metadata: { orderId: '42', channel: 'web' },
      });
    });

    it('is not changed by changes the caller makes to its object while we wait for the database', async () => {
      const { useCase, balances } = setup();
      const entries: Record<string, string> = { orderId: '42' };
      balances.open.mockImplementationOnce(async () => {
        entries['orderId'] = 'changed';
      });

      const { transaction } = await useCase.execute({ ...input, metadata: entries });

      expect(transaction.metadata.entries).toEqual({ orderId: '42' });
    });

    it('checks the metadata before it opens a transaction', async () => {
      const { useCase, transactions, ledgers } = setup();

      await expect(useCase.execute({ ...input, metadata: { '': 'x' } })).rejects.toBeInstanceOf(
        InvalidMetadataError,
      );
      await expect(
        useCase.execute({ ...input, metadata: { k: 'x'.repeat(16 * 1024 + 1) } }),
      ).rejects.toBeInstanceOf(MetadataLimitExceededError);

      expect(transactions.run).not.toHaveBeenCalled();
      expect(ledgers.findByName).not.toHaveBeenCalled();
    });
  });

  describe('with an idempotency key', () => {
    const keyed = { ...input, idempotencyKey: 'key-1' };

    it('claims the key after the ledger is found and before any money moves', async () => {
      const { useCase, calls } = setup();

      await useCase.execute(keyed);

      expect(calls).toEqual([
        'begin',
        'find ledger',
        'claim',
        'open',
        'lock',
        'save balances',
        'insert',
        'log',
        'outbox',
        'commit',
      ]);
    });

    it('claims in the same transaction, for the ledger, with the id of the new transaction', async () => {
      const { useCase, idempotencyKeys, trx } = setup();

      const { transaction, replayed } = await useCase.execute(keyed);

      expect(replayed).toBe(false);
      expect(transaction.id).toBe(TRANSACTION_ID);
      expect(idempotencyKeys.claim).toHaveBeenCalledExactlyOnceWith(trx, LEDGER_ID, {
        operation: 'transactions.create',
        key: 'key-1',
        requestHash: toCreateTransactionRequestHash(input),
        transactionId: TRANSACTION_ID,
      });
    });

    it('returns the first transaction and writes nothing when the key was used before', async () => {
      const { useCase, idempotencyKeys, ids, balances, transactionRepository, logs, outbox, trx } =
        setup();
      const first = Transaction.create({
        id: '0190a5d4-7b3c-7abc-8def-0123456789ae',
        organizationId: ORG_ID,
        ledgerId: LEDGER_ID,
        reference: 'order-1',
        postings: [
          Posting.of(
            AccountAddress.of('world'),
            AccountAddress.of('users:1'),
            Money.of(AssetCode.of('USD'), 5n),
          ),
        ],
        metadata: Metadata.empty(),
        postedAt: new Date('2026-11-16T10:00:00.000Z'),
        createdAt: new Date('2026-11-16T10:00:00.000Z'),
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
      expect(ids.next).toHaveBeenCalledTimes(1); // only the id that the claim carried
      expect(balances.open).not.toHaveBeenCalled();
      expect(balances.save).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('answers a replay with the transaction as it was created, even if it was reverted since', async () => {
      const { useCase, idempotencyKeys, transactionRepository } = setup();
      const reverted = Transaction.reconstitute({
        id: '0190a5d4-7b3c-7abc-8def-0123456789b1',
        organizationId: ORG_ID,
        ledgerId: LEDGER_ID,
        reference: null,
        postings: [
          Posting.of(
            AccountAddress.of('world'),
            AccountAddress.of('users:1'),
            Money.of(AssetCode.of('USD'), 5n),
          ),
        ],
        metadata: Metadata.empty(),
        postedAt: new Date('2026-11-16T10:00:00.000Z'),
        createdAt: new Date('2026-11-16T10:00:00.000Z'),
        revertedAt: new Date('2026-11-16T11:00:00.000Z'),
        revertedByTransactionId: '0190a5d4-7b3c-7abc-8def-0123456789b2',
      });
      idempotencyKeys.claim.mockResolvedValueOnce({ replayed: true, transactionId: reverted.id });
      transactionRepository.findById.mockResolvedValueOnce(reverted);

      const { transaction, replayed } = await useCase.execute(keyed);

      expect(replayed).toBe(true);
      expect(transaction.id).toBe(reverted.id);
      expect(transaction.isReverted).toBe(false);
      expect(transaction.revertedAt).toBeNull();
    });

    it('puts the metadata in the request hash, so the same key with other metadata is another request', async () => {
      const { useCase, idempotencyKeys } = setup();

      await useCase.execute({ ...keyed, metadata: { orderId: '42' } });
      await useCase.execute(keyed);

      const [withMetadata, without] = idempotencyKeys.claim.mock.calls.map(
        (call) => call[2].requestHash,
      );
      expect(withMetadata).toEqual(
        toCreateTransactionRequestHash({ ...input, metadata: { orderId: '42' } }),
      );
      expect(without).toEqual(toCreateTransactionRequestHash(input));
      expect(withMetadata).not.toEqual(without);
    });

    it('answers a replay with the metadata of the request, even if it was edited since', async () => {
      const { useCase, idempotencyKeys, transactionRepository } = setup();
      const edited = Transaction.reconstitute({
        id: '0190a5d4-7b3c-7abc-8def-0123456789b4',
        organizationId: ORG_ID,
        ledgerId: LEDGER_ID,
        reference: 'order-1',
        postings: [
          Posting.of(
            AccountAddress.of('world'),
            AccountAddress.of('users:1'),
            Money.of(AssetCode.of('USD'), 5n),
          ),
        ],
        metadata: Metadata.of({ orderId: '42', note: 'added after the first call' }),
        postedAt: new Date('2026-11-16T10:00:00.000Z'),
        createdAt: new Date('2026-11-16T10:00:00.000Z'),
        revertedAt: null,
        revertedByTransactionId: null,
      });
      idempotencyKeys.claim.mockResolvedValueOnce({ replayed: true, transactionId: edited.id });
      transactionRepository.findById.mockResolvedValueOnce(edited);

      const { transaction, replayed } = await useCase.execute({
        ...keyed,
        metadata: { orderId: '42' },
      });

      expect(replayed).toBe(true);
      expect(transaction.id).toBe(edited.id);
      expect(transaction.metadata.entries).toEqual({ orderId: '42' });
    });

    it('passes IdempotencyKeyReusedError through and writes nothing', async () => {
      const { useCase, idempotencyKeys, balances, transactionRepository } = setup();
      idempotencyKeys.claim.mockRejectedValueOnce(new IdempotencyKeyReusedError());

      await expect(useCase.execute(keyed)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

      expect(balances.open).not.toHaveBeenCalled();
      expect(transactionRepository.insert).not.toHaveBeenCalled();
    });

    it('does not claim a key for a ledger that does not exist', async () => {
      const { useCase, ledgers, idempotencyKeys } = setup();
      ledgers.findByName.mockResolvedValueOnce(null);

      await expect(useCase.execute(keyed)).rejects.toBeInstanceOf(LedgerNotFoundError);

      expect(idempotencyKeys.claim).not.toHaveBeenCalled();
    });

    it('does not claim a key, or open a transaction, for invalid postings', async () => {
      const { useCase, transactions, idempotencyKeys } = setup();

      await expect(
        useCase.execute({ ...keyed, postings: [posting('world', 'world', 1n)] }),
      ).rejects.toBeInstanceOf(InvalidPostingError);

      expect(transactions.run).not.toHaveBeenCalled();
      expect(idempotencyKeys.claim).not.toHaveBeenCalled();
    });

    it('fails without a commit when the money is missing, so the key is rolled back', async () => {
      const { useCase, calls } = setup({ 'users:1 USD': 10n });

      await expect(
        useCase.execute({
          ...keyed,
          postings: [posting('users:1', 'users:2', 11n)],
        }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);

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
