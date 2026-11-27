import { Metadata } from '@ledger/domain';
import type { TenantTransaction } from '@ledger/database';
import { LedgerNotFoundError } from '../../domain/errors/ledger-not-found.error.js';
import { Ledger } from '../../domain/entities/ledger.entity.js';
import type { ILedgerLogWriter } from '../../../journal/application/ports/ledger-log-writer.port.js';
import type { ILedgerRepository } from '../ports/ledger-repository.port.js';
import type { IOutboxWriter } from '../../../journal/application/ports/outbox-writer.port.js';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import { DeleteLedgerUseCase } from './delete-ledger.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LOG_SEQ = '7';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';
const NOW = new Date('2026-11-22T12:00:00.000Z');

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: Metadata.reconstitute({ env: 'prod' }),
  createdAt: new Date('2026-11-04T10:00:00.000Z'),
});

function setup() {
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
  const ledgers = {
    // Deleting a ledger never creates one, reads without a lock, or lists them.
    insert: vi.fn<ILedgerRepository['insert']>(),
    findByName: vi.fn<ILedgerRepository['findByName']>(),
    findByNameForUpdate: vi.fn<ILedgerRepository['findByNameForUpdate']>(async () => {
      calls.push('lock');
      return storedLedger;
    }),
    updateMetadata: vi.fn<ILedgerRepository['updateMetadata']>(),
    markDeleted: vi.fn<ILedgerRepository['markDeleted']>(async () => {
      calls.push('mark deleted');
    }),
    findPage: vi.fn<ILedgerRepository['findPage']>(),
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

  const useCase = new DeleteLedgerUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    logs,
    outbox,
  );
  return { useCase, trx, calls, transactions, ledgers, logs, outbox };
}

const input = { organizationId: ORG_ID, name: 'main' };

describe('DeleteLedgerUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs inside the transaction of the organization', async () => {
    const { useCase, transactions } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
  });

  it('locks the ledger, writes the log and the outbox event, then marks it deleted, in one transaction', async () => {
    const { useCase, calls } = setup();

    await useCase.execute(input);

    expect(calls).toEqual(['begin', 'lock', 'log', 'outbox', 'mark deleted', 'commit']);
  });

  it('gives the same transaction to every port', async () => {
    const { useCase, trx, ledgers, logs, outbox } = setup();

    await useCase.execute(input);

    expect(ledgers.findByNameForUpdate.mock.calls[0]?.[0]).toBe(trx);
    expect(logs.append.mock.calls[0]?.[0]).toBe(trx);
    expect(outbox.append.mock.calls[0]?.[0]).toBe(trx);
    expect(ledgers.markDeleted.mock.calls[0]?.[0]).toBe(trx);
  });

  it('looks up the ledger by the name it was given', async () => {
    const { useCase, ledgers } = setup();

    await useCase.execute(input);

    expect(ledgers.findByNameForUpdate.mock.calls[0]?.[1]).toBe('main');
  });

  it('marks the ledger it locked as deleted, with the time of the delete', async () => {
    const { useCase, trx, ledgers } = setup();

    await useCase.execute(input);

    expect(ledgers.markDeleted).toHaveBeenCalledExactlyOnceWith(trx, storedLedger, NOW);
  });

  it('writes a LEDGER_DELETED log with the name only', async () => {
    const { useCase, logs, trx } = setup();

    await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'LEDGER_DELETED',
      payload: { name: 'main' },
    });
  });

  it('writes a ledger.deleted outbox event with the time of the delete and no metadata', async () => {
    const { useCase, outbox, trx } = setup();

    await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      logSeq: LOG_SEQ,
      aggregateType: 'ledger',
      aggregateId: LEDGER_ID,
      eventType: 'ledger.deleted',
      payload: {
        ledgerId: LEDGER_ID,
        organizationId: ORG_ID,
        name: 'main',
        deletedAt: '2026-11-22T12:00:00.000Z',
      },
    });
  });

  it('throws LedgerNotFoundError when there is no live ledger, and writes nothing', async () => {
    const { useCase, ledgers, logs, outbox } = setup();
    ledgers.findByNameForUpdate.mockResolvedValueOnce(null);

    const error = await useCase.execute(input).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(LedgerNotFoundError);
    expect(error).toMatchObject({ ledgerName: 'main' });
    expect(logs.append).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(ledgers.markDeleted).not.toHaveBeenCalled();
  });

  it('does not write the outbox event or mark the ledger when the log write fails', async () => {
    const { useCase, logs, outbox, ledgers } = setup();
    const failure = new Error('log write failed');
    logs.append.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
    expect(outbox.append).not.toHaveBeenCalled();
    expect(ledgers.markDeleted).not.toHaveBeenCalled();
  });

  it('does not mark the ledger when the outbox write fails', async () => {
    const { useCase, outbox, ledgers } = setup();
    const failure = new Error('outbox write failed');
    outbox.append.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
    expect(ledgers.markDeleted).not.toHaveBeenCalled();
  });

  it('passes a failure of markDeleted through unchanged', async () => {
    const { useCase, ledgers } = setup();
    const failure = new Error('connection lost');
    ledgers.markDeleted.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
  });

  it('passes a repository failure through unchanged', async () => {
    const { useCase, ledgers } = setup();
    const failure = new Error('connection lost');
    ledgers.findByNameForUpdate.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
  });
});
