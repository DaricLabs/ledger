import type { TenantTransaction } from '@ledger/database';

/** What a call to {@link IIdempotencyKeyRepository.claim} needs to know. */
export interface IIdempotencyClaimInput {
  /** Stable name of the API operation, like `transactions.create`. */
  operation: string;
  /** The key the caller sent (1 to 255 printable ASCII characters). */
  key: string;
  /** SHA-256 of the request, to tell a repeated request from a different one. */
  requestHash: Buffer;
  /**
   * The id of the transaction that this request is about to create. The
   * transaction row must be saved in the same database transaction.
   */
  transactionId: string;
}

/**
 * The answer to a claim:
 *
 * - `replayed: false`: the key is yours. Do the work, and save the transaction
 *   with the id you passed.
 * - `replayed: true`: the same request was done before. Do nothing, and answer
 *   with the transaction that `transactionId` points to.
 */
export type IIdempotencyClaim = { replayed: false } | { replayed: true; transactionId: string };

/**
 * Remembers which requests were done, so a repeated request does not run
 * again.
 *
 * It works inside the database transaction of the work it protects, and that
 * is the point: the key is saved if and only if the work is saved. A crash,
 * an error or a rollback frees the key, and the retry runs again.
 */
export interface IIdempotencyKeyRepository {
  /**
   * Takes a key for a request, or tells that the request was done before.
   *
   * A key is scoped by organization, ledger, operation and key text. A key is
   * remembered for 24 hours, and then it is free again.
   *
   * Two requests with the same key at the same time cannot both get
   * `replayed: false`. The second one waits until the first one ends: if the
   * first one commits, the second one is a replay; if it rolls back, the
   * second one gets the key.
   *
   * @throws IdempotencyKeyReusedError If the key is still remembered for a
   * request with another hash.
   */
  claim(
    trx: TenantTransaction,
    ledgerId: string,
    input: IIdempotencyClaimInput,
  ): Promise<IIdempotencyClaim>;
}

/** Nest DI token for {@link IIdempotencyKeyRepository}. */
export const IDEMPOTENCY_KEY_REPOSITORY = Symbol('IDEMPOTENCY_KEY_REPOSITORY');
