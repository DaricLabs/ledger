import type { TenantTransaction } from '@ledger/database';
import type { Ledger } from '../../domain/entities/ledger.entity.js';

/** Which page of ledgers to load. */
export interface ILedgerPageQuery {
  /** The most ledgers to return. At least 1. */
  limit: number;
  /**
   * Return only ledgers whose name comes after this one. The name does not have
   * to belong to a ledger: a deleted ledger still works as a position.
   * Leave it out for the first page.
   */
  afterName?: string;
}

/** One page of ledgers, sorted by name. */
export interface ILedgerPage {
  /** At most `limit` ledgers, in ascending name order. */
  ledgers: Ledger[];
  /** `true` when at least one more ledger comes after this page. */
  hasMore: boolean;
}

/**
 * Storage of ledgers. Every method works inside a transaction the caller owns.
 *
 * A deleted ledger is invisible here: `findByName`, `findByNameForUpdate` and
 * `findPage` never return it, as if it did not exist. Only its name stays
 * taken (see `insert`).
 */
export interface ILedgerRepository {
  /**
   * Saves a new ledger.
   *
   * @throws LedgerAlreadyExistsError If the organization already has a ledger
   * with this name. A deleted ledger counts too: its name is never free again.
   */
  insert(trx: TenantTransaction, ledger: Ledger): Promise<void>;

  /**
   * Loads the ledger with this name, from the organization of the transaction.
   *
   * @returns `null` when there is no such ledger. A ledger of another
   * organization, and a deleted ledger, count as "no such ledger".
   */
  findByName(trx: TenantTransaction, name: string): Promise<Ledger | null>;

  /**
   * Like `findByName`, and it also locks the ledger row until the transaction
   * ends. Use it when the caller reads a ledger to change it, so two changes
   * at the same time run one after the other and none is lost.
   *
   * @returns `null` when there is no such ledger (see `findByName`). If the
   * ledger is deleted while this call waits for the lock, it returns `null`.
   */
  findByNameForUpdate(trx: TenantTransaction, name: string): Promise<Ledger | null>;

  /**
   * Saves the metadata of a ledger that was loaded in this transaction. The
   * metadata is the only part of a ledger that can change.
   *
   * @throws Error If no ledger row was updated. The caller loaded the ledger
   * in the same transaction, so this means a bug and not a user mistake.
   */
  updateMetadata(trx: TenantTransaction, ledger: Ledger): Promise<void>;

  /**
   * Deletes a ledger that was loaded and locked in this transaction. The row
   * stays in storage with the time of the deletion, so its name stays taken
   * and its journal stays readable. It cannot be undone.
   *
   * Write the `LEDGER_DELETED` journal entry before calling this. Once the
   * ledger is deleted, storage refuses new journal entries for it.
   *
   * @throws Error If no live ledger row was updated. The caller loaded and
   * locked the ledger in the same transaction, so this means a bug and not a
   * user mistake.
   */
  markDeleted(trx: TenantTransaction, ledger: Ledger, deletedAt: Date): Promise<void>;

  /**
   * Loads one page of the live ledgers of the organization of the
   * transaction, sorted by name (ascending). Deleted ledgers are left out.
   *
   * The page is found by position (the name before it), not by page number, so
   * ledgers that are added or removed between two calls never cause a repeat or
   * a gap on the pages that follow.
   */
  findPage(trx: TenantTransaction, query: ILedgerPageQuery): Promise<ILedgerPage>;
}

/** Nest DI token for {@link ILedgerRepository}. */
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
