import { toRevertTransactionRequestHash } from './revert-transaction-request-hash.mapper.js';

const TRANSACTION_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';

describe('toRevertTransactionRequestHash', () => {
  it('is a SHA-256 digest of 32 bytes', () => {
    expect(toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID })).toHaveLength(32);
  });

  it('gives the same hash for the same transaction', () => {
    expect(
      toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID }).equals(
        toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID }),
      ),
    ).toBe(true);
  });

  it('keeps its format: a change here would make remembered keys look like other requests', () => {
    expect(toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID }).toString('hex')).toBe(
      '17b2863bd93f581378f31dbdb1bd29ec7d758885be2bcd08bede3d68a95c89f4',
    );
  });

  it('gives another hash for another transaction', () => {
    const other = '0190a5d4-7b3c-7abc-8def-0123456789ac';

    expect(
      toRevertTransactionRequestHash({ transactionId: other }).equals(
        toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID }),
      ),
    ).toBe(false);
  });

  describe('metadata', () => {
    it('gives the old hash for no metadata, and for an empty object', () => {
      const old = toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID });

      expect(
        toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID, metadata: {} }).equals(old),
      ).toBe(true);
    });

    it('gives another hash when there is metadata', () => {
      expect(
        toRevertTransactionRequestHash({
          transactionId: TRANSACTION_ID,
          metadata: { reason: 'duplicate' },
        }).equals(toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID })),
      ).toBe(false);
    });

    it('gives another hash for another key or another value', () => {
      const hash = (metadata: Record<string, string>) =>
        toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID, metadata });

      expect(hash({ reason: 'duplicate' }).equals(hash({ reason: 'fraud' }))).toBe(false);
      expect(hash({ reason: 'duplicate' }).equals(hash({ cause: 'duplicate' }))).toBe(false);
    });

    it('does not depend on the order of the keys', () => {
      const hash = (metadata: Record<string, string>) =>
        toRevertTransactionRequestHash({ transactionId: TRANSACTION_ID, metadata });

      expect(hash({ a: '1', b: '2' }).equals(hash({ b: '2', a: '1' }))).toBe(true);
    });

    it('keeps its format for requests with metadata', () => {
      expect(
        toRevertTransactionRequestHash({
          transactionId: TRANSACTION_ID,
          metadata: { reason: 'duplicate' },
        }).toString('hex'),
      ).toBe('66f0971f8b63895048df3bfc9242bb653229291109dbb56f51cae166bff984b5');
    });
  });
});
