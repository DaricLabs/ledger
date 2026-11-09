import { z } from 'zod';
import { cursorSchema, decodeCursor, encodeCursor } from '../../../core/pagination/cursor.js';
import { ledgerNameSchema } from './ledger-name.dto.js';

/**
 * The cursor of a page of ledgers (see `core/pagination/cursor.ts` for the
 * format). Its content is `{"key":"main"}`, where `key` is the name of the
 * last ledger of the page. The next page starts after that name.
 */
const cursorContentSchema = z.strictObject({ key: ledgerNameSchema });

/** Makes the cursor of the page that follows a page whose last ledger has this name. */
export function encodeLedgerCursor(lastLedgerName: string): string {
  return encodeCursor({ key: lastLedgerName });
}

/**
 * Reads a cursor.
 *
 * @returns The ledger name the page starts after, or `null` when the text is
 * not a cursor we can read.
 */
export function decodeLedgerCursor(cursor: string): string | null {
  return decodeCursor(cursor, cursorContentSchema)?.key ?? null;
}

/**
 * The `cursor` query parameter. It turns the text into the ledger name the page
 * starts after. The key must be a valid ledger name, because the database
 * refuses other values when it compares them with a name.
 */
export const ledgerCursorSchema = cursorSchema(cursorContentSchema).transform(
  (content) => content.key,
);
