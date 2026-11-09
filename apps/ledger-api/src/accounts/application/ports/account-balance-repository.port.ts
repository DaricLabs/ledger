import type { TenantTransaction } from '@ledger/database';
import type { AccountBalance, IBalanceKey } from '../../domain/account-balance.js';

/**
 * The write side of accounts and balances, for the features that move money.
 * Every method works inside a transaction the caller owns.
 *
 * Accounts are made when money first moves through them, and this port does
 * that and keeps the balances. Reading accounts is `IAccountRepository`.
 */
export interface IAccountBalanceRepository {
  /**
   * Makes sure every given balance exists, with its account. What is missing
   * is created from the given balance (its account with its overdraft rule,
   * and a balance row with its amount). What is already there is left as it
   * is, so the amounts given only matter for new rows.
   *
   * The balances must be in the lock order (see `compareBalanceKeys`).
   * Creating rows in one order for everyone is what stops two transactions
   * that create the same accounts from waiting for each other.
   */
  open(
    trx: TenantTransaction,
    ledgerId: string,
    balances: readonly AccountBalance[],
  ): Promise<void>;

  /**
   * Loads the balances and locks them until the transaction ends, so no other
   * transaction can change them in the meantime.
   *
   * @param keys The balances to lock, in the lock order (see
   * `compareBalanceKeys`). They are locked one after the other in this order.
   * @returns The balances, in the order of `keys`.
   * @throws Error If a balance does not exist. The caller made them with
   * `open` in the same transaction, so this means a bug.
   */
  lock(
    trx: TenantTransaction,
    ledgerId: string,
    keys: readonly IBalanceKey[],
  ): Promise<AccountBalance[]>;

  /**
   * Saves the amounts of balances that were locked in this transaction.
   *
   * @throws Error If a balance was not found. It was locked in the same
   * transaction, so this means a bug.
   */
  save(
    trx: TenantTransaction,
    ledgerId: string,
    balances: readonly AccountBalance[],
  ): Promise<void>;
}

/** Nest DI token for {@link IAccountBalanceRepository}. */
export const ACCOUNT_BALANCE_REPOSITORY = Symbol('ACCOUNT_BALANCE_REPOSITORY');
