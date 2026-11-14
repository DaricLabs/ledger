import type { TenantTransaction } from '@ledger/database';
import { Ledger } from '../../domain/entities/ledger.entity.js';
import { LedgerNotFoundError } from '../../domain/errors/ledger-not-found.error.js';
import type { ILedgerRepository } from '../ports/ledger-repository.port.js';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import { GetLedgerUseCase } from './get-ledger.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: { env: 'prod' },
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
    insert: vi.fn<ILedgerRepository['insert']>(),
    findByName: vi.fn<ILedgerRepository['findByName']>(async () => {
      calls.push('find');
      return storedLedger;
    }),
    findByNameForUpdate: vi.fn<ILedgerRepository['findByNameForUpdate']>(),
    updateMetadata: vi.fn<ILedgerRepository['updateMetadata']>(),
    findPage: vi.fn<ILedgerRepository['findPage']>(),
  };

  const useCase = new GetLedgerUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
  );
  return { useCase, trx, calls, transactions, ledgers };
}

const input = { organizationId: ORG_ID, name: 'main' };

describe('GetLedgerUseCase', () => {
  it('returns the ledger the repository finds', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(input)).resolves.toBe(storedLedger);
  });

  it('reads inside the transaction of the organization', async () => {
    const { useCase, transactions, calls } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
    expect(calls).toEqual(['begin', 'find', 'commit']);
  });

  it('gives the transaction and the name to the repository', async () => {
    const { useCase, trx, ledgers } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName).toHaveBeenCalledExactlyOnceWith(trx, 'main');
  });

  it('throws LedgerNotFoundError when there is no such ledger', async () => {
    const { useCase, ledgers } = setup();
    ledgers.findByName.mockResolvedValueOnce(null);

    const error = await useCase.execute(input).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(LedgerNotFoundError);
    expect(error).toMatchObject({ ledgerName: 'main' });
  });

  it('passes a repository failure through unchanged', async () => {
    const { useCase, ledgers } = setup();
    const failure = new Error('connection lost');
    ledgers.findByName.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
  });
});
