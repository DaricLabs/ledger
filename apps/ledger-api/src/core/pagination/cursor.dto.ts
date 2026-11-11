import { z } from 'zod';

/** The characters of base64url. Node's decoder would silently skip anything else. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The longest cursor we read. A cursor is a small JSON object, so this is
 * generous, and it keeps a client from sending a huge text to be decoded.
 *
 * It must be at least as long as the longest cursor we make. Today that is the
 * cursor of a page of accounts whose last address has the longest allowed
 * length (256 characters), which is 355 characters. If a cursor we made were
 * longer than this limit, the client could not read the page after it.
 */
export const MAX_CURSOR_LENGTH = 400;

/**
 * Makes a cursor: an opaque text that a client gets in the `next` field of a
 * page and sends back as `cursor` to read the page after it.
 *
 * It is the base64url (no padding) of a JSON object that holds the position of
 * the last item of the page. The content decides what the next page starts
 * after, and each list endpoint has its own content.
 *
 * Clients must not build or read cursors. That is what lets us add fields to
 * the content later (for example a direction, to go back a page) without
 * breaking cursors that clients already hold, because every added field is
 * optional.
 */
export function encodeCursor(content: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(content), 'utf8').toString('base64url');
}

/**
 * Reads a cursor, and checks its content with the schema of the endpoint.
 *
 * @returns The content, or `null` when the text is not a cursor this endpoint
 * could have made.
 */
export function decodeCursor<Content>(cursor: string, content: z.ZodType<Content>): Content | null {
  if (cursor.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(cursor)) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = content.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The `cursor` query parameter of a list endpoint. It turns the text into the
 * content the schema describes.
 *
 * The message never repeats the cursor, and does not say why it was refused.
 */
export function cursorSchema<Content>(content: z.ZodType<Content>) {
  return z.string().transform((cursor, ctx) => {
    const decoded = decodeCursor(cursor, content);
    if (decoded === null) {
      ctx.issues.push({
        code: 'custom',
        message: 'Must be the "next" value of a previous response, unchanged',
        input: cursor,
      });
      return z.NEVER;
    }
    return decoded;
  });
}
