import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageSizeSchema } from './page-size.js';

describe('pageSizeSchema', () => {
  it('turns digits into a number', () => {
    expect(pageSizeSchema.parse('10')).toBe(10);
  });

  it('accepts the smallest and the biggest size', () => {
    expect(pageSizeSchema.parse('1')).toBe(1);
    expect(pageSizeSchema.parse(String(MAX_PAGE_SIZE))).toBe(MAX_PAGE_SIZE);
  });

  it.each([
    ['zero', '0'],
    ['one more than the biggest size', String(MAX_PAGE_SIZE + 1)],
    ['an empty text', ''],
    ['a negative number', '-1'],
    ['a decimal', '1.5'],
    ['a hexadecimal number', '0x10'],
    ['an exponent', '1e1'],
    ['text with spaces', ' 5 '],
    ['a value that is not text', 5],
  ])('refuses %s', (_title, value) => {
    expect(pageSizeSchema.safeParse(value).success).toBe(false);
  });

  it('keeps the default inside the allowed range', () => {
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });
});
