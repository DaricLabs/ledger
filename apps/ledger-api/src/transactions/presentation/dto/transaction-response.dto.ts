import type { MetadataEntries } from '@ledger/domain';
import type { ITransactionPage } from '../../application/ports/transaction-repository.port.js';
import type { Posting } from '../../domain/value-objects/posting.vo.js';
import type { Transaction } from '../../domain/entities/transaction.entity.js';
import { encodeTransactionCursor } from './transaction-page-cursor.dto.js';

/** A posting as clients see it. Field names are part of the public API. */
export interface IPostingResponse {
  source: string;
  destination: string;
  asset: string;
  /** A string of digits, in the smallest unit of the asset, like `"1050"`. */
  amount: string;
}

/**
 * A transaction as clients see it. Field names are part of the public API.
 * `organizationId` and `ledgerId` are not included: the caller already knows
 * them from the header and the URL.
 */
export interface ITransactionResponse {
  id: string;
  /** The id the caller gave to the transaction, or `null`. */
  reference: string | null;
  postings: IPostingResponse[];
  /** The key/value pairs of the caller. An empty object when there are none. */
  metadata: MetadataEntries;
  /** When the transaction happened. ISO 8601 date in UTC, like `2026-11-07T10:00:00.000Z`. */
  postedAt: string;
  /** When the ledger saved it. ISO 8601 date in UTC. */
  createdAt: string;
  /** When the transaction was reverted. ISO 8601 date in UTC, or `null` if it was not reverted. */
  revertedAt: string | null;
  /** The id of the transaction that reverted this one, or `null` if it was not reverted. */
  revertedByTransactionId: string | null;
}

function toPostingResponseDto(posting: Posting): IPostingResponse {
  return {
    source: posting.source.value,
    destination: posting.destination.value,
    asset: posting.asset.value,
    amount: posting.money.amount.toString(),
  };
}

export function toTransactionResponseDto(transaction: Transaction): ITransactionResponse {
  return {
    id: transaction.id,
    reference: transaction.reference,
    postings: transaction.postings.map(toPostingResponseDto),
    metadata: transaction.metadata.entries,
    postedAt: transaction.postedAt.toISOString(),
    createdAt: transaction.createdAt.toISOString(),
    revertedAt: transaction.revertedAt?.toISOString() ?? null,
    revertedByTransactionId: transaction.revertedByTransactionId,
  };
}

/** One page of `GET /ledgers/:ledgerName/transactions`. Field names are part of the public API. */
export interface ITransactionPageResponse {
  /** The transactions of this page, newest first. */
  data: ITransactionResponse[];
  /** `true` when there is a next page. */
  hasMore: boolean;
  /** The `cursor` that gets the next page. It is there only when `hasMore` is `true`. */
  next?: string;
}

export function toTransactionPageResponseDto(page: ITransactionPage): ITransactionPageResponse {
  const last = page.transactions.at(-1);
  return {
    data: page.transactions.map(toTransactionResponseDto),
    hasMore: page.hasMore,
    // `last` is always there when `hasMore` is true, because a page holds at
    // least one transaction. The check is only for the type.
    next:
      page.hasMore && last !== undefined
        ? encodeTransactionCursor({ postedAt: last.postedAt, id: last.id })
        : undefined,
  };
}
