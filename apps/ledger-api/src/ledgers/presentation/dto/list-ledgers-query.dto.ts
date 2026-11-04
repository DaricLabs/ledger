import { z } from 'zod';
import { ledgerCursorSchema } from './ledger-page-cursor.dto.js';

/** Page size when the client sends none. */
export const DEFAULT_PAGE_SIZE = 15;

/**
 * Biggest page size. A bigger value is refused, not cut down. Refusing is the
 * safe start: we can accept more values later, but we cannot refuse values
 * that clients already use.
 */
export const MAX_PAGE_SIZE = 100;

const PAGE_SIZE_ERROR = `Must be a whole number from 1 to ${MAX_PAGE_SIZE}`;

/**
 * Query string values are always text, so this checks the text is only digits
 * before it turns it into a number. (`Number()` alone would accept `0x10`,
 * `1e1` and `" 5 "`.)
 */
const pageSizeSchema = z
  .string()
  .regex(/^[0-9]+$/, { error: PAGE_SIZE_ERROR })
  .transform(Number)
  .pipe(
    z.number().min(1, { error: PAGE_SIZE_ERROR }).max(MAX_PAGE_SIZE, { error: PAGE_SIZE_ERROR }),
  );

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
