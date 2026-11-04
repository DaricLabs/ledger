import type { TenantTransaction } from '@ledger/database';
import type { ILedgerRepository } from '../ports/ledger-repository.port.js';
import type { ILedgerLogWriter } from '../ports/ledger-log-writer.port.js';
import type { IOutboxWriter } from '../ports/outbox-writer.port.js';
import type { ITenantTransactionRunner } from '../ports/tenant-transaction-runner.port.js';
import { InvalidLedgerNameError } from '../../domain/invalid-ledger-name.error.js';
import { CreateLedgerUseCase } from './create-ledger.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';
const NOW = new Date('2026-10-31T10:00:00.000Z');

function setup() {
  const trx = { marker: 'trx' } as unknown as TenantTransaction;
  const calls: string[] = [];

  const ids = { next: vi.fn(() => LEDGER_ID) };
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
    insert: vi.fn<ILedgerRepository['insert']>(async () => {
      calls.push('ledger');
    }),
    // Creating a ledger never reads one.
    findByName: vi.fn<ILedgerRepository['findByName']>(),
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

  const useCase = new CreateLedgerUseCase(
    ids,
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    logs,
    outbox,
  );
  return { useCase, trx, calls, ids, transactions, ledgers, logs, outbox };
}

const input = { organizationId: ORG_ID, name: 'main', metadata: { env: 'prod' } };

describe('CreateLedgerUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a ledger with the generated id and the current time', async () => {
    const { useCase } = setup();

    const ledger = await useCase.execute(input);

    expect(ledger.id).toBe(LEDGER_ID);
    expect(ledger.organizationId).toBe(ORG_ID);
    expect(ledger.name).toBe('main');
    expect(ledger.metadata).toEqual({ env: 'prod' });
    expect(ledger.createdAt).toEqual(NOW);
  });

  it('runs inside the transaction of the organization', async () => {
    const { useCase, transactions } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
  });

  it('writes the ledger, the log and the outbox event, in this order, in one transaction', async () => {
    const { useCase, calls } = setup();

    await useCase.execute(input);

    expect(calls).toEqual(['begin', 'ledger', 'log', 'outbox', 'commit']);
  });

  it('gives the same transaction to every writer', async () => {
    const { useCase, trx, ledgers, logs, outbox } = setup();

    await useCase.execute(input);

    expect(ledgers.insert.mock.calls[0]?.[0]).toBe(trx);
    expect(logs.append.mock.calls[0]?.[0]).toBe(trx);
    expect(outbox.append.mock.calls[0]?.[0]).toBe(trx);
  });

  it('saves the new ledger', async () => {
    const { useCase, ledgers } = setup();

    const ledger = await useCase.execute(input);

    expect(ledgers.insert.mock.calls[0]?.[1]).toBe(ledger);
  });

  it('writes a LEDGER_CREATED log with the name and the metadata', async () => {
    const { useCase, logs, trx } = setup();

    await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'LEDGER_CREATED',
      payload: { name: 'main', metadata: { env: 'prod' } },
    });
  });

  it('writes a ledger.created outbox event with a JSON-safe payload', async () => {
    const { useCase, outbox, trx } = setup();

    await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      aggregateType: 'ledger',
      aggregateId: LEDGER_ID,
      eventType: 'ledger.created',
      payload: {
        ledgerId: LEDGER_ID,
        organizationId: ORG_ID,
        name: 'main',
        metadata: { env: 'prod' },
        createdAt: '2026-10-31T10:00:00.000Z',
      },
    });
  });

  it('rejects an invalid ledger before it opens a transaction', async () => {
    const { useCase, transactions } = setup();

    await expect(useCase.execute({ ...input, name: 'Not Valid' })).rejects.toThrow(
      InvalidLedgerNameError,
    );
    expect(transactions.run).not.toHaveBeenCalled();
  });

  it('passes a repository error through and writes no log and no outbox event', async () => {
    const { useCase, ledgers, logs, outbox, calls } = setup();
    const failure = new Error('ledger name is taken');
    ledgers.insert.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);

    expect(logs.append).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(calls).not.toContain('commit');
  });

  it('does not write the outbox event when the log fails', async () => {
    const { useCase, logs, outbox, calls } = setup();
    logs.append.mockRejectedValueOnce(new Error('log failed'));

    await expect(useCase.execute(input)).rejects.toThrow('log failed');

    expect(outbox.append).not.toHaveBeenCalled();
    expect(calls).not.toContain('commit');
  });
});
