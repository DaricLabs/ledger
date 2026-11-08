import type { Posting } from '../../domain/posting.js';
import type { Transaction } from '../../domain/transaction.entity.js';

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
