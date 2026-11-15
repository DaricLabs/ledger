/**
 * Types of the journal entries (`ledger_logs.type`) that the transactions
 * feature writes.
 *
 * The journal port takes any string, so this list is what keeps a typo out of
 * a use case. The values are public: add new ones, never rename or remove.
 */
export const TRANSACTION_LOG_TYPE = {
  CREATED: 'TRANSACTION_CREATED',
} as const;
