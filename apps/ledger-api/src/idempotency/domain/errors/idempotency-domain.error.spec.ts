import { DomainError } from '@ledger/domain';
import { IdempotencyDomainError } from './idempotency-domain.error.js';
import { IdempotencyKeyReusedError } from './idempotency-key-reused.error.js';

// The codes are public API: clients switch on them. If a code in this table
// has to change, it is a breaking change, not a refactor.
const idempotencyErrors: [string, () => IdempotencyDomainError, string][] = [
  ['IdempotencyKeyReusedError', () => new IdempotencyKeyReusedError(), 'IDEMPOTENCY_KEY_REUSED'],
];

describe('idempotency errors', () => {
  it.each(idempotencyErrors)(
    '%s has its public code and the idempotency base classes',
    (name, create, code) => {
      const error = create();

      expect(error.code).toBe(code);
      expect(error.name).toBe(name);
      expect(error).toBeInstanceOf(IdempotencyDomainError);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(Error);
    },
  );

  it('has a different code for each error', () => {
    const codes = idempotencyErrors.map(([, create]) => create().code);

    expect(new Set(codes).size).toBe(codes.length);
  });
});
