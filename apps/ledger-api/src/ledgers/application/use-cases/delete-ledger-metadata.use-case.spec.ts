import type { TenantTransaction } from '@ledger/database';
import { LedgerNotFoundError } from '../../domain/ledger-not-found.error.js';
import { Ledger } from '../../domain/ledger.entity.js';
import type { ILedgerLogWriter } from '../ports/ledger-log-writer.port.js';
import type { ILedgerRepository } from '../ports/ledger-repository.port.js';
import type { IOutboxWriter } from '../ports/outbox-writer.port.js';
import type { ITenantTransactionRunner } from '../ports/tenant-transaction-runner.port.js';
import { DeleteLedgerMetadataUseCase } from './delete-ledger-metadata.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: { env: 'prod', team: 'payments' },
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
    // Deleting metadata never creates a ledger or lists them.
    insert: vi.fn<ILedgerRepository['insert']>(),
    findByName: vi.fn<ILedgerRepository['findByName']>(),
    findByNameForUpdate: vi.fn<ILedgerRepository['findByNameForUpdate']>(async () => {
      calls.push('lock');
      return storedLedger;
    }),
    updateMetadata: vi.fn<ILedgerRepository['updateMetadata']>(async () => {
      calls.push('update');
    }),
    findPage: vi.fn<ILedgerRepository['findPage']>(),
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

  const useCase = new DeleteLedgerMetadataUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    logs,
    outbox,
  );
  return { useCase, trx, calls, transactions, ledgers, logs, outbox };
}

const input = { organizationId: ORG_ID, name: 'main', key: 'env' };

describe('DeleteLedgerMetadataUseCase', () => {
  it('runs inside the transaction of the organization', async () => {
    const { useCase, transactions } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
  });

  it('locks the ledger, saves it, then writes the log and the outbox event, in one transaction', async () => {
    const { useCase, calls } = setup();

    await useCase.execute(input);

    expect(calls).toEqual(['begin', 'lock', 'update', 'log', 'outbox', 'commit']);
  });

  it('gives the same transaction to every port', async () => {
    const { useCase, trx, ledgers, logs, outbox } = setup();

    await useCase.execute(input);

    expect(ledgers.findByNameForUpdate.mock.calls[0]?.[0]).toBe(trx);
    expect(ledgers.updateMetadata.mock.calls[0]?.[0]).toBe(trx);
    expect(logs.append.mock.calls[0]?.[0]).toBe(trx);
    expect(outbox.append.mock.calls[0]?.[0]).toBe(trx);
  });

  it('looks up the ledger by the name it was given', async () => {
    const { useCase, ledgers } = setup();

    await useCase.execute(input);

    expect(ledgers.findByNameForUpdate.mock.calls[0]?.[1]).toBe('main');
  });

  it('saves the metadata without the key and keeps the other keys', async () => {
    const { useCase, ledgers } = setup();

    await useCase.execute(input);

    const saved = ledgers.updateMetadata.mock.calls[0]![1];
    expect(saved.id).toBe(LEDGER_ID);
    expect(saved.metadata).toEqual({ team: 'payments' });
  });

  it('writes a LEDGER_METADATA_DELETED log with the key and no value', async () => {
    const { useCase, logs, trx } = setup();

    await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'LEDGER_METADATA_DELETED',
      payload: { key: 'env' },
    });
  });

  it('writes a ledger.metadata.deleted outbox event', async () => {
    const { useCase, outbox, trx } = setup();

    await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      aggregateType: 'ledger',
      aggregateId: LEDGER_ID,
      eventType: 'ledger.metadata.deleted',
      payload: { ledgerId: LEDGER_ID, organizationId: ORG_ID, name: 'main', key: 'env' },
    });
  });

  it('writes nothing when the key is not there', async () => {
    const { useCase, calls, ledgers, logs, outbox } = setup();

    await useCase.execute({ ...input, key: 'unknown' });

    expect(calls).toEqual(['begin', 'lock', 'commit']);
    expect(ledgers.updateMetadata).not.toHaveBeenCalled();
    expect(logs.append).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('throws LedgerNotFoundError when there is no such ledger, and writes nothing', async () => {
    const { useCase, ledgers, logs, outbox } = setup();
    ledgers.findByNameForUpdate.mockResolvedValueOnce(null);

    const error = await useCase.execute(input).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(LedgerNotFoundError);
    expect(error).toMatchObject({ ledgerName: 'main' });
    expect(ledgers.updateMetadata).not.toHaveBeenCalled();
    expect(logs.append).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('does not write the outbox event when the log write fails', async () => {
    const { useCase, logs, outbox } = setup();
    const failure = new Error('log write failed');
    logs.append.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('passes a repository failure through unchanged', async () => {
    const { useCase, ledgers } = setup();
    const failure = new Error('connection lost');
    ledgers.findByNameForUpdate.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
  });
});
