import { LedgerDomainError } from './ledger-domain.error.js';

/**
 * A ledger name breaks the naming rules (wrong shape, or reserved).
 *
 * Thrown by `Ledger.create`. The message is safe to show to API clients.
 */
export class InvalidLedgerNameError extends LedgerDomainError {
  readonly code = 'INVALID_LEDGER_NAME';
}
