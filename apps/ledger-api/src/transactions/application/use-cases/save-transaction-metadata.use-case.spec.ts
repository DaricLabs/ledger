import type { TenantTransaction } from '@ledger/database';
import {
  AccountAddress,
  AssetCode,
  InvalidMetadataError,
  Metadata,
  MetadataLimitExceededError,
  Money,
} from '@ledger/domain';
import type { ILedgerLogWriter } from '../../../journal/application/ports/ledger-log-writer.port.js';
import type { IOutboxWriter } from '../../../journal/application/ports/outbox-writer.port.js';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { Ledger } from '../../../ledgers/domain/entities/ledger.entity.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { Transaction } from '../../domain/entities/transaction.entity.js';
import { TransactionNotFoundError } from '../../domain/errors/transaction-not-found.error.js';
import { Posting } from '../../domain/value-objects/posting.vo.js';
import type { ITransactionRepository } from '../ports/transaction-repository.port.js';
import { SaveTransactionMetadataUseCase } from './save-transaction-metadata.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LOG_SEQ = '7';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';
const TRANSACTION_ID = '0190a5d4-7b3c-7abc-8def-0123456789ad';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: Metadata.empty(),
  createdAt: new Date('2026-11-04T10:00:00.000Z'),
});

const stored = (entries: Record<string, string>, overrides: { reverted?: boolean } = {}) =>
  Transaction.reconstitute({
    id: TRANSACTION_ID,
    organizationId: ORG_ID,
    ledgerId: LEDGER_ID,
    reference: 'order-1',
    postings: [
      Posting.of(
        AccountAddress.of('world'),
        AccountAddress.of('users:1'),
        Money.of(AssetCode.of('USD'), 100n),
      ),
    ],
    metadata: Metadata.of(entries),
    postedAt: new Date('2026-11-16T10:00:00.000Z'),
    createdAt: new Date('2026-11-16T10:00:00.000Z'),
    revertedAt: overrides.reverted ? new Date('2026-11-16T11:00:00.000Z') : null,
    revertedByTransactionId: overrides.reverted ? '0190a5d4-7b3c-7abc-8def-0123456789ae' : null,
  });

function setup(transaction: Transaction | null = stored({ orderId: '42', note: 'old' })) {
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
  const transactionRepository = {
    insert: vi.fn<ITransactionRepository['insert']>(),
    findById: vi.fn<ITransactionRepository['findById']>(),
    lockById: vi.fn<ITransactionRepository['lockById']>(async () => {
      calls.push('lock transaction');
      return transaction;
    }),
    markReverted: vi.fn<ITransactionRepository['markReverted']>(),
    updateMetadata: vi.fn<ITransactionRepository['updateMetadata']>(async () => {
      calls.push('update metadata');
    }),
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

  const useCase = new SaveTransactionMetadataUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    transactionRepository,
    logs,
    outbox,
  );
  return { useCase, trx, calls, transactions, ledgers, transactionRepository, logs, outbox };
}

const input = {
  organizationId: ORG_ID,
  ledgerName: 'main',
  transactionId: TRANSACTION_ID,
  metadata: { note: 'new', channel: 'web' },
};

describe('SaveTransactionMetadataUseCase', () => {
  it('runs inside the transaction of the organization', async () => {
    const { useCase, transactions } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
  });

  it('does the steps in the right order, in one transaction', async () => {
    const { useCase, calls } = setup();

    await useCase.execute(input);

    expect(calls).toEqual([
      'begin',
      'find ledger',
      'lock transaction',
      'update metadata',
      'log',
      'outbox',
      'commit',
    ]);
  });

  it('finds the ledger by name and locks the transaction of that ledger', async () => {
    const { useCase, ledgers, transactionRepository, trx } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName).toHaveBeenCalledExactlyOnceWith(trx, 'main');
    expect(transactionRepository.lockById).toHaveBeenCalledExactlyOnceWith(
      trx,
      LEDGER_ID,
      TRANSACTION_ID,
    );
  });

  it('saves the old keys with the new ones: new keys are added, and a key that is there is replaced', async () => {
    const { useCase, transactionRepository, trx } = setup();

    await useCase.execute(input);

    expect(transactionRepository.updateMetadata).toHaveBeenCalledOnce();
    const [calledTrx, saved] = transactionRepository.updateMetadata.mock.calls[0]!;
    expect(calledTrx).toBe(trx);
    expect(saved.id).toBe(TRANSACTION_ID);
    expect(saved.metadata.entries).toEqual({ orderId: '42', note: 'new', channel: 'web' });
  });

  it('writes a TRANSACTION_METADATA_SAVED journal entry that is about the transaction', async () => {
    const { useCase, logs, trx } = setup();

    await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'TRANSACTION_METADATA_SAVED',
      transactionId: TRANSACTION_ID,
      payload: { transactionId: TRANSACTION_ID, metadata: { note: 'new', channel: 'web' } },
    });
  });

  it('writes a ledger.transaction.metadata.saved outbox event', async () => {
    const { useCase, outbox, trx } = setup();

    await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      logSeq: LOG_SEQ,
      aggregateType: 'transaction',
      aggregateId: TRANSACTION_ID,
      eventType: 'ledger.transaction.metadata.saved',
      payload: {
        transactionId: TRANSACTION_ID,
        ledgerId: LEDGER_ID,
        organizationId: ORG_ID,
        metadata: { note: 'new', channel: 'web' },
      },
    });
  });

  it('records only the keys that changed', async () => {
    const { useCase, logs, outbox } = setup();

    // `orderId` already has this value, so it is not a change.
    await useCase.execute({ ...input, metadata: { orderId: '42', note: 'new' } });

    expect(logs.append.mock.calls[0]?.[1].payload).toEqual({
      transactionId: TRANSACTION_ID,
      metadata: { note: 'new' },
    });
    expect(outbox.append.mock.calls[0]?.[1].payload).toMatchObject({ metadata: { note: 'new' } });
  });

  it('saves, logs and publishes nothing when every key already has this value', async () => {
    const { useCase, transactionRepository, logs, outbox, calls } = setup();

    await useCase.execute({ ...input, metadata: { orderId: '42', note: 'old' } });

    expect(transactionRepository.updateMetadata).not.toHaveBeenCalled();
    expect(logs.append).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(calls).toEqual(['begin', 'find ledger', 'lock transaction', 'commit']);
  });

  it('works on a reverted transaction too', async () => {
    const { useCase, transactionRepository } = setup(stored({}, { reverted: true }));

    await useCase.execute(input);

    const saved = transactionRepository.updateMetadata.mock.calls[0]?.[1];
    expect(saved?.isReverted).toBe(true);
    expect(saved?.metadata.entries).toEqual({ note: 'new', channel: 'web' });
  });

  it('saves, logs and publishes the same metadata, even if the caller changes its object while we wait', async () => {
    const { useCase, transactionRepository, logs, outbox } = setup();
    const metadata: Record<string, string> = { note: 'new' };
    transactionRepository.lockById.mockImplementationOnce(async () => {
      metadata['note'] = 'changed';
      metadata['extra'] = 'added';
      return stored({ orderId: '42', note: 'old' });
    });

    await useCase.execute({ ...input, metadata });

    expect(transactionRepository.updateMetadata.mock.calls[0]?.[1].metadata.entries).toEqual({
      orderId: '42',
      note: 'new',
    });
    expect(logs.append.mock.calls[0]?.[1].payload).toEqual({
      transactionId: TRANSACTION_ID,
      metadata: { note: 'new' },
    });
    expect(outbox.append.mock.calls[0]?.[1].payload).toMatchObject({ metadata: { note: 'new' } });
  });

  describe('when something is wrong', () => {
    it('throws LedgerNotFoundError and goes no further when the ledger is missing', async () => {
      const { useCase, ledgers, transactionRepository, logs, outbox } = setup();
      ledgers.findByName.mockResolvedValueOnce(null);

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(LedgerNotFoundError);

      expect(transactionRepository.lockById).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('throws TransactionNotFoundError and writes nothing when the transaction is missing', async () => {
      const { useCase, transactionRepository, logs, outbox, calls } = setup(null);

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(TransactionNotFoundError);

      expect(transactionRepository.updateMetadata).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
      expect(calls).not.toContain('commit');
    });

    it('lets the domain refuse an empty key before it opens a transaction, and writes nothing', async () => {
      const { useCase, transactions, transactionRepository, logs, outbox } = setup();

      await expect(useCase.execute({ ...input, metadata: { '': 'x' } })).rejects.toBeInstanceOf(
        InvalidMetadataError,
      );

      expect(transactions.run).not.toHaveBeenCalled();
      expect(transactionRepository.updateMetadata).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('checks the size on the stored metadata, so many small saves cannot pass the limits', async () => {
      const full = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, 'v']));
      const { useCase, transactionRepository, logs } = setup(stored(full));

      await expect(
        useCase.execute({ ...input, metadata: { oneMore: 'x' } }),
      ).rejects.toBeInstanceOf(MetadataLimitExceededError);

      expect(transactionRepository.updateMetadata).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
    });

    it('does not hide a failure of the journal', async () => {
      const { useCase, logs, outbox, calls } = setup();
      logs.append.mockRejectedValueOnce(new Error('journal is down'));

      await expect(useCase.execute(input)).rejects.toThrow('journal is down');

      expect(outbox.append).not.toHaveBeenCalled();
      expect(calls).not.toContain('commit');
    });
  });
});
