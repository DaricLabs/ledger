import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, pageSizeSchema } from '../../../core/pagination/page-size.dto.js';
import { transactionCursorSchema } from './transaction-page-cursor.dto.js';

/**
 * Query string of `GET /ledgers/:ledgerName/transactions`.
 *
 * Unknown parameters are rejected on purpose: a typo like `pagesize` would
 * otherwise be ignored without a word. It also means that adding a filter
 * later (like `account` or `reference`) is safe.
 */
export const listTransactionsQuerySchema = z.strictObject({
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
  /** After parsing, this is the position of the transaction the page starts after. */
  cursor: transactionCursorSchema.optional(),
});

export type ListTransactionsQueryDto = z.infer<typeof listTransactionsQuerySchema>;
