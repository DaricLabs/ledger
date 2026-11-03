import { LedgerDomainError } from './ledger-domain.error.js';

/**
 * An organization already has a ledger with this name.
 *
 * The storage adapter throws it when it hits the unique name rule. The entity
 * cannot know this by itself, because it never sees the other ledgers.
 */
export class LedgerAlreadyExistsError extends LedgerDomainError {
  readonly code = 'LEDGER_ALREADY_EXISTS';

  constructor(readonly ledgerName: string) {
    super(`Ledger "${ledgerName}" already exists`);
  }
}
