import type { TenantTransaction } from '@ledger/database';
import { AccountAddress, AssetCode, InvalidAccountAddressError, Money } from '@ledger/domain';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { Ledger } from '../../../ledgers/domain/entities/ledger.entity.js';
import { AccountNotFoundError } from '../../domain/account-not-found.error.js';
import { Account } from '../../domain/account.entity.js';
import type { IAccountRepository } from '../ports/account-repository.port.js';
import { GetAccountUseCase } from './get-account.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: {},
  createdAt: new Date('2026-11-09T10:00:00.000Z'),
});

const storedAccount = Account.reconstitute({
  address: AccountAddress.of('users:1'),
  allowOverdraft: false,
  createdAt: new Date('2026-11-09T10:00:01.000Z'),
  balances: [Money.of(AssetCode.of('USD'), 100n)],
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
      calls.push('find ledger');
      return storedLedger;
    }),
    findByNameForUpdate: vi.fn<ILedgerRepository['findByNameForUpdate']>(),
    updateMetadata: vi.fn<ILedgerRepository['updateMetadata']>(),
    findPage: vi.fn<ILedgerRepository['findPage']>(),
  };
  const accounts = {
    findByAddress: vi.fn<IAccountRepository['findByAddress']>(async () => {
      calls.push('find account');
      return storedAccount;
    }),
    findPage: vi.fn<IAccountRepository['findPage']>(),
  };

  const useCase = new GetAccountUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    accounts,
  );
  return { useCase, trx, calls, transactions, ledgers, accounts };
}

const input = { organizationId: ORG_ID, ledgerName: 'main', address: 'users:1' };

describe('GetAccountUseCase', () => {
  it('returns the account the repository finds', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(input)).resolves.toBe(storedAccount);
  });

  it('reads inside the transaction of the organization, the ledger first', async () => {
    const { useCase, transactions, calls } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
    expect(calls).toEqual(['begin', 'find ledger', 'find account', 'commit']);
  });

  it('looks for the account inside the ledger that has the given name', async () => {
    const { useCase, trx, ledgers, accounts } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName).toHaveBeenCalledExactlyOnceWith(trx, 'main');
    expect(accounts.findByAddress).toHaveBeenCalledExactlyOnceWith(
      trx,
      LEDGER_ID,
      AccountAddress.of('users:1'),
    );
  });

  it('throws LedgerNotFoundError when there is no such ledger, and does not look for the account', async () => {
    const { useCase, ledgers, accounts } = setup();
    ledgers.findByName.mockResolvedValueOnce(null);

    await expect(useCase.execute(input)).rejects.toBeInstanceOf(LedgerNotFoundError);
    expect(accounts.findByAddress).not.toHaveBeenCalled();
  });

  it('throws AccountNotFoundError when the ledger has no such account', async () => {
    const { useCase, accounts } = setup();
    accounts.findByAddress.mockResolvedValueOnce(null);

    const error = await useCase.execute(input).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AccountNotFoundError);
    expect(error).toMatchObject({ code: 'ACCOUNT_NOT_FOUND', address: 'users:1' });
  });

  it('refuses a bad address before it opens a transaction', async () => {
    const { useCase, transactions } = setup();

    await expect(useCase.execute({ ...input, address: 'Users:1' })).rejects.toBeInstanceOf(
      InvalidAccountAddressError,
    );
    expect(transactions.run).not.toHaveBeenCalled();
  });

  it('writes nothing', async () => {
    const { useCase, ledgers } = setup();

    await useCase.execute(input);

    expect(ledgers.insert).not.toHaveBeenCalled();
    expect(ledgers.updateMetadata).not.toHaveBeenCalled();
  });
});
