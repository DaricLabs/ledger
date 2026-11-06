import type { TenantTransaction } from '@ledger/database';
import { Ledger } from '../../domain/ledger.entity.js';
import type { ILedgerPage, ILedgerRepository } from '../ports/ledger-repository.port.js';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import { ListLedgersUseCase } from './list-ledgers.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';

const storedPage: ILedgerPage = {
  ledgers: [
    Ledger.reconstitute({
      id: '0190a5d4-7b3c-7abc-8def-0123456789ac',
      organizationId: ORG_ID,
      name: 'main',
      metadata: {},
      createdAt: new Date('2026-11-04T10:00:00.000Z'),
    }),
  ],
  hasMore: true,
};

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
    findByName: vi.fn<ILedgerRepository['findByName']>(),
    findByNameForUpdate: vi.fn<ILedgerRepository['findByNameForUpdate']>(),
    updateMetadata: vi.fn<ILedgerRepository['updateMetadata']>(),
    findPage: vi.fn<ILedgerRepository['findPage']>(async () => {
      calls.push('find');
      return storedPage;
    }),
  };

  const useCase = new ListLedgersUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
  );
  return { useCase, trx, calls, transactions, ledgers };
}

describe('ListLedgersUseCase', () => {
  it('returns the page the repository finds', async () => {
    const { useCase } = setup();

    await expect(useCase.execute({ organizationId: ORG_ID, pageSize: 10 })).resolves.toBe(
      storedPage,
    );
  });

  it('reads inside the transaction of the organization', async () => {
    const { useCase, transactions, calls } = setup();

    await useCase.execute({ organizationId: ORG_ID, pageSize: 10 });

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
    expect(calls).toEqual(['begin', 'find', 'commit']);
  });

  it('asks for the first page when there is no position', async () => {
    const { useCase, trx, ledgers } = setup();

    await useCase.execute({ organizationId: ORG_ID, pageSize: 10 });

    expect(ledgers.findPage).toHaveBeenCalledExactlyOnceWith(trx, {
      limit: 10,
      afterName: undefined,
    });
  });

  it('asks for the page after the given name', async () => {
    const { useCase, trx, ledgers } = setup();

    await useCase.execute({ organizationId: ORG_ID, pageSize: 5, afterName: 'main' });

    expect(ledgers.findPage).toHaveBeenCalledExactlyOnceWith(trx, {
      limit: 5,
      afterName: 'main',
    });
  });

  it('passes a repository failure through unchanged', async () => {
    const { useCase, ledgers } = setup();
    const failure = new Error('connection lost');
    ledgers.findPage.mockRejectedValueOnce(failure);

    await expect(useCase.execute({ organizationId: ORG_ID, pageSize: 10 })).rejects.toBe(failure);
  });
});
