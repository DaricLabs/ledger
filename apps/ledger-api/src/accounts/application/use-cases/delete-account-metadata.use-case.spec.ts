import type { TenantTransaction } from '@ledger/database';
import {
  AccountAddress,
  AssetCode,
  InvalidAccountAddressError,
  Metadata,
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
import { DeleteAccountMetadataUseCase } from './delete-account-metadata.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LOG_SEQ = '7';
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
      return LOG_SEQ;
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
  const useCase = new DeleteAccountMetadataUseCase(
    fakes.transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    fakes.ledgers,
    fakes.accounts,
    fakes.logs,
    fakes.outbox,
  );
  return { useCase, ...fakes };
}

const input = { organizationId: ORG_ID, ledgerName: 'main', address: 'users:1', key: 'note' };

describe('DeleteAccountMetadataUseCase', () => {
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

  it('saves the metadata without that key, and keeps the other keys', async () => {
    const { useCase, accounts, trx } = build();

    await useCase.execute(input);

    expect(accounts.updateMetadata).toHaveBeenCalledOnce();
    const [calledTrx, ledgerId, saved] = accounts.updateMetadata.mock.calls[0]!;
    expect(calledTrx).toBe(trx);
    expect(ledgerId).toBe(LEDGER_ID);
    expect(saved.metadata.entries).toEqual({ customerId: 'c_42' });
  });

  it('writes an ACCOUNT_METADATA_DELETED journal entry with the key', async () => {
    const { useCase, logs, trx } = build();

    await useCase.execute(input);

    expect(logs.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      type: 'ACCOUNT_METADATA_DELETED',
      payload: { address: 'users:1', key: 'note' },
    });
  });

  it('writes a ledger.account.metadata.deleted outbox event', async () => {
    const { useCase, outbox, trx } = build();

    await useCase.execute(input);

    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(trx, {
      ledgerId: LEDGER_ID,
      logSeq: LOG_SEQ,
      aggregateType: 'account',
      aggregateId: 'users:1',
      eventType: 'ledger.account.metadata.deleted',
      payload: {
        address: 'users:1',
        ledgerId: LEDGER_ID,
        organizationId: ORG_ID,
        key: 'note',
      },
    });
  });

  it('saves, logs and publishes nothing when the key is not there', async () => {
    const { useCase, accounts, logs, outbox, calls } = build();

    await useCase.execute({ ...input, key: 'never-there' });

    expect(accounts.updateMetadata).not.toHaveBeenCalled();
    expect(logs.append).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(calls).toEqual(['begin', 'find ledger', 'lock account', 'commit']);
  });

  it('can empty the metadata of an account', async () => {
    const { useCase, accounts } = build(stored({ note: 'only' }));

    await useCase.execute(input);

    expect(accounts.updateMetadata.mock.calls[0]?.[2].metadata.entries).toEqual({});
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

    it('throws AccountNotFoundError and writes nothing when the account is missing, even for a key that does not exist', async () => {
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

    it('does not hide a failure of the journal, and does not publish after it', async () => {
      const { useCase, logs, outbox, calls } = build();
      logs.append.mockRejectedValueOnce(new Error('journal is down'));

      await expect(useCase.execute(input)).rejects.toThrow('journal is down');

      expect(outbox.append).not.toHaveBeenCalled();
      expect(calls).not.toContain('commit');
    });
  });
});
