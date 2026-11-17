import { DomainError } from '@ledger/domain';
import { InvalidPostingError } from './invalid-posting.error.js';
import { InvalidTransactionError } from './invalid-transaction.error.js';
import { TransactionDomainError } from './transaction-domain.error.js';
import { TransactionAlreadyRevertedError } from './transaction-already-reverted.error.js';
import { TransactionNotFoundError } from './transaction-not-found.error.js';
import { TransactionReferenceAlreadyExistsError } from './transaction-reference-already-exists.error.js';

// The codes are public API: clients switch on them. If a code in this table
// has to change, it is a breaking change, not a refactor.
const transactionErrors: [string, () => TransactionDomainError, string][] = [
  ['InvalidPostingError', () => new InvalidPostingError('bad posting'), 'INVALID_POSTING'],
  [
    'InvalidTransactionError',
    () => new InvalidTransactionError('bad transaction'),
    'INVALID_TRANSACTION',
  ],
  [
    'TransactionAlreadyRevertedError',
    () => new TransactionAlreadyRevertedError('0190a1b2-0000-7000-8000-000000000001'),
    'TRANSACTION_ALREADY_REVERTED',
  ],
  [
    'TransactionNotFoundError',
    () => new TransactionNotFoundError('0190a1b2-0000-7000-8000-000000000001'),
    'TRANSACTION_NOT_FOUND',
  ],
  [
    'TransactionReferenceAlreadyExistsError',
    () => new TransactionReferenceAlreadyExistsError('order-42'),
    'TRANSACTION_REFERENCE_ALREADY_EXISTS',
  ],
];

describe('transaction errors', () => {
  it.each(transactionErrors)(
    '%s has its public code and the transaction base classes',
    (name, create, code) => {
      const error = create();

      expect(error.code).toBe(code);
      expect(error.name).toBe(name);
      expect(error).toBeInstanceOf(TransactionDomainError);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(Error);
    },
  );

  it('has a different code for each error', () => {
    const codes = transactionErrors.map(([, create]) => create().code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('carries the id or the reference without repeating it in the message', () => {
    const notFound = new TransactionNotFoundError('0190a1b2-0000-7000-8000-000000000001');
    const duplicate = new TransactionReferenceAlreadyExistsError('order-42');

    expect(notFound.transactionId).toBe('0190a1b2-0000-7000-8000-000000000001');
    expect(notFound.message).not.toContain(notFound.transactionId);
    expect(duplicate.reference).toBe('order-42');
    expect(duplicate.message).not.toContain('order-42');

    const reverted = new TransactionAlreadyRevertedError('0190a1b2-0000-7000-8000-000000000001');
    expect(reverted.transactionId).toBe('0190a1b2-0000-7000-8000-000000000001');
    expect(reverted.message).not.toContain(reverted.transactionId);
  });
});
