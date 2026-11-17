import { createHash } from 'node:crypto';

/** The parts of a create request that make it the same request or another one. */
export interface ICreateTransactionRequestFingerprint {
  reference?: string;
  postings: readonly {
    source: string;
    destination: string;
    asset: string;
    amount: bigint;
  }[];
}

/**
 * Bump this when the text below changes. A new format gives new hashes, so a
 * key that is still remembered would look like a different request.
 */
const FORMAT_VERSION = 1;

/**
 * The SHA-256 of a create-transaction request. The idempotency module compares
 * it to tell a repeated request (same hash) from a key used for another
 * request (different hash).
 *
 * It does not hash the raw body. The text is built from the request that has
 * already passed validation, in a fixed order: the reference, then the
 * postings in their order, each as source, destination, asset and amount. So
 * the same request gives the same hash, whatever the order of the JSON fields
 * or the spaces in the body. The order of the postings counts, because they
 * are applied in order.
 *
 * The text is a JSON array, so no value can be moved into the next one (the
 * postings `a -> bc` and `ab -> c` have different texts).
 *
 * The ledger is not part of it: a key is already scoped by ledger.
 */
export function toCreateTransactionRequestHash(
  request: ICreateTransactionRequestFingerprint,
): Buffer {
  const text = JSON.stringify([
    FORMAT_VERSION,
    request.reference ?? null,
    request.postings.map((posting) => [
      posting.source,
      posting.destination,
      posting.asset,
      posting.amount.toString(),
    ]),
  ]);
  return createHash('sha256').update(text).digest();
}
