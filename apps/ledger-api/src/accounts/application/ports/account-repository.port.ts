import type { TenantTransaction } from '@ledger/database';
import type { AccountAddress } from '@ledger/domain';
import type { Account } from '../../domain/account.entity.js';

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
 * The read side of accounts. Every method works inside a transaction the
 * caller owns.
 *
 * It only reads. Accounts are made by `IAccountBalanceRepository`, because
 * they are made together with their balances when money first moves.
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
