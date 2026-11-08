import { TransactionDomainError } from './transaction-domain.error.js';

/**
 * A transaction breaks a rule that is about the transaction as a whole: it has
 * no postings or too many, or its reference has a wrong length.
 *
 * The message is safe to show to API clients. It does not repeat any value
 * of the request.
 */
export class InvalidTransactionError extends TransactionDomainError {
  readonly code = 'INVALID_TRANSACTION';
}
