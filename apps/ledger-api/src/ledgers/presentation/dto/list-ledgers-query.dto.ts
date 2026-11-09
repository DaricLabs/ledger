import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, pageSizeSchema } from '../../../core/pagination/page-size.js';
import { ledgerCursorSchema } from './ledger-page-cursor.dto.js';

/**
 * Query string of `GET /ledgers`.
 *
 * Unknown parameters are rejected on purpose, like unknown body fields on
 * create: a typo like `pagesize` would otherwise be ignored without a word.
 * It also means that adding a parameter later (like `reverse`) is safe.
 */
export const listLedgersQuerySchema = z.strictObject({
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
  /** After parsing, this is the ledger name the page starts after. */
  cursor: ledgerCursorSchema.optional(),
});

export type ListLedgersQueryDto = z.infer<typeof listLedgersQuerySchema>;
