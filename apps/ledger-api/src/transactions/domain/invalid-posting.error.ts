import { TransactionDomainError } from './transaction-domain.error.js';

/**
 * A posting breaks a rule: the amount is not above zero, or the source and
 * the destination are the same account.
 *
 * The message is safe to show to API clients. It does not repeat any value
 * of the request.
 */
export class InvalidPostingError extends TransactionDomainError {
  readonly code = 'INVALID_POSTING';
}
