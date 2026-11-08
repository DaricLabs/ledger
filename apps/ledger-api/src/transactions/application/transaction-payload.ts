import type { Posting } from '../domain/posting.js';

/** A posting as it goes into the journal and into events. Amounts are strings, because JSON has no `bigint`. */
export interface IPostingPayload {
  source: string;
  destination: string;
  asset: string;
  amount: string;
}

/**
 * The postings of a transaction, in order, as plain data.
 *
 * Journal entries and events are public contracts, and a `bigint` cannot be
 * saved as JSON, so every amount is written as a decimal string.
 */
export function toPostingsPayload(postings: readonly Posting[]): IPostingPayload[] {
  return postings.map((posting) => ({
    source: posting.source.value,
    destination: posting.destination.value,
    asset: posting.asset.value,
    amount: posting.money.amount.toString(),
  }));
}
