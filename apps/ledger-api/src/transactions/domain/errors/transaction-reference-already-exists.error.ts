import { TransactionDomainError } from './transaction-domain.error.js';

/**
 * The ledger already has a transaction with this reference.
 *
 * A reference is the id that the caller gives to a transaction, so a caller
 * that sends the same transaction twice by mistake gets this error and the
 * money moves only once.
 *
 * The reference comes from the caller and is not repeated in the message, so
 * the message is safe to show to API clients.
 */
export class TransactionReferenceAlreadyExistsError extends TransactionDomainError {
  readonly code = 'TRANSACTION_REFERENCE_ALREADY_EXISTS';

  constructor(readonly reference: string) {
    super('A transaction with this reference already exists in the ledger');
  }
}
