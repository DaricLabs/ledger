import { z } from 'zod';

/**
 * A point in time in a response: the text `Date.toISOString()` gives, which is
 * ISO 8601 in UTC, like `2026-11-03T10:00:00.000Z`.
 *
 * It is a plain string with `format: date-time` on purpose. `z.iso.datetime()`
 * would also write a very long `pattern` in the API description, and the
 * ledger makes these values itself, so nobody needs to check them.
 */
export const isoDateTimeSchema = z.string().meta({
  format: 'date-time',
  description: 'ISO 8601 date in UTC.',
  examples: ['2026-11-03T10:00:00.000Z'],
});
