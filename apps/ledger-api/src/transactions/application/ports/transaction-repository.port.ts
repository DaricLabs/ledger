import type { TenantTransaction } from '@ledger/database';
import type { Transaction } from '../../domain/transaction.entity.js';

/**
 * A place in the list of transactions of a ledger. The list is sorted by
 * `postedAt` and then by `id`, both from newest to oldest, and a position is
 * the `postedAt` and the `id` of one transaction.
 */
export interface ITransactionPosition {
  postedAt: Date;
  id: string;
}

/** Which page of transactions to load. */
export interface ITransactionPageQuery {
  /** The most transactions to return. At least 1. */
  limit: number;
  /**
   * Return only transactions that come after this position in the list, that
   * is, older ones. The position does not have to belong to a transaction.
   * Leave it out for the first page.
   */
  after?: ITransactionPosition;
}

/** One page of transactions, newest first. */
export interface ITransactionPage {
  /** At most `limit` transactions, with their postings in order. */
  transactions: Transaction[];
  /** `true` when at least one more transaction comes after this page. */
  hasMore: boolean;
}

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

  /**
   * Loads one page of the transactions of a ledger, newest first: by
   * `postedAt` from the latest, and by `id` from the biggest when two have the
   * same `postedAt`. Every transaction comes with its postings in order.
   *
   * The page is found by position, not by page number, so transactions that
   * are added between two calls never cause a repeat or a gap on the pages
   * that follow. Only the given ledger is searched.
   */
  findPage(
    trx: TenantTransaction,
    ledgerId: string,
    query: ITransactionPageQuery,
  ): Promise<ITransactionPage>;
}

/** Nest DI token for {@link ITransactionRepository}. */
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');
