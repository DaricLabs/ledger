import { AccountDomainError } from './account-domain.error.js';

/**
 * The ledger has no account with this address.
 *
 * An account is made when money first moves through it, so an address that
 * was never used in a transaction has no account yet. It also covers an
 * account of another ledger or of another organization: the lookup only looks
 * inside the ledger of the request, and row-level security hides the rows of
 * other organizations. So from the caller's side the account does not exist.
 *
 * The address comes from the caller and is not repeated in the message, so the
 * message is safe to show to API clients.
 */
export class AccountNotFoundError extends AccountDomainError {
  readonly code = 'ACCOUNT_NOT_FOUND';

  constructor(readonly address: string) {
    super('Account not found in the ledger');
  }
}
