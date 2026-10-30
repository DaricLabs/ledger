/**
 * A ledger name breaks the naming rules (wrong shape, or reserved).
 *
 * Thrown by `Ledger.create`. The message is safe to show to API clients.
 */
export class InvalidLedgerNameError extends Error {
  override readonly name = 'InvalidLedgerNameError';
}
