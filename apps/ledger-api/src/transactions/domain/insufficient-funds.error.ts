import { TransactionDomainError } from './transaction-domain.error.js';

/**
 * A posting takes more money out of an account than the account has, and the
 * account is not allowed to go below zero.
 *
 * Amounts are decimal strings, because a `bigint` cannot go into JSON. The
 * account and the asset have already passed their patterns, and the amounts
 * are numbers, so the message is safe to show to API clients.
 */
export class InsufficientFundsError extends TransactionDomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  /**
   * @param account The account that does not have enough.
   * @param asset The asset that is missing.
   * @param balance What the account had when the posting was applied.
   * @param needed What the posting wanted to take out.
   */
  constructor(
    readonly account: string,
    readonly asset: string,
    readonly balance: string,
    readonly needed: string,
  ) {
    super(
      `Account "${account}" has not enough ${asset}: balance is ${balance}, but ${needed} is needed`,
    );
  }
}
