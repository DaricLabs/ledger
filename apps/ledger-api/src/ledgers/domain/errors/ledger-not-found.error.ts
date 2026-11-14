import { LedgerDomainError } from './ledger-domain.error.js';

/**
 * The organization has no ledger with this name.
 *
 * It also covers a ledger of another organization: row-level security hides
 * those rows, so from the caller's side the ledger does not exist. This is on
 * purpose, so a caller cannot find out which names other organizations use.
 *
 * The name comes from the caller, so a caller that is not the HTTP layer must
 * check its shape before it shows this message anywhere.
 */
export class LedgerNotFoundError extends LedgerDomainError {
  readonly code = 'LEDGER_NOT_FOUND';

  constructor(readonly ledgerName: string) {
    super(`Ledger "${ledgerName}" not found`);
  }
}
