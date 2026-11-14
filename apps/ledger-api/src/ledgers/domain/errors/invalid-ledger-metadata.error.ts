import { LedgerDomainError } from './ledger-domain.error.js';

/**
 * Ledger metadata breaks the rules (not an object, or a value is not a string).
 *
 * Thrown by `Ledger.create`. The message may name the bad key, but never
 * contains a metadata value, because values are free-form and may hold secrets.
 */
export class InvalidLedgerMetadataError extends LedgerDomainError {
  readonly code = 'INVALID_LEDGER_METADATA';
}
