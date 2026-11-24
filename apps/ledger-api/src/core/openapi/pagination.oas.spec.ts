import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageSizeSchema } from '../pagination/page-size.dto.js';
import { MAX_CURSOR_LENGTH } from '../pagination/cursor.dto.js';
import { paginationOpenApi } from './pagination.oas.js';

/**
 * The parameters are written by hand (see the file), so these tests keep them
 * from drifting away from the schemas that really check the query string.
 */
describe('paginationOpenApi', () => {
  const pageSize = paginationOpenApi.parameters?.PageSize.schema as Record<string, unknown>;
  const cursor = paginationOpenApi.parameters?.Cursor.schema as Record<string, unknown>;

  it('says that pageSize is an integer with the range and default the schema uses', () => {
    expect(pageSize).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: MAX_PAGE_SIZE,
      default: DEFAULT_PAGE_SIZE,
    });
  });

  it.each([
    ['1', true],
    [String(MAX_PAGE_SIZE), true],
    ['0', false],
    [String(MAX_PAGE_SIZE + 1), false],
  ])('accepts exactly what it says: pageSize %s -> %s', (value, accepted) => {
    expect(pageSizeSchema.safeParse(value).success).toBe(accepted);
  });

  it('says that the cursor is a short base64url text', () => {
    expect(cursor).toMatchObject({ type: 'string', maxLength: MAX_CURSOR_LENGTH });
    expect(new RegExp(cursor.pattern as string).test('eyJrZXkiOiJtYWluIn0')).toBe(true);
    expect(new RegExp(cursor.pattern as string).test('not a cursor!')).toBe(false);
  });

  it('is optional for both', () => {
    expect(paginationOpenApi.parameters?.PageSize.required).toBeUndefined();
    expect(paginationOpenApi.parameters?.Cursor.required).toBeUndefined();
  });
});
