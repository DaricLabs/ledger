import type { MetadataEntries } from '@ledger/domain';

/**
 * The `[key, value]` pairs of metadata, sorted by key, for the request hashes.
 *
 * Keys are sorted by their UTF-16 code units, which does not depend on the
 * language of the server. Keys are unique, so there are no ties.
 */
export function toSortedMetadataEntries(metadata: MetadataEntries): [string, string][] {
  return Object.entries(metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
