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
}

/** Nest DI token for {@link ITransactionRepository}. */
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');
