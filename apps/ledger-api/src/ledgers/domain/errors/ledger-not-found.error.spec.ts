import { LedgerDomainError } from './ledger-domain.error.js';
import { LedgerNotFoundError } from './ledger-not-found.error.js';

describe('LedgerNotFoundError', () => {
  it('is a ledger error that carries the ledger name and a stable code', () => {
    const error = new LedgerNotFoundError('main');

    expect(error).toBeInstanceOf(LedgerDomainError);
    expect(error.name).toBe('LedgerNotFoundError');
    expect(error.code).toBe('LEDGER_NOT_FOUND');
    expect(error.ledgerName).toBe('main');
    expect(error.message).toBe('Ledger "main" not found');
  });
});
