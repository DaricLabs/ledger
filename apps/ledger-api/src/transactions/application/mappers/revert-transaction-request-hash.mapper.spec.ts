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
});
