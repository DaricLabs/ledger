import type { TenantTransaction } from '@ledger/database';

/** Types of entries in the ledger journal (`ledger_logs.type`). */
export type LedgerLogType = 'LEDGER_CREATED' | 'LEDGER_METADATA_SAVED' | 'LEDGER_METADATA_DELETED';

export interface ILedgerLogEntry {
  ledgerId: string;
  type: LedgerLogType;
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
