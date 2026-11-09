import { ACCOUNT_ADDRESS_MAX_LENGTH } from '@ledger/domain';
import {
  accountCursorSchema,
  decodeAccountCursor,
  encodeAccountCursor,
} from './account-page-cursor.dto.js';

/** Makes a cursor from any JSON text, the way a client could by hand. */
const cursorOf = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe('account page cursor', () => {
  it('has a fixed format, because clients keep cursors', () => {
    // If this test fails, cursors that clients already hold may stop working.
    expect(encodeAccountCursor('users:1')).toBe('eyJrZXkiOiJ1c2VyczoxIn0');
  });

  it('gives back the address that was encoded', () => {
    const addresses = [
      'world',
      'users:42',
      'platform:fees:eu',
      'a'.repeat(ACCOUNT_ADDRESS_MAX_LENGTH),
    ];

    for (const address of addresses) {
      expect(decodeAccountCursor(encodeAccountCursor(address))).toBe(address);
    }
  });

  it('makes URL-safe text with no padding', () => {
    expect(encodeAccountCursor('platform:fees:eu')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  describe('decode returns null for', () => {
    it.each([
      ['an empty text', ''],
      ['text that is not base64url', 'not a cursor!'],
      ['padding characters', `${cursorOf('{"key":"world"}')}==`],
      ['base64url of text that is not JSON', cursorOf('world')],
      ['JSON that is not an object', cursorOf('"world"')],
      ['JSON null', cursorOf('null')],
      ['an empty object', cursorOf('{}')],
      ['a key that is not a string', cursorOf('{"key":5}')],
      ['a key that is not a valid address', cursorOf('{"key":"Not Valid"}')],
      ['an empty key', cursorOf('{"key":""}')],
      ['an unknown field', cursorOf('{"key":"world","back":true}')],
      ['a cursor that is too long', cursorOf(`{"key":"world","pad":"${'x'.repeat(300)}"}`)],
    ])('%s', (_title, cursor) => {
      expect(decodeAccountCursor(cursor)).toBeNull();
    });
  });

  describe('accountCursorSchema', () => {
    it('turns a cursor into the address', () => {
      expect(accountCursorSchema.parse(encodeAccountCursor('users:1'))).toBe('users:1');
    });

    it('refuses a bad cursor without repeating it in the message', () => {
      const result = accountCursorSchema.safeParse('secret-looking-text!');

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain('secret-looking-text');
    });

    it('refuses a value that is not text', () => {
      expect(accountCursorSchema.safeParse(5).success).toBe(false);
    });
  });
});
