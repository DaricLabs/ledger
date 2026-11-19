/**
 * Types of the journal entries (`ledger_logs.type`) that the accounts feature
 * writes.
 *
 * The journal port takes any string, so this list is what keeps a typo out of
 * a use case. The values are public: add new ones, never rename or remove.
 * An account is made by a transaction, so its creation is logged as part of
 * that transaction and has no type here.
 */
export const ACCOUNT_LOG_TYPE = {
  METADATA_SAVED: 'ACCOUNT_METADATA_SAVED',
  METADATA_DELETED: 'ACCOUNT_METADATA_DELETED',
} as const;
