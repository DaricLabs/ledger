import { z } from 'zod';
import { cursorSchema, decodeCursor, encodeCursor, MAX_CURSOR_LENGTH } from './cursor.dto.js';

/** Makes a cursor from any JSON text, the way a client could by hand. */
const cursorOf = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

const content = z.strictObject({ key: z.string().min(1) });

describe('cursor', () => {
  describe('encodeCursor', () => {
    it('has a fixed format, because clients keep cursors', () => {
      // If this test fails, cursors that clients already hold may stop working.
      expect(encodeCursor({ key: 'main' })).toBe('eyJrZXkiOiJtYWluIn0');
    });

    it.each([
      ['the characters + and /', { key: '????>>>>' }],
      ['padding', { key: 'ÿ?' }],
    ])('makes URL-safe text, with no %s', (_title, content) => {
      // Plain base64 of the same content does have them, so this test can fail.
      const plain = Buffer.from(JSON.stringify(content)).toString('base64');

      expect(plain).toMatch(/[+/=]/);
      expect(encodeCursor(content)).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('decodeCursor', () => {
    it('gives back the content that was encoded', () => {
      expect(decodeCursor(encodeCursor({ key: 'main' }), content)).toEqual({ key: 'main' });
    });

    it('gives back the content the schema makes, not the raw JSON', () => {
      const withNumber = z.strictObject({ n: z.string().transform(Number) });

      expect(decodeCursor(encodeCursor({ n: '5' }), withNumber)).toEqual({ n: 5 });
    });

    it.each([
      ['an empty text', ''],
      ['text that is not base64url', 'not a cursor!'],
      ['padding characters', `${cursorOf('{"key":"main"}')}==`],
      ['base64url of text that is not JSON', cursorOf('main')],
      ['JSON that is not an object', cursorOf('"main"')],
      ['JSON null', cursorOf('null')],
      ['an object the schema refuses', cursorOf('{"key":""}')],
      ['an unknown field', cursorOf('{"key":"main","back":true}')],
    ])('returns null for %s', (_title, cursor) => {
      expect(decodeCursor(cursor, content)).toBeNull();
    });

    it('returns null for a cursor that is too long, even when the content is fine', () => {
      const long = z.strictObject({ key: z.string() });
      const cursor = encodeCursor({ key: 'x'.repeat(MAX_CURSOR_LENGTH) });

      expect(cursor.length).toBeGreaterThan(MAX_CURSOR_LENGTH);
      expect(decodeCursor(cursor, long)).toBeNull();
    });
  });

  describe('cursorSchema', () => {
    it('turns a cursor into its content', () => {
      expect(cursorSchema(content).parse(encodeCursor({ key: 'main' }))).toEqual({ key: 'main' });
    });

    it('refuses a bad cursor without repeating it in the message', () => {
      const result = cursorSchema(content).safeParse('secret-looking-text!');

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain('secret-looking-text');
    });

    it('refuses a value that is not text', () => {
      expect(cursorSchema(content).safeParse(5).success).toBe(false);
    });
  });
});
