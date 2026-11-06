import { DomainError } from '@ledger/domain';
import { InvalidLedgerMetadataError } from './invalid-ledger-metadata.error.js';
import { InvalidLedgerNameError } from './invalid-ledger-name.error.js';
import { LedgerAlreadyExistsError } from './ledger-already-exists.error.js';
import { LedgerDomainError } from './ledger-domain.error.js';
import { LedgerMetadataLimitExceededError } from './ledger-metadata-limit-exceeded.error.js';

// The codes are public API: clients switch on them. If a code in this table
// has to change, it is a breaking change, not a refactor.
const ledgerErrors: [string, () => LedgerDomainError, string][] = [
  ['InvalidLedgerNameError', () => new InvalidLedgerNameError('bad name'), 'INVALID_LEDGER_NAME'],
  [
    'InvalidLedgerMetadataError',
    () => new InvalidLedgerMetadataError('bad metadata'),
    'INVALID_LEDGER_METADATA',
  ],
  ['LedgerAlreadyExistsError', () => new LedgerAlreadyExistsError('main'), 'LEDGER_ALREADY_EXISTS'],
  [
    'LedgerMetadataLimitExceededError',
    () => new LedgerMetadataLimitExceededError('entries', 128),
    'LEDGER_METADATA_LIMIT_EXCEEDED',
  ],
];

describe('ledger errors', () => {
  it.each(ledgerErrors)(
    '%s has its public code and the ledger base classes',
    (name, create, code) => {
      const error = create();

      expect(error.code).toBe(code);
      expect(error.name).toBe(name);
      expect(error).toBeInstanceOf(LedgerDomainError);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(Error);
    },
  );

  it('has a different code for each error', () => {
    const codes = ledgerErrors.map(([, create]) => create().code);

    expect(new Set(codes).size).toBe(codes.length);
  });
});
