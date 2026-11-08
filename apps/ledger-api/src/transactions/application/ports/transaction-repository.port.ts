import type { TenantTransaction } from '@ledger/database';
import type { Transaction } from '../../domain/transaction.entity.js';

/** Storage of transactions. Every method works inside a transaction the caller owns. */
export interface ITransactionRepository {
  /**
   * Saves a new transaction with its postings. The accounts of the postings
   * must already exist in the same database transaction (foreign key).
   *
   * @throws TransactionReferenceAlreadyExistsError If the ledger already has a
   * transaction with this reference.
   */
  insert(trx: TenantTransaction, transaction: Transaction): Promise<void>;

  /**
   * Finds a transaction of a ledger by its id, with its postings in order.
   *
   * Only the given ledger is searched, so the id of a transaction of another
   * ledger gives `null`, like an id that does not exist.
   *
   * @returns The transaction, or `null` if the ledger has none with this id.
   */
  findById(trx: TenantTransaction, ledgerId: string, id: string): Promise<Transaction | null>;
}

/** Nest DI token for {@link ITransactionRepository}. */
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');
