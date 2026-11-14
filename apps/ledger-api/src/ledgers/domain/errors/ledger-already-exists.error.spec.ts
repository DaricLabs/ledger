import { LedgerAlreadyExistsError } from './ledger-already-exists.error.js';

describe('LedgerAlreadyExistsError', () => {
  it('is an Error that carries the ledger name', () => {
    const error = new LedgerAlreadyExistsError('main');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LedgerAlreadyExistsError');
    expect(error.ledgerName).toBe('main');
    expect(error.message).toBe('Ledger "main" already exists');
  });
});
