import { TransactionDomainError } from './transaction-domain.error.js';

/**
 * The transaction was reverted before. A transaction can be reverted only
 * once: the first revert made a new transaction that undoes it.
 *
 * The id comes from the caller and is not repeated in the message, so the
 * message is safe to show to API clients.
 */
export class TransactionAlreadyRevertedError extends TransactionDomainError {
  readonly code = 'TRANSACTION_ALREADY_REVERTED';

  constructor(readonly transactionId: string) {
    super('Transaction was already reverted');
  }
}
