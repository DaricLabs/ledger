import { createHash } from 'node:crypto';
import type { MetadataEntries } from '@ledger/domain';

/** The parts of a create request that make it the same request or another one. */
export interface ICreateTransactionRequestFingerprint {
  reference?: string | null;
  postings: readonly {
    source: string;
    destination: string;
    asset: string;
    amount: bigint;
  }[];
  /** The metadata of the request. Leaving it out is the same as having no entries. */
  metadata?: MetadataEntries;
}

/**
 * Bump this when the text below changes. A new format gives new hashes, so a
 * key that is still remembered would look like a different request.
 */
const FORMAT_VERSION = 2;

/**
 * The SHA-256 of a create-transaction request. The idempotency module compares
 * it to tell a repeated request (same hash) from a key used for another
 * request (different hash).
 *
 * It does not hash the raw body. The text is built from the request that has
 * already passed validation, in a fixed order: the reference, then the
 * postings in their order, each as source, destination, asset and amount, then
 * the metadata. So the same request gives the same hash, whatever the order of
 * the JSON fields or the spaces in the body. The order of the postings counts,
 * because they are applied in order.
 *
 * The metadata counts too, because it is saved with the transaction: the same
 * key with other metadata is another request. Its keys are sorted, so the
 * order of the keys in the body does not matter, and no metadata is the same
 * as `{}`. The keys are sorted by their UTF-16 code units, which does not
 * depend on the language of the server.
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
    sortedEntries(request.metadata ?? {}),
  ]);
  return createHash('sha256').update(text).digest();
}

/** The `[key, value]` pairs of metadata, sorted by key. Keys are unique, so there are no ties. */
function sortedEntries(metadata: MetadataEntries): [string, string][] {
  return Object.entries(metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
