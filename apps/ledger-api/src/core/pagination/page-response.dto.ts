import { z } from 'zod';

/**
 * The shape of one page of a list endpoint. Every list answers with it, so a
 * client can read all lists the same way. Field names are part of the public
 * API.
 *
 * @param item Schema of one item of the page.
 * @param order How the items are sorted, for the description of `data`.
 */
export function pageResponseSchema<Item extends z.ZodType>(item: Item, order: string) {
  return z.object({
    data: z.array(item).meta({ description: `The items of this page, ${order}.` }),
    hasMore: z.boolean().meta({ description: '`true` when there is a next page.' }),
    next: z.string().optional().meta({
      description:
        'The `cursor` that gets the next page. It is there only when `hasMore` is `true`.',
    }),
  });
}
