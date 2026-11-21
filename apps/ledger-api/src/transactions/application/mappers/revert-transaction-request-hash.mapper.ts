import { createHash } from 'node:crypto';
import type { MetadataEntries } from '@ledger/domain';
import { toSortedMetadataEntries } from './sorted-metadata-entries.mapper.js';

/** The parts of a revert request that make it the same request or another one. */
export interface IRevertTransactionRequestFingerprint {
  /** The id of the transaction to revert. */
  transactionId: string;
  /** The metadata of the request. Leaving it out is the same as having no entries. */
  metadata?: MetadataEntries;
}

/**
 * Bump this when the text below changes for requests that already existed. A
 * new format gives new hashes, so a key that is still remembered would look
 * like a different request. Adding a new optional part to the text (like the
 * metadata) needs no bump, as long as a request without that part keeps its
 * old text.
 */
const FORMAT_VERSION = 1;

/**
 * The SHA-256 of a revert request. The idempotency module compares it to tell
 * a repeated request (same hash) from a key used for another request
 * (different hash).
 *
 * The things that make two requests different are the transaction they revert
 * and the metadata of the revert, because the metadata is saved with the new
 * transaction: the same key with other metadata is another request. Its keys
 * are sorted, so the order of the keys in the body does not matter, and no
 * metadata is the same as `{}`. The ledger is not part of it, and neither is
 * the operation: a key is already scoped by ledger and by operation.
 *
 * The metadata is added at the end of the text only when there is some. So the
 * text, and the hash, of a request without metadata is the same as before
 * metadata existed, and a key that was saved by an older version still
 * matches an identical retry. A request with metadata could not have existed
 * before (a revert had no body), so no older key can clash with it.
 */
export function toRevertTransactionRequestHash(
  request: IRevertTransactionRequestFingerprint,
): Buffer {
  const metadata = toSortedMetadataEntries(request.metadata ?? {});
  const text = JSON.stringify([
    FORMAT_VERSION,
    request.transactionId,
    ...(metadata.length === 0 ? [] : [metadata]),
  ]);
  return createHash('sha256').update(text).digest();
}
