import type { TenantTransaction } from '@ledger/database';
import type { AccountAddress } from '@ledger/domain';
import type { Account } from '../../domain/entities/account.entity.js';

/** Which page of accounts to load. */
export interface IAccountPageQuery {
  /** The most accounts to return. At least 1. */
  limit: number;
  /**
   * Return only accounts whose address comes after this one. The address does
   * not have to belong to an account. Leave it out for the first page.
   */
  afterAddress?: string;
}

/** One page of accounts, sorted by address. */
export interface IAccountPage {
  /** At most `limit` accounts, in ascending address order, with their balances. */
  accounts: Account[];
  /** `true` when at least one more account comes after this page. */
  hasMore: boolean;
}

/**
 * Reads accounts, and saves their metadata. Every method works inside a
 * transaction the caller owns.
 *
 * It never makes an account and never changes a balance. Those are done by
 * `IAccountBalanceRepository`, because accounts are made together with their
 * balances when money first moves.
 */
export interface IAccountRepository {
  /**
   * Finds an account of a ledger by its address, with its balances in the
   * order of the asset codes.
   *
   * The account and its balances come from one query, so they are from the
   * same moment. Only the given ledger is searched, so the address of an
   * account of another ledger gives `null`, like an address that has no
   * account.
   *
   * @returns The account, or `null` if the ledger has none with this address.
   */
  findByAddress(
    trx: TenantTransaction,
    ledgerId: string,
    address: AccountAddress,
  ): Promise<Account | null>;

  /**
   * Like `findByAddress`, and the account row is locked until the transaction
   * ends, so no other transaction can edit its metadata in the meantime. A
   * caller that waits for the lock sees the result of the transaction that
   * held it.
   *
   * It is a lock for changing a column that is not a key (`metadata`), so it
   * does not block the rows that point to this account (the balances, for
   * example). A transaction that moves money through the account does not wait
   * for it either. That needs two things in the database: the overdraft flag
   * of a new balance row is guarded by an advisory lock and not by a lock on
   * the account row, and `IAccountBalanceRepository.open` does not insert
   * accounts that exist. The balance rows are not locked.
   *
   * @returns The account, or `null` if the ledger has none with this address.
   */
  lockByAddress(
    trx: TenantTransaction,
    ledgerId: string,
    address: AccountAddress,
  ): Promise<Account | null>;

  /**
   * Saves the metadata of an account that was loaded with `lockByAddress` in
   * this transaction. Metadata is the only part of an account that this method
   * changes. It does not touch the balances or the overdraft rule.
   *
   * @throws Error If no account row was updated. The caller locked the account
   * in the same database transaction, so this means a bug and not a user
   * mistake.
   */
  updateMetadata(trx: TenantTransaction, ledgerId: string, account: Account): Promise<void>;

  /**
   * Loads one page of the accounts of a ledger, sorted by address (ascending),
   * each with its balances in the order of the asset codes.
   *
   * The page is found by position (the address before it), not by page number,
   * so accounts that are added between two calls never cause a repeat or a gap
   * on the pages that follow. The accounts and their balances of one page come
   * from one query, so they are from the same moment. Only the given ledger is
   * searched.
   */
  findPage(
    trx: TenantTransaction,
    ledgerId: string,
    query: IAccountPageQuery,
  ): Promise<IAccountPage>;
}

/** Nest DI token for {@link IAccountRepository}. */
export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');
