import { metadataKeySchema, metadataSchema, saveMetadataSchema } from './metadata.dto.js';

describe('metadataKeySchema', () => {
  it('accepts a key and rejects an empty one', () => {
    expect(metadataKeySchema.safeParse('env').success).toBe(true);
    expect(metadataKeySchema.safeParse('').success).toBe(false);
  });
});

describe('metadataSchema', () => {
  it('accepts an object of string values, also an empty object', () => {
    expect(metadataSchema.safeParse({ env: 'prod', empty: '' }).success).toBe(true);
    expect(metadataSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ['a number value', { a: 1 }],
    ['a null value', { a: null }],
    ['an object value', { a: { b: 'c' } }],
    ['an empty key', { '': 'x' }],
    ['an array', ['x']],
    ['a string', 'x'],
  ])('rejects %s', (_label, value) => {
    expect(metadataSchema.safeParse(value).success).toBe(false);
  });
});

describe('saveMetadataSchema', () => {
  it('needs at least one key', () => {
    expect(saveMetadataSchema.safeParse({ env: 'prod' }).success).toBe(true);
    expect(saveMetadataSchema.safeParse({}).success).toBe(false);
  });
});
