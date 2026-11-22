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
import type { ILedgerLogWriter } from '../../../journal/application/ports/ledger-log-writer.port.js';
import type { IOutboxWriter } from '../../../journal/application/ports/outbox-writer.port.js';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { Ledger } from '../../../ledgers/domain/entities/ledger.entity.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { Account } from '../../domain/entities/account.entity.js';
import { AccountNotFoundError } from '../../domain/errors/account-not-found.error.js';
import type { IAccountRepository } from '../ports/account-repository.port.js';
import { SaveAccountMetadataUseCase } from './save-account-metadata.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: Metadata.empty(),
  createdAt: new Date('2026-11-04T10:00:00.000Z'),
});

const stored = (entries: Record<string, string>) =>
  Account.reconstitute({
    address: AccountAddress.of('users:1'),
    allowOverdraft: false,
    metadata: Metadata.of(entries),
    createdAt: new Date('2026-11-09T10:00:00.000Z'),
    balances: [Money.of(AssetCode.of('USD'), 100n)],
  });

function setup(account: Account | null = stored({ customerId: 'c_42', note: 'old' })) {
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
  const accounts = {
    findByAddress: vi.fn<IAccountRepository['findByAddress']>(),
    lockByAddress: vi.fn<IAccountRepository['lockByAddress']>(async () => {
      calls.push('lock account');
      return account;
    }),
    updateMetadata: vi.fn<IAccountRepository['updateMetadata']>(async () => {
      calls.push('update metadata');
    }),
    findPage: vi.fn<IAccountRepository['findPage']>(),
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
  return { trx, calls, transactions, ledgers, accounts, logs, outbox };
}

function build(account?: Account | null) {
  const fakes = setup(account);
  const useCase = new SaveAccountMetadataUseCase(
    fakes.transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    fakes.ledgers,
    fakes.accounts,
    fakes.logs,
    fakes.outbox,
  );
  return { useCase, ...fakes };
}

const input = {
  organizationId: ORG_ID,
  ledgerName: 'main',
  address: 'users:1',
  metadata: { note: 'new', channel: 'web' },
};

describe('SaveAccountMetadataUseCase', () => {
  it('runs inside the transaction of the organization', async () => {
    const { useCase, transactions } = build();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
  });

  it('does the steps in the right order, in one transaction', async () => {
    const { useCase, calls } = build();

    await useCase.execute(input);

    expect(calls).toEqual([
      'begin',
      'find ledger',
      'lock account',
      'update metadata',
      'log',
      'outbox',
      'commit',
    ]);
  });

  it('finds the ledger by name and locks the account of that ledger', async () => {
    const { useCase, ledgers, accounts, trx } = build();

    await useCase.execute(input);

    expect(ledgers.findByName).toHaveBeenCalledExactlyOnceWith(trx, 'main');
    expect(accounts.lockByAddress).toHaveBeenCalledExactlyOnceWith(
      trx,
      LEDGER_ID,
      expect.objectContaining({ value: 'users:1' }),
    );
  });

  it('saves the old keys with the new ones: new keys are added, and a key that is there is replaced', async () => {
    const { useCase, accounts, trx } = build();

    await useCase.execute(input);

    expect(accounts.updateMetadata).toHaveBeenCalledOnce();
    const [calledTrx, ledgerId, saved] = accounts.updateMetadata.mock.calls[0]!;
    expect(calledTrx).toBe(trx);
    expect(ledgerId).toBe(LEDGER_ID);
    expect(saved.address.value).toBe('users:1');
    expect(saved.metadata.entries).toEqual({ customerId: 'c_42', note: 'new', channel: 'web' });
  });

  it('writes an ACCOUNT_METADATA_SAVED journal entry that is not about a transaction', async () => {
    const { useCase, logs, trx } = build();

    await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'ACCOUNT_METADATA_SAVED',
      payload: { address: 'users:1', metadata: { note: 'new', channel: 'web' } },
    });
  });

  it('writes a ledger.account.metadata.saved outbox event, with the address as the aggregate id', async () => {
    const { useCase, outbox, trx } = build();

    await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      aggregateType: 'account',
      aggregateId: 'users:1',
      eventType: 'ledger.account.metadata.saved',
      payload: {
        address: 'users:1',
        ledgerId: LEDGER_ID,
        organizationId: ORG_ID,
        metadata: { note: 'new', channel: 'web' },
      },
    });
  });

  it('records only the keys that changed', async () => {
    const { useCase, logs, outbox } = build();

    // `customerId` already has this value, so it is not a change.
    await useCase.execute({ ...input, metadata: { customerId: 'c_42', note: 'new' } });

    expect(logs.append.mock.calls[0]?.[1].payload).toEqual({
      address: 'users:1',
      metadata: { note: 'new' },
    });
    expect(outbox.append.mock.calls[0]?.[1].payload).toMatchObject({ metadata: { note: 'new' } });
  });

  it('saves, logs and publishes nothing when every key already has this value', async () => {
    const { useCase, accounts, logs, outbox, calls } = build();

    await useCase.execute({ ...input, metadata: { customerId: 'c_42', note: 'old' } });

    expect(accounts.updateMetadata).not.toHaveBeenCalled();
    expect(logs.append).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(calls).toEqual(['begin', 'find ledger', 'lock account', 'commit']);
  });

  it('saves, logs and publishes the same metadata, even if the caller changes its object while we wait', async () => {
    const { useCase, accounts, logs, outbox } = build();
    const metadata: Record<string, string> = { note: 'new' };
    accounts.lockByAddress.mockImplementationOnce(async () => {
      metadata['note'] = 'changed';
      metadata['extra'] = 'added';
      return stored({ customerId: 'c_42', note: 'old' });
    });

    await useCase.execute({ ...input, metadata });

    expect(accounts.updateMetadata.mock.calls[0]?.[2].metadata.entries).toEqual({
      customerId: 'c_42',
      note: 'new',
    });
    expect(logs.append.mock.calls[0]?.[1].payload).toEqual({
      address: 'users:1',
      metadata: { note: 'new' },
    });
    expect(outbox.append.mock.calls[0]?.[1].payload).toMatchObject({ metadata: { note: 'new' } });
  });

  describe('when something is wrong', () => {
    it('throws LedgerNotFoundError and goes no further when the ledger is missing', async () => {
      const { useCase, ledgers, accounts, logs, outbox } = build();
      ledgers.findByName.mockResolvedValueOnce(null);

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(LedgerNotFoundError);

      expect(accounts.lockByAddress).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('throws AccountNotFoundError and writes nothing when the account is missing', async () => {
      const { useCase, accounts, logs, outbox, calls } = build(null);

      await expect(useCase.execute(input)).rejects.toBeInstanceOf(AccountNotFoundError);

      expect(accounts.updateMetadata).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
      expect(calls).not.toContain('commit');
    });

    it('refuses a bad address before it opens a transaction', async () => {
      const { useCase, transactions } = build();

      await expect(useCase.execute({ ...input, address: 'Bad_Address' })).rejects.toBeInstanceOf(
        InvalidAccountAddressError,
      );

      expect(transactions.run).not.toHaveBeenCalled();
    });

    it('lets the domain refuse an empty key before it opens a transaction, and writes nothing', async () => {
      const { useCase, transactions, accounts, logs, outbox } = build();

      await expect(useCase.execute({ ...input, metadata: { '': 'x' } })).rejects.toBeInstanceOf(
        InvalidMetadataError,
      );

      expect(transactions.run).not.toHaveBeenCalled();
      expect(accounts.updateMetadata).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('checks the size on the stored metadata, so many small saves cannot pass the limits', async () => {
      const full = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, 'v']));
      const { useCase, accounts, logs } = build(stored(full));

      await expect(
        useCase.execute({ ...input, metadata: { oneMore: 'x' } }),
      ).rejects.toBeInstanceOf(MetadataLimitExceededError);

      expect(accounts.updateMetadata).not.toHaveBeenCalled();
      expect(logs.append).not.toHaveBeenCalled();
    });

    it('does not hide a failure of the journal, and does not publish after it', async () => {
      const { useCase, logs, outbox, calls } = build();
      logs.append.mockRejectedValueOnce(new Error('journal is down'));

      await expect(useCase.execute(input)).rejects.toThrow('journal is down');

      expect(outbox.append).not.toHaveBeenCalled();
      expect(calls).not.toContain('commit');
    });
  });
});
