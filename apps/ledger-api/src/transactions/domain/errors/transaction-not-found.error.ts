import { TransactionDomainError } from './transaction-domain.error.js';

/**
 * The ledger has no transaction with this id.
 *
 * It also covers a transaction of another ledger or of another organization:
 * the lookup only looks inside the ledger of the request, and row-level
 * security hides the rows of other organizations. So from the caller's side
 * the transaction does not exist, and a caller cannot find out which ids
 * other ledgers or organizations use.
 *
 * The id comes from the caller and is not repeated in the message, so the
 * message is safe to show to API clients.
 */
export class TransactionNotFoundError extends TransactionDomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(readonly transactionId: string) {
    super('Transaction not found in the ledger');
  }
}
