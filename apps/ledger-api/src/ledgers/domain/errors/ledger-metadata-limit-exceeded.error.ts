import { LedgerDomainError } from './ledger-domain.error.js';

/**
 * Which size limit of ledger metadata was broken. These names are stable, so
 * code that reads `dimension` can switch on them.
 *
 * - `entries`: too many keys.
 * - `key`: one key is too long.
 * - `value`: one value is too long.
 * - `total`: keys and values together are too big.
 */
export type LedgerMetadataLimitDimension = 'entries' | 'key' | 'value' | 'total';

/**
 * Ledger metadata is too big. The metadata itself is fine (an object with
 * string values), it just does not fit in one of the size limits.
 *
 * It has its own code (and not `INVALID_LEDGER_METADATA`), so a client can tell
 * "your metadata is wrong" from "your metadata is too big" without reading the
 * message.
 *
 * The message names the limit, and never contains a metadata value, because
 * values are free-form and may hold secrets. It names a key only for a value
 * that is too long, and that key has already passed the key limit. A key that
 * is too long is never repeated in the message.
 */
export class LedgerMetadataLimitExceededError extends LedgerDomainError {
  readonly code = 'LEDGER_METADATA_LIMIT_EXCEEDED';

  /**
   * @param dimension Which limit was broken.
   * @param limit The limit: a number of entries, or a number of bytes.
   * @param key The key of the value that is too long. Only for `value`.
   */
  constructor(
    readonly dimension: LedgerMetadataLimitDimension,
    readonly limit: number,
    key?: string,
  ) {
    super(messageOf(dimension, limit, key));
  }
}

function messageOf(dimension: LedgerMetadataLimitDimension, limit: number, key?: string): string {
  switch (dimension) {
    case 'entries':
      return `Metadata can have at most ${limit} entries`;
    case 'key':
      return `A metadata key can be at most ${limit} bytes long`;
    case 'value':
      return `The metadata value for key "${key ?? ''}" can be at most ${limit} bytes long`;
    case 'total':
      return `Metadata can be at most ${limit} bytes in total (keys and values together)`;
  }
}
