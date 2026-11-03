import type { Ledger, LedgerMetadata } from '../../domain/ledger.entity.js';

/**
 * A ledger as clients see it. Field names are part of the public API.
 * `organizationId` is not included: the caller already sent it in the header.
 */
export interface LedgerResponseDto {
  id: string;
  name: string;
  metadata: LedgerMetadata;
  /** ISO 8601 date in UTC, like `2026-11-03T10:00:00.000Z`. */
  createdAt: string;
}

export function toLedgerResponseDto(ledger: Ledger): LedgerResponseDto {
  return {
    id: ledger.id,
    name: ledger.name,
    metadata: ledger.metadata,
    createdAt: ledger.createdAt.toISOString(),
  };
}
