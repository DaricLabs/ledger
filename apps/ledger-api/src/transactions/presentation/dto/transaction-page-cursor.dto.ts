import { z } from 'zod';
import { cursorSchema, decodeCursor, encodeCursor } from '../../../core/pagination/cursor.js';
import type { ITransactionPosition } from '../../application/ports/transaction-repository.port.js';
import { transactionIdSchema } from './transaction-id.dto.js';

/**
 * The cursor of a page of transactions (see `core/pagination/cursor.ts` for
 * the format). Its content is `{"postedAt":"2026-11-07T10:00:00.000Z","id":"..."}`:
 * the `postedAt` and the `id` of the last transaction of the page. The next
 * page starts after that transaction, so it holds older ones.
 *
 * The date must be written the way `Date.toISOString()` writes it. We only make
 * cursors in that form, and one form means one meaning: the database refuses
 * dates it cannot read, and it reads some texts in a way we do not want.
 */
const cursorContentSchema = z.strictObject({
  postedAt: z.iso.datetime().refine(
    (text) => {
      const date = new Date(text);
      return !Number.isNaN(date.getTime()) && date.toISOString() === text;
    },
    { error: 'Must be a canonical date' },
  ),
  id: transactionIdSchema,
});

/** Makes the cursor of the page that follows a page whose last transaction is at this position. */
export function encodeTransactionCursor(lastTransaction: ITransactionPosition): string {
  return encodeCursor({
    postedAt: lastTransaction.postedAt.toISOString(),
    id: lastTransaction.id,
  });
}

/**
 * Reads a cursor.
 *
 * @returns The position the page starts after, or `null` when the text is not
 * a cursor we can read.
 */
export function decodeTransactionCursor(cursor: string): ITransactionPosition | null {
  const content = decodeCursor(cursor, cursorContentSchema);
  return content === null ? null : { postedAt: new Date(content.postedAt), id: content.id };
}

/**
 * The `cursor` query parameter. It turns the text into the position the page
 * starts after.
 */
export const transactionCursorSchema = cursorSchema(cursorContentSchema).transform(
  (content): ITransactionPosition => ({ postedAt: new Date(content.postedAt), id: content.id }),
);
