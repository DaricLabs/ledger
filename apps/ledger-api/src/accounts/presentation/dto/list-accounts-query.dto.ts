import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, pageSizeSchema } from '../../../core/pagination/page-size.js';
import { accountCursorSchema } from './account-page-cursor.dto.js';

/**
 * Query string of `GET /ledgers/:ledgerName/accounts`.
 *
 * Unknown parameters are rejected on purpose: a typo like `pagesize` would
 * otherwise be ignored without a word. It also means that adding a filter
 * later (like an address prefix) is safe.
 */
export const listAccountsQuerySchema = z.strictObject({
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
  /** After parsing, this is the address the page starts after. */
  cursor: accountCursorSchema.optional(),
});

export type ListAccountsQueryDto = z.infer<typeof listAccountsQuerySchema>;
