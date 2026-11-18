import { DomainError } from './domain.error.js';
import { InvalidAccountAddressError } from './invalid-account-address.error.js';
import { InvalidAssetCodeError } from './invalid-asset-code.error.js';
import { InvalidMetadataError } from './invalid-metadata.error.js';
import { MetadataLimitExceededError } from './metadata-limit-exceeded.error.js';
import { MoneyAmountOutOfRangeError } from './money-amount-out-of-range.error.js';
import { MoneyAssetMismatchError } from './money-asset-mismatch.error.js';
import { ValueObjectError } from './value-object.error.js';

// The codes are public API: clients switch on them. If a code in this table
// has to change, it is a breaking change, not a refactor.
const valueObjectErrors: [string, () => ValueObjectError, string][] = [
  ['InvalidAssetCodeError', () => new InvalidAssetCodeError(), 'INVALID_ASSET_CODE'],
  ['InvalidAccountAddressError', () => new InvalidAccountAddressError(), 'INVALID_ACCOUNT_ADDRESS'],
  [
    'MoneyAmountOutOfRangeError',
    () => new MoneyAmountOutOfRangeError(),
    'MONEY_AMOUNT_OUT_OF_RANGE',
  ],
  [
    'MoneyAssetMismatchError',
    () => new MoneyAssetMismatchError('USD', 'EUR'),
    'MONEY_ASSET_MISMATCH',
  ],
  ['InvalidMetadataError', () => new InvalidMetadataError('bad metadata'), 'INVALID_METADATA'],
  [
    'MetadataLimitExceededError',
    () => new MetadataLimitExceededError('entries', 128),
    'METADATA_LIMIT_EXCEEDED',
  ],
];

describe('value object errors', () => {
  it.each(valueObjectErrors)(
    '%s has its public code and the shared base classes',
    (_name, create, code) => {
      const error = create();

      expect(error.code).toBe(code);
      expect(error).toBeInstanceOf(ValueObjectError);
      expect(error).toBeInstanceOf(DomainError);
    },
  );

  it('has a different code for each error', () => {
    const codes = valueObjectErrors.map(([, create]) => create().code);

    expect(new Set(codes).size).toBe(codes.length);
  });
});
