import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  ledgerCursorSchema,
} from './ledger-page-cursor.dto.js';

/** Makes a cursor from any JSON text, the way a client could by hand. */
const cursorOf = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe('ledger page cursor', () => {
  it('has a fixed format, because clients keep cursors', () => {
    // If this test fails, cursors that clients already hold may stop working.
    expect(encodeLedgerCursor('main')).toBe('eyJrZXkiOiJtYWluIn0');
  });

  it('gives back the name that was encoded', () => {
    const names = ['main', 'a', 'my-ledger_2', 'a'.repeat(63)];

    for (const name of names) {
      expect(decodeLedgerCursor(encodeLedgerCursor(name))).toBe(name);
    }
  });

  it('makes URL-safe text with no padding', () => {
    // The longest name gives the longest cursor.
    expect(encodeLedgerCursor('a'.repeat(63))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  describe('decode returns null for', () => {
    it.each([
      ['an empty text', ''],
      ['text that is not base64url', 'not a cursor!'],
      ['padding characters', `${cursorOf('{"key":"main"}')}==`],
      ['base64url of text that is not JSON', cursorOf('main')],
      ['JSON that is not an object', cursorOf('"main"')],
      ['JSON null', cursorOf('null')],
      ['an empty object', cursorOf('{}')],
      ['a key that is not a string', cursorOf('{"key":5}')],
      ['a key that is not a valid ledger name', cursorOf('{"key":"Not Valid"}')],
      ['an empty key', cursorOf('{"key":""}')],
      ['an unknown field', cursorOf('{"key":"main","back":true}')],
      ['a cursor that is too long', cursorOf(`{"key":"main","pad":"${'x'.repeat(300)}"}`)],
    ])('%s', (_title, cursor) => {
      expect(decodeLedgerCursor(cursor)).toBeNull();
    });
  });

  describe('ledgerCursorSchema', () => {
    it('turns a cursor into the ledger name', () => {
      expect(ledgerCursorSchema.parse(encodeLedgerCursor('main'))).toBe('main');
    });

    it('refuses a bad cursor without repeating it in the message', () => {
      const result = ledgerCursorSchema.safeParse('secret-looking-text!');

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain('secret-looking-text');
    });

    it('refuses a value that is not text', () => {
      expect(ledgerCursorSchema.safeParse(5).success).toBe(false);
    });
  });
});
