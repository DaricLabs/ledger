import {
  decodeTransactionCursor,
  encodeTransactionCursor,
  transactionCursorSchema,
} from './transaction-page-cursor.dto.js';

const ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const POSTED_AT = new Date('2026-11-07T10:00:00.123Z');

/** Makes a cursor from any JSON text, the way a client could by hand. */
const cursorOf = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const contentOf = (postedAt: string, id = ID) => cursorOf(JSON.stringify({ postedAt, id }));

describe('transaction page cursor', () => {
  it('has a fixed format, because clients keep cursors', () => {
    // If this test fails, cursors that clients already hold may stop working.
    expect(
      Buffer.from(encodeTransactionCursor({ postedAt: POSTED_AT, id: ID }), 'base64url').toString(),
    ).toBe(`{"postedAt":"2026-11-07T10:00:00.123Z","id":"${ID}"}`);
  });

  it('gives back the position that was encoded', () => {
    const position = { postedAt: POSTED_AT, id: ID };

    expect(decodeTransactionCursor(encodeTransactionCursor(position))).toEqual(position);
  });

  it('keeps the milliseconds of the date', () => {
    const decoded = decodeTransactionCursor(
      encodeTransactionCursor({ postedAt: POSTED_AT, id: ID }),
    );

    expect(decoded?.postedAt.getTime()).toBe(POSTED_AT.getTime());
  });

  it('makes a cursor that is short enough to be read', () => {
    const cursor = encodeTransactionCursor({ postedAt: POSTED_AT, id: ID });

    expect(decodeTransactionCursor(cursor)).not.toBeNull();
    expect(cursor.length).toBeLessThan(150);
  });

  describe('decode returns null for', () => {
    it.each([
      ['an empty text', ''],
      ['text that is not base64url', 'not a cursor!'],
      ['base64url of text that is not JSON', cursorOf('main')],
      ['an empty object', cursorOf('{}')],
      ['a missing id', cursorOf('{"postedAt":"2026-11-07T10:00:00.123Z"}')],
      ['a missing date', cursorOf(`{"id":"${ID}"}`)],
      ['a date that is not text', cursorOf(`{"postedAt":5,"id":"${ID}"}`)],
      ['a date that is not a date', contentOf('yesterday')],
      ['a date without milliseconds', contentOf('2026-11-07T10:00:00Z')],
      ['a date with an offset', contentOf('2026-11-07T10:00:00.123+02:00')],
      ['a date with more than milliseconds', contentOf('2026-11-07T10:00:00.123456Z')],
      ['a date that does not exist', contentOf('2026-02-31T10:00:00.000Z')],
      ['an id that is not a UUIDv7', contentOf('2026-11-07T10:00:00.123Z', 'abc')],
      [
        'an id that is a UUIDv4',
        contentOf('2026-11-07T10:00:00.123Z', '3b241101-e2bb-4255-8caf-4136c566a962'),
      ],
      [
        'an unknown field',
        cursorOf(`{"postedAt":"2026-11-07T10:00:00.123Z","id":"${ID}","back":true}`),
      ],
    ])('%s', (_title, cursor) => {
      expect(decodeTransactionCursor(cursor)).toBeNull();
    });
  });

  describe('transactionCursorSchema', () => {
    it('turns a cursor into the position', () => {
      const position = { postedAt: POSTED_AT, id: ID };

      expect(transactionCursorSchema.parse(encodeTransactionCursor(position))).toEqual(position);
    });

    it('refuses a bad cursor without repeating it in the message', () => {
      const result = transactionCursorSchema.safeParse('secret-looking-text!');

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain('secret-looking-text');
    });
  });
});
