import { z } from 'zod';
import { CURSOR_PATTERN, MAX_CURSOR_LENGTH } from './cursor.dto.js';

/**
 * The shape of one page of a list endpoint. Every list answers with it, so a
 * client can read all lists the same way. Field names are part of the public
 * API.
 *
 * `next` has the shape of the `cursor` parameter that takes it back. The rule
 * "`next` is there if and only if `hasMore` is `true`" is a rule between two
 * fields, which a Zod object cannot say, so it is written in the API
 * description (`oneOf`). The mappers keep it true, and a client that
 * checks responses against the description can rely on it.
 *
 * @param item Schema of one item of the page.
 * @param order How the items are sorted, for the description of `data`.
 */
export function pageResponseSchema<Item extends z.ZodType>(item: Item, order: string) {
  return z
    .object({
      data: z.array(item).meta({ description: `The items of this page, ${order}.` }),
      hasMore: z.boolean().meta({ description: '`true` when there is a next page.' }),
      next: z.string().max(MAX_CURSOR_LENGTH).regex(CURSOR_PATTERN).optional().meta({
        description:
          'The `cursor` that gets the next page. It is there only when `hasMore` is `true`.',
      }),
    })
    .meta({
      oneOf: [
        { properties: { hasMore: { const: true } }, required: ['next'] },
        { properties: { hasMore: { const: false } }, not: { required: ['next'] } },
      ],
    });
}
