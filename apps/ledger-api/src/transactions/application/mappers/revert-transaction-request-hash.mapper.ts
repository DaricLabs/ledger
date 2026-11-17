import { createHash } from 'node:crypto';

/** The parts of a revert request that make it the same request or another one. */
export interface IRevertTransactionRequestFingerprint {
  /** The id of the transaction to revert. */
  transactionId: string;
}

/**
 * Bump this when the text below changes. A new format gives new hashes, so a
 * key that is still remembered would look like a different request.
 */
const FORMAT_VERSION = 1;

/**
 * The SHA-256 of a revert request. The idempotency module compares it to tell
 * a repeated request (same hash) from a key used for another request
 * (different hash).
 *
 * A revert has no body, so the only thing that makes two requests different is
 * the transaction they revert. The ledger is not part of it, and neither is
 * the operation: a key is already scoped by ledger and by operation.
 */
export function toRevertTransactionRequestHash(
  request: IRevertTransactionRequestFingerprint,
): Buffer {
  const text = JSON.stringify([FORMAT_VERSION, request.transactionId]);
  return createHash('sha256').update(text).digest();
}
