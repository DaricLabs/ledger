import type { ITransactionPage } from '../../application/ports/transaction-repository.port.js';
import type { Posting } from '../../domain/posting.js';
import type { Transaction } from '../../domain/transaction.entity.js';
import { encodeTransactionCursor } from './transaction-page-cursor.dto.js';

/** A posting as clients see it. Field names are part of the public API. */
export interface PostingResponseDto {
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
export interface TransactionResponseDto {
  id: string;
  /** The id the caller gave to the transaction, or `null`. */
  reference: string | null;
  postings: PostingResponseDto[];
  /** When the transaction happened. ISO 8601 date in UTC, like `2026-11-07T10:00:00.000Z`. */
  postedAt: string;
  /** When the ledger saved it. ISO 8601 date in UTC. */
  createdAt: string;
}

function toPostingResponseDto(posting: Posting): PostingResponseDto {
  return {
    source: posting.source.value,
    destination: posting.destination.value,
    asset: posting.asset.value,
    amount: posting.money.amount.toString(),
  };
}

export function toTransactionResponseDto(transaction: Transaction): TransactionResponseDto {
  return {
    id: transaction.id,
    reference: transaction.reference,
    postings: transaction.postings.map(toPostingResponseDto),
    postedAt: transaction.postedAt.toISOString(),
    createdAt: transaction.createdAt.toISOString(),
  };
}

/** One page of `GET /ledgers/:ledgerName/transactions`. Field names are part of the public API. */
export interface TransactionPageResponseDto {
  /** The transactions of this page, newest first. */
  data: TransactionResponseDto[];
  /** `true` when there is a next page. */
  hasMore: boolean;
  /** The `cursor` that gets the next page. It is there only when `hasMore` is `true`. */
  next?: string;
}

export function toTransactionPageResponseDto(page: ITransactionPage): TransactionPageResponseDto {
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
