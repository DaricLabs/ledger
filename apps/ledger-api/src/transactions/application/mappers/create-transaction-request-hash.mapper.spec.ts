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
      'dabac2d3d6f9b52c5fc5cfc0428e0a6ea21e6f4bf2e218c631d086ef7fc7d8ee',
    );
  });

  it('keeps its format with metadata, with the keys sorted', () => {
    const withMetadata = { ...request, metadata: { orderId: '42', channel: 'web' } };

    expect(toCreateTransactionRequestHash(withMetadata).toString('hex')).toBe(
      '41122282200edcb58fa17fc35c001d725c1fa9f36f779bcb1d475f7d5bcd64f9',
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

  describe('metadata', () => {
    const hashOf = (metadata?: Record<string, string>) =>
      toCreateTransactionRequestHash({ ...request, metadata });

    it('gives the same hash whatever the order of the keys', () => {
      const one = hashOf({ orderId: '42', channel: 'web', a: '1' });
      const other = hashOf({ a: '1', channel: 'web', orderId: '42' });

      expect(one.equals(other)).toBe(true);
    });

    it('gives the same hash for no metadata and for empty metadata', () => {
      expect(hashOf(undefined).equals(hashOf({}))).toBe(true);
    });

    it.each([
      ['an added key', { orderId: '42' }, { orderId: '42', channel: 'web' }],
      ['another value', { orderId: '42' }, { orderId: '43' }],
      ['another key', { orderId: '42' }, { order: '42' }],
      ['metadata against none', {}, { orderId: '42' }],
    ])('gives another hash for %s', (_name, one, other) => {
      expect(hashOf(one).equals(hashOf(other))).toBe(false);
    });

    it('does not let a key and a value move into each other', () => {
      expect(hashOf({ ab: 'c' }).equals(hashOf({ a: 'bc' }))).toBe(false);
    });
  });
});
