import type { TenantTransaction } from '@ledger/database';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { Ledger } from '../../../ledgers/domain/entities/ledger.entity.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { Posting } from '../../domain/posting.js';
import { Transaction } from '../../domain/transaction.entity.js';
import type {
  ITransactionPage,
  ITransactionRepository,
} from '../ports/transaction-repository.port.js';
import { ListTransactionsUseCase } from './list-transactions.use-case.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789ac';
const TRANSACTION_ID = '0190a5d4-7b3c-7abc-8def-0123456789ad';

const storedLedger = Ledger.reconstitute({
  id: LEDGER_ID,
  organizationId: ORG_ID,
  name: 'main',
  metadata: {},
  createdAt: new Date('2026-11-08T10:00:00.000Z'),
});

const storedPage: ITransactionPage = {
  transactions: [
    Transaction.reconstitute({
      id: TRANSACTION_ID,
      organizationId: ORG_ID,
      ledgerId: LEDGER_ID,
      reference: null,
      postings: [
        Posting.of(
          AccountAddress.of('world'),
          AccountAddress.of('users:1'),
          Money.of(AssetCode.of('USD'), 100n),
        ),
      ],
      postedAt: new Date('2026-11-08T10:00:00.000Z'),
      createdAt: new Date('2026-11-08T10:00:01.000Z'),
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
  const transactionRepository = {
    insert: vi.fn<ITransactionRepository['insert']>(),
    findById: vi.fn<ITransactionRepository['findById']>(),
    findPage: vi.fn<ITransactionRepository['findPage']>(async () => {
      calls.push('find page');
      return storedPage;
    }),
  };

  const useCase = new ListTransactionsUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    transactionRepository,
  );
  return { useCase, trx, calls, transactions, ledgers, transactionRepository };
}

const input = { organizationId: ORG_ID, ledgerName: 'main', pageSize: 10 };

describe('ListTransactionsUseCase', () => {
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
    const { useCase, trx, ledgers, transactionRepository } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName).toHaveBeenCalledExactlyOnceWith(trx, 'main');
    expect(transactionRepository.findPage).toHaveBeenCalledExactlyOnceWith(trx, LEDGER_ID, {
      limit: 10,
      after: undefined,
    });
  });

  it('asks for the page after the given position', async () => {
    const { useCase, trx, transactionRepository } = setup();
    const after = { postedAt: new Date('2026-11-07T10:00:00.000Z'), id: TRANSACTION_ID };

    await useCase.execute({ ...input, pageSize: 5, after });

    expect(transactionRepository.findPage).toHaveBeenCalledExactlyOnceWith(trx, LEDGER_ID, {
      limit: 5,
      after,
    });
  });

  it('throws LedgerNotFoundError when there is no such ledger, and does not read transactions', async () => {
    const { useCase, ledgers, transactionRepository } = setup();
    ledgers.findByName.mockResolvedValueOnce(null);

    await expect(useCase.execute(input)).rejects.toBeInstanceOf(LedgerNotFoundError);
    expect(transactionRepository.findPage).not.toHaveBeenCalled();
  });

  it('passes a repository failure through unchanged', async () => {
    const { useCase, transactionRepository } = setup();
    const failure = new Error('connection lost');
    transactionRepository.findPage.mockRejectedValueOnce(failure);

    await expect(useCase.execute(input)).rejects.toBe(failure);
  });

  it('writes nothing', async () => {
    const { useCase, ledgers, transactionRepository } = setup();

    await useCase.execute(input);

    expect(ledgers.insert).not.toHaveBeenCalled();
    expect(ledgers.updateMetadata).not.toHaveBeenCalled();
    expect(transactionRepository.insert).not.toHaveBeenCalled();
  });
});
