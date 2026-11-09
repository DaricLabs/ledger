import { z } from 'zod';
import { cursorSchema, decodeCursor, encodeCursor } from '../../../core/pagination/cursor.js';
import { accountAddressSchema } from './account-address.dto.js';

/**
 * The cursor of a page of accounts (see `core/pagination/cursor.ts` for the
 * format). Its content is `{"key":"users:42"}`, where `key` is the address of
 * the last account of the page. The next page starts after that address.
 */
const cursorContentSchema = z.strictObject({ key: accountAddressSchema });

/** Makes the cursor of the page that follows a page whose last account has this address. */
export function encodeAccountCursor(lastAccountAddress: string): string {
  return encodeCursor({ key: lastAccountAddress });
}

/**
 * Reads a cursor.
 *
 * @returns The address the page starts after, or `null` when the text is not
 * a cursor we can read.
 */
export function decodeAccountCursor(cursor: string): string | null {
  return decodeCursor(cursor, cursorContentSchema)?.key ?? null;
}

/**
 * The `cursor` query parameter. It turns the text into the address the page
 * starts after. The key must be a valid address, because the database refuses
 * other values when it compares them with an address.
 */
export const accountCursorSchema = cursorSchema(cursorContentSchema).transform(
  (content) => content.key,
);
