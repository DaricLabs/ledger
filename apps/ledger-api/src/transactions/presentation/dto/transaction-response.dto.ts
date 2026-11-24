import { z } from 'zod';
import { accountAddressSchema } from '../../../accounts/presentation/dto/account-address.dto.js';
import { pageResponseSchema } from '../../../core/pagination/page-response.dto.js';
import { isoDateTimeSchema } from '../../../core/validation/iso-date-time.dto.js';
import { metadataSchema } from '../../../core/validation/metadata.dto.js';
import type { ITransactionPage } from '../../application/ports/transaction-repository.port.js';
import type { Posting } from '../../domain/value-objects/posting.vo.js';
import type { Transaction } from '../../domain/entities/transaction.entity.js';
import { transactionIdSchema } from './transaction-id.dto.js';
import { encodeTransactionCursor } from './transaction-page-cursor.dto.js';

/** A posting as clients see it. Field names are part of the public API. */
export const postingResponseSchema = z.object({
  source: accountAddressSchema.meta({ description: 'The account the money leaves.' }),
  destination: accountAddressSchema.meta({ description: 'The account the money goes to.' }),
  asset: z.string().meta({ description: 'Code of the asset.', examples: ['USD'] }),
  amount: z.string().meta({
    description: 'A string of digits, in the smallest unit of the asset, like `"1050"`.',
    examples: ['1050'],
  }),
});

/**
 * A transaction as clients see it. Field names are part of the public API.
 * `organizationId` and `ledgerId` are not included: the caller already knows
 * them from the header and the URL.
 */
export const transactionResponseSchema = z.object({
  id: transactionIdSchema,
  reference: z
    .string()
    .nullable()
    .meta({ description: 'The id the caller gave to the transaction, or `null`.' }),
  postings: z.array(postingResponseSchema).meta({ description: 'The moves of money, in order.' }),
  metadata: metadataSchema,
  postedAt: isoDateTimeSchema.meta({ description: 'When the transaction happened.' }),
  createdAt: isoDateTimeSchema.meta({ description: 'When the ledger saved the transaction.' }),
  revertedAt: isoDateTimeSchema
    .nullable()
    .meta({ description: 'When the transaction was reverted, or `null` if it was not.' }),
  revertedByTransactionId: transactionIdSchema.nullable().meta({
    description:
      'The id of the transaction that reverted this one, or `null` if it was not reverted.',
  }),
});

export type PostingResponseDto = z.infer<typeof postingResponseSchema>;
export type TransactionResponseDto = z.infer<typeof transactionResponseSchema>;

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
    metadata: transaction.metadata.entries,
    postedAt: transaction.postedAt.toISOString(),
    createdAt: transaction.createdAt.toISOString(),
    revertedAt: transaction.revertedAt?.toISOString() ?? null,
    revertedByTransactionId: transaction.revertedByTransactionId,
  };
}

/** One page of `GET /ledgers/:ledgerName/transactions`. Field names are part of the public API. */
export const transactionPageResponseSchema = pageResponseSchema(
  transactionResponseSchema,
  'newest first',
);

export type TransactionPageResponseDto = z.infer<typeof transactionPageResponseSchema>;

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
