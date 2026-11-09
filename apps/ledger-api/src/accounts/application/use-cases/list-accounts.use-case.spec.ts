import type { TenantTransaction } from '@ledger/database';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/ledger-not-found.error.js';
import { Ledger } from '../../../ledgers/domain/ledger.entity.js';
import { Account } from '../../domain/account.entity.js';
import type { IAccountPage, IAccountRepository } from '../ports/account-repository.port.js';
import { ListAccountsUseCase } from './list-accounts.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: {},
  createdAt: new Date('2026-11-09T10:00:00.000Z'),
});

const storedPage: IAccountPage = {
  accounts: [
    Account.reconstitute({
      address: AccountAddress.of('users:1'),
      allowOverdraft: false,
      createdAt: new Date('2026-11-09T10:00:01.000Z'),
      balances: [Money.of(AssetCode.of('USD'), 100n)],
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
    findByName: vi.fn<ILedgerRepository['findByName']>(async () => {
      calls.push('find ledger');
      return storedLedger;
    }),
    findByNameForUpdate: vi.fn<ILedgerRepository['findByNameForUpdate']>(),
    updateMetadata: vi.fn<ILedgerRepository['updateMetadata']>(),
    findPage: vi.fn<ILedgerRepository['findPage']>(),
  };
  const accounts = {
    findByAddress: vi.fn<IAccountRepository['findByAddress']>(),
    findPage: vi.fn<IAccountRepository['findPage']>(async () => {
      calls.push('find page');
      return storedPage;
    }),
  };

  const useCase = new ListAccountsUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    accounts,
  );
  return { useCase, trx, calls, transactions, ledgers, accounts };
}

const input = { organizationId: ORG_ID, ledgerName: 'main', pageSize: 10 };

describe('ListAccountsUseCase', () => {
  it('returns the page the repository finds', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(input)).resolves.toBe(storedPage);
  });

  it('reads inside the transaction of the organization, the ledger first', async () => {
    const { useCase, transactions, calls } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
    expect(calls).toEqual(['begin', 'find ledger', 'find page', 'commit']);
  });

  it('asks for the first page of the ledger that has the given name when there is no position', async () => {
    const { useCase, trx, ledgers, accounts } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName).toHaveBeenCalledExactlyOnceWith(trx, 'main');
    expect(accounts.findPage).toHaveBeenCalledExactlyOnceWith(trx, LEDGER_ID, {
      limit: 10,
      afterAddress: undefined,
    });
  });

  it('asks for the page after the given address', async () => {
    const { useCase, trx, accounts } = setup();

    await useCase.execute({ ...input, pageSize: 5, afterAddress: 'users:1' });

    expect(accounts.findPage).toHaveBeenCalledExactlyOnceWith(trx, LEDGER_ID, {
      limit: 5,
      afterAddress: 'users:1',
    });
  });

  it('throws LedgerNotFoundError when there is no such ledger, and does not read accounts', async () => {
    const { useCase, ledgers, accounts } = setup();
    ledgers.findByName.mockResolvedValueOnce(null);

    await expect(useCase.execute(input)).rejects.toBeInstanceOf(LedgerNotFoundError);
    expect(accounts.findPage).not.toHaveBeenCalled();
  });

  it('passes a repository failure through unchanged', async () => {
    const { useCase, accounts } = setup();
    const failure = new Error('database is down');
    accounts.findPage.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
  });

  it('writes nothing', async () => {
    const { useCase, ledgers } = setup();

    await useCase.execute(input);

    expect(ledgers.insert).not.toHaveBeenCalled();
    expect(ledgers.updateMetadata).not.toHaveBeenCalled();
  });
});
