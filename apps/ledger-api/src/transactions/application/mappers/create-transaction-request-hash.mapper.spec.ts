import { toCreateTransactionRequestHash } from './create-transaction-request-hash.mapper.js';

const posting = (source: string, destination: string, amount: bigint, asset = 'USD') => ({
  source,
  destination,
  asset,
  amount,
});

const request = {
  reference: 'order-1',
  postings: [posting('world', 'users:1', 1000n), posting('users:1', 'platform:fees', 25n)],
};

describe('toCreateTransactionRequestHash', () => {
  it('is a SHA-256 digest of 32 bytes', () => {
    expect(toCreateTransactionRequestHash(request)).toHaveLength(32);
  });

  it('gives the same hash for the same request', () => {
    const copy = { reference: 'order-1', postings: request.postings.map((p) => ({ ...p })) };

    expect(
      toCreateTransactionRequestHash(copy).equals(toCreateTransactionRequestHash(request)),
    ).toBe(true);
  });

  it('keeps its format: a change here would make remembered keys look like other requests', () => {
    expect(toCreateTransactionRequestHash(request).toString('hex')).toBe(
      '2ffecbc37f86f017b549eb649904dc24f203a455b2d41449145d591f3413f7e3',
    );
  });

  it.each([
    ['another reference', { ...request, reference: 'order-2' }],
    ['no reference', { postings: request.postings }],
    [
      'another amount',
      { ...request, postings: [posting('world', 'users:1', 1001n), request.postings[1]!] },
    ],
    [
      'another asset',
      { ...request, postings: [posting('world', 'users:1', 1000n, 'EUR'), request.postings[1]!] },
    ],
    [
      'another source',
      { ...request, postings: [posting('platform:x', 'users:1', 1000n), request.postings[1]!] },
    ],
    [
      'another destination',
      { ...request, postings: [posting('world', 'users:2', 1000n), request.postings[1]!] },
    ],
    [
      'postings in another order',
      { ...request, postings: [request.postings[1]!, request.postings[0]!] },
    ],
    ['one posting less', { ...request, postings: [request.postings[0]!] }],
  ])('gives another hash for %s', (_label, other) => {
    expect(
      toCreateTransactionRequestHash(other).equals(toCreateTransactionRequestHash(request)),
    ).toBe(false);
  });

  it('does not let a value move into the next one', () => {
    const a = { postings: [posting('a', 'bc', 1n)] };
    const b = { postings: [posting('ab', 'c', 1n)] };

    expect(toCreateTransactionRequestHash(a).equals(toCreateTransactionRequestHash(b))).toBe(false);
  });

  it('does not mix up a missing reference with an empty one', () => {
    const none = { postings: request.postings };
    const empty = { reference: '', postings: request.postings };

    expect(toCreateTransactionRequestHash(none).equals(toCreateTransactionRequestHash(empty))).toBe(
      false,
    );
  });
});
