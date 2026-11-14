import { LedgerMetadataLimitExceededError } from './ledger-metadata-limit-exceeded.error.js';

describe('LedgerMetadataLimitExceededError', () => {
  it('is an Error that carries the broken limit', () => {
    const error = new LedgerMetadataLimitExceededError('entries', 128);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LedgerMetadataLimitExceededError');
    expect(error.dimension).toBe('entries');
    expect(error.limit).toBe(128);
  });

  it.each([
    ['entries', 128, undefined, 'Metadata can have at most 128 entries'],
    ['key', 256, undefined, 'A metadata key can be at most 256 bytes long'],
    ['value', 16384, 'env', 'The metadata value for key "env" can be at most 16384 bytes long'],
    [
      'total',
      65536,
      undefined,
      'Metadata can be at most 65536 bytes in total (keys and values together)',
    ],
  ] as const)('says which limit it is for %s', (dimension, limit, key, message) => {
    expect(new LedgerMetadataLimitExceededError(dimension, limit, key).message).toBe(message);
  });

  it('does not repeat a key that is too long', () => {
    // The caller never passes a key for the `key` dimension, but a key given
    // by mistake must not reach the message either.
    const error = new LedgerMetadataLimitExceededError('key', 256, 'k'.repeat(300));

    expect(error.message).not.toContain('kkk');
  });
});
