import { z } from 'zod';
import { ledgerNameSchema } from './ledger-name.dto.js';

/**
 * The cursor of a page of ledgers: an opaque text that a client gets in the
 * `next` field of a response and sends back as `cursor` to read the next page.
 *
 * It is the base64url (no padding) of a JSON object like `{"key":"main"}`, where
 * `key` is the name of the last ledger of the page. The next page starts after
 * that name. This is the same format Formance uses for its page tokens.
 *
 * Clients must not build or read cursors. That is what lets us add fields to
 * the JSON later (for example a direction, to go back a page) without breaking
 * cursors that clients already hold, because every added field is optional.
 */
const cursorContentSchema = z.strictObject({ key: ledgerNameSchema });

/** The characters of base64url. Node's decoder would silently skip anything else. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A cursor for the longest ledger name is about 100 characters, so this is generous. */
const MAX_CURSOR_LENGTH = 200;

/** Makes the cursor of the page that follows a page whose last ledger has this name. */
export function encodeLedgerCursor(lastLedgerName: string): string {
  return Buffer.from(JSON.stringify({ key: lastLedgerName }), 'utf8').toString('base64url');
}

/**
 * Reads a cursor.
 *
 * @returns The ledger name the page starts after, or `null` when the text is
 * not a cursor we can read.
 */
export function decodeLedgerCursor(cursor: string): string | null {
  if (cursor.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(cursor)) {
    return null;
  }
  let content: unknown;
  try {
    content = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = cursorContentSchema.safeParse(content);
  return parsed.success ? parsed.data.key : null;
}

/**
 * The `cursor` query parameter. It turns the text into the ledger name the page
 * starts after. The key must be a valid ledger name, because the database
 * refuses other values when it compares them with a name.
 *
 * The message never repeats the cursor, and does not say why it was refused.
 */
export const ledgerCursorSchema = z.string().transform((cursor, ctx) => {
  const name = decodeLedgerCursor(cursor);
  if (name === null) {
    ctx.issues.push({
      code: 'custom',
      message: 'Must be the "next" value of a previous response, unchanged',
      input: cursor,
    });
    return z.NEVER;
  }
  return name;
});
