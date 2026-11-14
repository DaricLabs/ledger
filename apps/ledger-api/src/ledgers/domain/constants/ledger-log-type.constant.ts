/**
 * Types of the journal entries (`ledger_logs.type`) that the ledgers feature
 * writes.
 *
 * The journal port takes any string, so this list is what keeps a typo out of
 * a use case. The values are public: add new ones, never rename or remove.
 */
export const LEDGER_LOG_TYPE = {
  CREATED: 'LEDGER_CREATED',
  METADATA_SAVED: 'LEDGER_METADATA_SAVED',
  METADATA_DELETED: 'LEDGER_METADATA_DELETED',
} as const;
