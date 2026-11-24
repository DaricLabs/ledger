import { CURSOR_PATTERN, MAX_CURSOR_LENGTH } from '../pagination/cursor.dto.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../pagination/page-size.dto.js';
import { parameterRef } from './openapi-document.builder.js';
import type { IOpenApiModule } from './openapi.type.js';

/**
 * The two query parameters that every list endpoint has.
 *
 * They are written by hand, and not read from `pageSizeSchema` and
 * `cursorSchema`, because those schemas describe the text we receive and
 * clients should read what they send. A query string is always text, so the
 * schema checks the digits and turns them into a number, but a client wants to
 * see `integer` with a range and a default. The numbers come from the same
 * constants as the schemas, and `pagination.oas.spec.ts` checks that the
 * two say the same.
 */
export const paginationOpenApi: IOpenApiModule = {
  parameters: {
    PageSize: {
      in: 'query',
      name: 'pageSize',
      description: 'How many items one page has at most.',
      schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    },
    Cursor: {
      in: 'query',
      name: 'cursor',
      description:
        'Where the page starts. Send the `next` of the previous page, unchanged. ' +
        'Leave it out for the first page. Do not build or read cursors: their content can change.',
      schema: { type: 'string', maxLength: MAX_CURSOR_LENGTH, pattern: CURSOR_PATTERN.source },
    },
  },
};

/** What can be wrong with the query of a list, for a `VALIDATION` error. The maximum is the real one. */
export const PAGINATION_VALIDATION_ERROR = `\`pageSize\` is not a whole number from 1 to ${MAX_PAGE_SIZE}, the \`cursor\` is not one we gave, or a query parameter is unknown.`;

/** The `pageSize` and `cursor` parameters, for the `parameters` of a list operation. */
export const PAGINATION_PARAMETERS = [parameterRef('PageSize'), parameterRef('Cursor')];
