import type { ILedgerPage } from '../../application/ports/ledger-repository.port.js';
import type { Ledger, LedgerMetadata } from '../../domain/entities/ledger.entity.js';
import { encodeLedgerCursor } from './ledger-page-cursor.dto.js';

/**
 * A ledger as clients see it. Field names are part of the public API.
 * `organizationId` is not included: the caller already sent it in the header.
 */
export interface ILedgerResponse {
  id: string;
  name: string;
  metadata: LedgerMetadata;
  /** ISO 8601 date in UTC, like `2026-11-03T10:00:00.000Z`. */
  createdAt: string;
}

export function toLedgerResponseDto(ledger: Ledger): ILedgerResponse {
  return {
    id: ledger.id,
    name: ledger.name,
    metadata: ledger.metadata,
    createdAt: ledger.createdAt.toISOString(),
  };
}

/** One page of `GET /ledgers`. Field names are part of the public API. */
export interface ILedgerPageResponse {
  /** The ledgers of this page, sorted by name. */
  data: ILedgerResponse[];
  /** `true` when there is a next page. */
  hasMore: boolean;
  /** The `cursor` that gets the next page. It is there only when `hasMore` is `true`. */
  next?: string;
}

export function toLedgerPageResponseDto(page: ILedgerPage): ILedgerPageResponse {
  const last = page.ledgers.at(-1);
  return {
    data: page.ledgers.map(toLedgerResponseDto),
    hasMore: page.hasMore,
    // `last` is always there when `hasMore` is true, because a page holds at
    // least one ledger. The check is only for the type.
    next: page.hasMore && last !== undefined ? encodeLedgerCursor(last.name) : undefined,
  };
}
