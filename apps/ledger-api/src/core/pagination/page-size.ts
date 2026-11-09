import { z } from 'zod';

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
 * The `pageSize` query parameter of a list endpoint.
 *
 * Query string values are always text, so this checks the text is only digits
 * before it turns it into a number. (`Number()` alone would accept `0x10`,
 * `1e1` and `" 5 "`.) Use `.default(DEFAULT_PAGE_SIZE)` where it is needed.
 */
export const pageSizeSchema = z
  .string()
  .regex(/^[0-9]+$/, { error: PAGE_SIZE_ERROR })
  .transform(Number)
  .pipe(
    z.number().min(1, { error: PAGE_SIZE_ERROR }).max(MAX_PAGE_SIZE, { error: PAGE_SIZE_ERROR }),
  );
