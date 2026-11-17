/**
 * Names of the API operations of the transactions feature, as the idempotency
 * module stores them (`idempotency_keys.operation`).
 *
 * A key is scoped by operation, so the same key text can be used for two
 * different operations. The values are public in the database: add new ones,
 * never rename or remove.
 */
export const TRANSACTION_OPERATION = {
  CREATE: 'transactions.create',
  REVERT: 'transactions.revert',
} as const;
