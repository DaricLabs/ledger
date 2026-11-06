import type { TenantTransaction } from '@ledger/database';

export interface ILedgerLogEntry {
  ledgerId: string;
  /**
   * What happened, in `UPPER_SNAKE_CASE`, 3 to 64 characters (the database
   * refuses anything else). It is part of the public journal, so add new
   * types freely and never rename one.
   *
   * Each feature keeps its own list of types, like `LEDGER_LOG_TYPE` in the
   * ledgers feature. This port does not know them.
   */
  type: string;
  /**
   * The transaction this entry is about, if any. The transaction row must
   * already exist in the same database transaction (foreign key). Leave it out
   * for entries that are not about a transaction, like ledger changes.
   */
  transactionId?: string;
  /** Stored as a JSON object. Must not contain secrets. */
  payload: Record<string, unknown>;
}

/**
 * Writes the ledger journal. The journal is part of the ledger's own state,
 * so entries are written in the same transaction as the change they describe.
 */
export interface ILedgerLogWriter {
  /** Adds one entry. The database gives it the next `seq` of the ledger. */
  append(trx: TenantTransaction, entry: ILedgerLogEntry): Promise<void>;
}

/** Nest DI token for {@link ILedgerLogWriter}. */
export const LEDGER_LOG_WRITER = Symbol('LEDGER_LOG_WRITER');
