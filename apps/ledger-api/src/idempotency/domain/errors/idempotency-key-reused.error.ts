import { IdempotencyDomainError } from './idempotency-domain.error.js';

/**
 * A key that is still remembered is used again with a different request.
 *
 * The same key must always mean the same request. If the request is another
 * one, answering with the first result would be wrong, and running it would
 * break the promise of the key, so the call is refused.
 *
 * The message does not repeat the key, so it is safe to show to API clients.
 */
export class IdempotencyKeyReusedError extends IdempotencyDomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor() {
    super('This Idempotency-Key was already used for a different request');
  }
}
