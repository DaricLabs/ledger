import type { TenantTransaction } from '@ledger/database';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import type { ITenantTransactionRunner } from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import type { ILedgerRepository } from '../../../ledgers/application/ports/ledger-repository.port.js';
import { Ledger } from '../../../ledgers/domain/ledger.entity.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/ledger-not-found.error.js';
import { Posting } from '../../domain/posting.js';
import { TransactionNotFoundError } from '../../domain/transaction-not-found.error.js';
import { Transaction } from '../../domain/transaction.entity.js';
import type { ITransactionRepository } from '../ports/transaction-repository.port.js';
import { GetTransactionUseCase } from './get-transaction.use-case.js';

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

const storedTransaction = Transaction.reconstitute({
  id: TRANSACTION_ID,
  organizationId: ORG_ID,
  ledgerId: LEDGER_ID,
  reference: 'order-1',
  postings: [
    Posting.of(
      AccountAddress.of('world'),
      AccountAddress.of('users:1'),
      Money.of(AssetCode.of('USD'), 100n),
    ),
  ],
  postedAt: new Date('2026-11-08T10:00:00.000Z'),
  createdAt: new Date('2026-11-08T10:00:01.000Z'),
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
  const transactionRepository = {
    insert: vi.fn<ITransactionRepository['insert']>(),
    findById: vi.fn<ITransactionRepository['findById']>(async () => {
      calls.push('find transaction');
      return storedTransaction;
    }),
  };

  const useCase = new GetTransactionUseCase(
    transactions as unknown as ITenantTransactionRunner, // the fake is not generic, the port is
    ledgers,
    transactionRepository,
  );
  return { useCase, trx, calls, transactions, ledgers, transactionRepository };
}

const input = { organizationId: ORG_ID, ledgerName: 'main', transactionId: TRANSACTION_ID };

describe('GetTransactionUseCase', () => {
  it('returns the transaction the repository finds', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(input)).resolves.toBe(storedTransaction);
  });

  it('reads inside the transaction of the organization, the ledger first', async () => {
    const { useCase, transactions, calls } = setup();

    await useCase.execute(input);

    expect(transactions.run).toHaveBeenCalledExactlyOnceWith(ORG_ID, expect.any(Function));
    expect(calls).toEqual(['begin', 'find ledger', 'find transaction', 'commit']);
  });

  it('looks for the transaction inside the ledger that has the given name', async () => {
    const { useCase, trx, ledgers, transactionRepository } = setup();

    await useCase.execute(input);

    expect(ledgers.findByName).toHaveBeenCalledExactlyOnceWith(trx, 'main');
    expect(transactionRepository.findById).toHaveBeenCalledExactlyOnceWith(
      trx,
      LEDGER_ID,
      TRANSACTION_ID,
    );
  });

  it('throws LedgerNotFoundError when there is no such ledger, and does not look for the transaction', async () => {
    const { useCase, ledgers, transactionRepository } = setup();
    ledgers.findByName.mockResolvedValueOnce(null);

    await expect(useCase.execute(input)).rejects.toBeInstanceOf(LedgerNotFoundError);
    expect(transactionRepository.findById).not.toHaveBeenCalled();
  });

  it('throws TransactionNotFoundError when the ledger has no such transaction', async () => {
    const { useCase, transactionRepository } = setup();
    transactionRepository.findById.mockResolvedValueOnce(null);

    const error = await useCase.execute(input).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TransactionNotFoundError);
    expect(error).toMatchObject({ code: 'TRANSACTION_NOT_FOUND', transactionId: TRANSACTION_ID });
  });

  it('writes nothing', async () => {
    const { useCase, ledgers, transactionRepository } = setup();

    await useCase.execute(input);

    expect(ledgers.insert).not.toHaveBeenCalled();
    expect(ledgers.updateMetadata).not.toHaveBeenCalled();
    expect(transactionRepository.insert).not.toHaveBeenCalled();
  });
});
