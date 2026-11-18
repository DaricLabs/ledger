import { InvalidMetadataError } from '../errors/invalid-metadata.error.js';
import { MetadataLimitExceededError } from '../errors/metadata-limit-exceeded.error.js';
import { METADATA_LIMITS, Metadata, type MetadataEntries } from './metadata.vo.js';

const LIMITS = METADATA_LIMITS;

/** `count` entries with short keys (`k0`, `k1`, ...) and empty values. */
function entries(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, '']));
}

/** Runs `action` and gives back the limit error it throws. Fails if it throws nothing else. */
function limitErrorOf(action: () => unknown): MetadataLimitExceededError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(MetadataLimitExceededError);
    return error as MetadataLimitExceededError;
  }
  throw new Error('Expected a MetadataLimitExceededError, but nothing was thrown');
}

/** Lets a test pass a value that the types do not allow, like a JSON body can. */
function untyped(value: unknown): MetadataEntries {
  return value as MetadataEntries;
}

describe('METADATA_LIMITS', () => {
  // These numbers are public API: clients build on them. A smaller number can
  // break clients that work today, so changing one here must be on purpose.
  it('has the agreed defaults', () => {
    expect(LIMITS).toEqual({
      maxEntries: 128,
      maxKeyBytes: 256,
      maxValueBytes: 16384,
      maxTotalBytes: 65536,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });
});

describe('Metadata.empty', () => {
  it('has no entries', () => {
    expect(Metadata.empty().entries).toEqual({});
    expect(Metadata.empty().size).toBe(0);
  });

  it('is equal to metadata made from an empty object', () => {
    expect(Metadata.empty().equals(Metadata.of({}))).toBe(true);
  });
});

describe('Metadata.of', () => {
  it('shows the entries through getters', () => {
    const metadata = Metadata.of({ env: 'test', empty: '' });

    expect(metadata.entries).toEqual({ env: 'test', empty: '' });
    expect(metadata.size).toBe(2);
    expect(metadata.has('env')).toBe(true);
    expect(metadata.has('missing')).toBe(false);
  });

  it('does not treat a key from Object.prototype as there', () => {
    expect(Metadata.of({}).has('toString')).toBe(false);
  });

  it('accepts empty metadata and string values', () => {
    expect(() => Metadata.of({})).not.toThrow();
    expect(() => Metadata.of({ a: '', b: 'x' })).not.toThrow();
  });

  it.each([
    ['a number', 1],
    ['a boolean', true],
    ['null', null],
    ['an object', { a: 'b' }],
    ['an array', ['x']],
  ])('rejects a value that is %s', (_label, value) => {
    expect(() => Metadata.of(untyped({ bad: value }))).toThrow(
      new InvalidMetadataError('Metadata value for key "bad" must be a string'),
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['undefined', undefined],
  ])('rejects metadata that is %s', (_label, entriesValue) => {
    expect(() => Metadata.of(untyped(entriesValue))).toThrow(
      new InvalidMetadataError('Metadata must be an object'),
    );
  });

  it('rejects an empty key', () => {
    expect(() => Metadata.of({ '': 'x' })).toThrow(
      new InvalidMetadataError('Metadata keys must not be empty'),
    );
  });

  it('never puts a value in the error message', () => {
    expect(() => Metadata.of(untyped({ k: { password: 'hunter2' } }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
  });

  it('freezes the entries', () => {
    const metadata = Metadata.of({ a: '1' });

    expect(Object.isFrozen(metadata.entries)).toBe(true);
    expect(() => {
      (metadata.entries as Record<string, string>).a = '2';
    }).toThrow(TypeError);
  });

  it('is not changed when the caller edits the input afterwards', () => {
    const input = { a: '1' };
    const metadata = Metadata.of(input);

    input.a = 'changed';

    expect(metadata.entries).toEqual({ a: '1' });
  });
});

/** An object whose `key` answers with `first` for the first `times` reads, then with `later`. */
function changingGetter(first: string, later: string, times: number): MetadataEntries {
  let reads = 0;
  return {
    get key() {
      reads += 1;
      return reads <= times ? first : later;
    },
  };
}

describe('Metadata snapshot of caller input', () => {
  it('reads each value of `of` once, so a getter cannot pass the checks and store another value', () => {
    // Enough reads for a check that reads many times, then a value that is too long.
    const input = changingGetter('', 'x'.repeat(16385), 3);

    const metadata = Metadata.of(input);

    expect(metadata.entries.key).toBe('');
  });

  it('reads each value of `merge` once', () => {
    const input = changingGetter('', 'x'.repeat(16385), 3);

    const merged = Metadata.empty().merge(input);

    expect(merged.entries.key).toBe('');
  });

  it('checks the value it stores: a getter that answers badly at the first read is rejected', () => {
    const input = changingGetter('x'.repeat(16385), '', 1);

    expect(() => Metadata.of(input)).toThrow(MetadataLimitExceededError);
  });
});

describe('Metadata.of limits', () => {
  const create = (input: Record<string, string>) => () => Metadata.of(input);

  it('accepts exactly the most entries', () => {
    expect(create(entries(LIMITS.maxEntries))).not.toThrow();
  });

  it('rejects one entry more than the most', () => {
    const error = limitErrorOf(create(entries(LIMITS.maxEntries + 1)));

    expect(error.dimension).toBe('entries');
    expect(error.limit).toBe(LIMITS.maxEntries);
  });

  it('accepts a key of exactly the longest size, and rejects one byte more', () => {
    expect(create({ ['k'.repeat(LIMITS.maxKeyBytes)]: 'x' })).not.toThrow();

    const error = limitErrorOf(create({ ['k'.repeat(LIMITS.maxKeyBytes + 1)]: 'x' }));
    expect(error.dimension).toBe('key');
    expect(error.limit).toBe(LIMITS.maxKeyBytes);
  });

  it('measures a key in UTF-8 bytes, not in characters', () => {
    // "é" is 2 bytes. 128 of them are 256 bytes, and 129 are 258 bytes.
    expect(create({ ['é'.repeat(128)]: 'x' })).not.toThrow();
    expect(limitErrorOf(create({ ['é'.repeat(129)]: 'x' })).dimension).toBe('key');
  });

  it('accepts a value of exactly the longest size, and rejects one byte more', () => {
    expect(create({ a: 'v'.repeat(LIMITS.maxValueBytes) })).not.toThrow();

    const error = limitErrorOf(create({ a: 'v'.repeat(LIMITS.maxValueBytes + 1) }));
    expect(error.dimension).toBe('value');
    expect(error.limit).toBe(LIMITS.maxValueBytes);
  });

  it('measures a value in UTF-8 bytes, not in characters', () => {
    // An emoji is 4 bytes in UTF-8 but 2 in a JavaScript string.
    const fits = '😀'.repeat(LIMITS.maxValueBytes / 4);

    expect(create({ a: fits })).not.toThrow();
    expect(limitErrorOf(create({ a: `${fits}x` })).dimension).toBe('value');
  });

  it.each([
    ['a letter', 'a', 1],
    ['a letter with an accent', 'é', 2],
    ['a euro sign', '€', 3],
    ['an emoji', '😀', 4],
    ['a lone surrogate', '\ud83d', 3],
  ])('counts %s as the same bytes as Buffer does', (_label, text, bytes) => {
    // The size of a key is checked against the limit, so one key tells the size.
    const limit = LIMITS.maxKeyBytes;
    const fill = 'k'.repeat(limit - bytes);

    expect(Buffer.byteLength(text, 'utf8')).toBe(bytes);
    expect(create({ [fill + text]: 'x' })).not.toThrow();
    expect(limitErrorOf(create({ [`${fill}k${text}`]: 'x' })).dimension).toBe('key');
  });

  it('accepts a total of exactly the biggest size, and rejects one byte more', () => {
    // Four entries with a key of 1 byte and a value of 16383 bytes are 16384 bytes each.
    const full = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((key) => [key, 'v'.repeat(LIMITS.maxValueBytes - 1)]),
    );

    expect(create(full)).not.toThrow();

    const error = limitErrorOf(create({ ...full, e: '' }));
    expect(error.dimension).toBe('total');
    expect(error.limit).toBe(LIMITS.maxTotalBytes);
  });

  it('counts keys and values together in the total', () => {
    // The 5 values alone are 5 x 13000 = 65000 bytes, under the total. With the 5 keys of
    // 250 bytes each, they are over.
    const input = Object.fromEntries(
      ['a'.repeat(250), 'b'.repeat(250), 'c'.repeat(250), 'd'.repeat(250), 'e'.repeat(250)].map(
        (key) => [key, 'v'.repeat(13_000)],
      ),
    );

    expect(limitErrorOf(create(input)).dimension).toBe('total');
  });

  it('reports too many entries before a key that is too long', () => {
    const input = { ...entries(LIMITS.maxEntries), ['k'.repeat(LIMITS.maxKeyBytes + 1)]: 'x' };

    expect(limitErrorOf(create(input)).dimension).toBe('entries');
  });

  it('reports a value that is too long before the total', () => {
    expect(limitErrorOf(create({ a: 'v'.repeat(LIMITS.maxTotalBytes) })).dimension).toBe('value');
  });

  it('names the key of a value that is too long, and never the value', () => {
    const error = limitErrorOf(create({ token: 'hunter2'.repeat(3000) }));

    expect(error.message).toContain('"token"');
    expect(error.message).not.toContain('hunter2');
  });

  it('never repeats a key that is too long', () => {
    const error = limitErrorOf(create({ ['secretkey'.repeat(50)]: 'x' }));

    expect(error.message).not.toContain('secretkey');
  });

  it('checks the shape first, so a wrong value type is not a limit error', () => {
    const input = untyped({ bad: 1, ...entries(LIMITS.maxEntries + 1) });

    expect(() => Metadata.of(input)).toThrow(InvalidMetadataError);
  });
});

describe('Metadata.reconstitute', () => {
  it('builds metadata from stored data', () => {
    expect(Metadata.reconstitute({ env: 'test' }).entries).toEqual({ env: 'test' });
  });

  it('does not apply the limits, so metadata stored under older limits still loads', () => {
    const stored = { ...entries(LIMITS.maxEntries + 1), ['k'.repeat(LIMITS.maxKeyBytes + 1)]: '' };

    expect(Metadata.reconstitute(stored).size).toBe(LIMITS.maxEntries + 2);
  });

  it('freezes the entries and is not changed by edits of the input', () => {
    const stored = { a: '1' };
    const metadata = Metadata.reconstitute(stored);

    stored.a = 'changed';

    expect(metadata.entries).toEqual({ a: '1' });
    expect(Object.isFrozen(metadata.entries)).toBe(true);
  });
});

describe('Metadata.equals', () => {
  it('is true for the same entries, whatever the order of the keys', () => {
    expect(Metadata.of({ a: '1', b: '2' }).equals(Metadata.of({ b: '2', a: '1' }))).toBe(true);
  });

  it('is false for another value, another key or another size', () => {
    const metadata = Metadata.of({ a: '1' });

    expect(metadata.equals(Metadata.of({ a: '2' }))).toBe(false);
    expect(metadata.equals(Metadata.of({ b: '1' }))).toBe(false);
    expect(metadata.equals(Metadata.of({ a: '1', b: '2' }))).toBe(false);
    expect(Metadata.of({ a: '1', b: '2' }).equals(metadata)).toBe(false);
  });
});

describe('Metadata.merge', () => {
  const metadata = () => Metadata.of({ env: 'prod', team: 'payments' });

  it('adds new keys and keeps the other keys', () => {
    expect(metadata().merge({ tier: '1' }).entries).toEqual({
      env: 'prod',
      team: 'payments',
      tier: '1',
    });
  });

  it('replaces the value of a key that is already there', () => {
    expect(metadata().merge({ env: 'staging' }).entries).toEqual({
      env: 'staging',
      team: 'payments',
    });
  });

  it('adds and replaces in one call', () => {
    expect(metadata().merge({ env: 'staging', tier: '1' }).entries).toEqual({
      env: 'staging',
      team: 'payments',
      tier: '1',
    });
  });

  it('accepts an empty string as a value', () => {
    expect(metadata().merge({ env: '' }).entries).toEqual({ env: '', team: 'payments' });
  });

  it('gives new metadata and does not change the old one', () => {
    const before = metadata();

    const after = before.merge({ env: 'staging' });

    expect(after).not.toBe(before);
    expect(before.entries).toEqual({ env: 'prod', team: 'payments' });
  });

  it('gives frozen entries', () => {
    expect(Object.isFrozen(metadata().merge({ tier: '1' }).entries)).toBe(true);
  });

  it('is not changed when the caller edits the input afterwards', () => {
    const changes = { tier: '1' };
    const after = metadata().merge(changes);

    changes.tier = 'changed';

    expect(after.entries).toEqual({ env: 'prod', team: 'payments', tier: '1' });
  });

  it('returns the same instance when every key already has this value', () => {
    const before = metadata();

    expect(before.merge({ env: 'prod' })).toBe(before);
    expect(before.merge({ env: 'prod', team: 'payments' })).toBe(before);
  });

  it('returns the same instance for an empty object', () => {
    const before = metadata();

    expect(before.merge({})).toBe(before);
  });

  it('does not treat a key from Object.prototype as already there', () => {
    expect(Metadata.empty().merge({ toString: 'x' }).entries).toEqual({ toString: 'x' });
  });

  it.each([
    ['a number', 1],
    ['null', null],
    ['an object', { a: 'b' }],
  ])('rejects a value that is %s', (_label, value) => {
    expect(() => metadata().merge(untyped({ bad: value }))).toThrow(
      new InvalidMetadataError('Metadata value for key "bad" must be a string'),
    );
  });

  it('rejects an empty key', () => {
    expect(() => metadata().merge({ '': 'x' })).toThrow(
      new InvalidMetadataError('Metadata keys must not be empty'),
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('rejects changes that are %s', (_label, changes) => {
    expect(() => metadata().merge(untyped(changes))).toThrow(InvalidMetadataError);
  });

  it('does not change the metadata when it rejects the input', () => {
    const before = metadata();

    expect(() => before.merge(untyped({ ok: 'yes', bad: 1 }))).toThrow(InvalidMetadataError);
    expect(before.entries).toEqual({ env: 'prod', team: 'payments' });
  });

  it('never puts a value in the error message', () => {
    expect(() => metadata().merge(untyped({ k: { password: 'hunter2' } }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
  });
});

describe('Metadata.merge limits', () => {
  it('rejects a change that gives one key more than the most', () => {
    const before = Metadata.of(entries(LIMITS.maxEntries));

    expect(limitErrorOf(() => before.merge({ extra: 'x' })).dimension).toBe('entries');
  });

  it('accepts a change that reaches exactly the most keys', () => {
    const before = Metadata.of(entries(LIMITS.maxEntries - 1));

    expect(before.merge({ extra: 'x' }).size).toBe(LIMITS.maxEntries);
  });

  it('does not count a key that is replaced as a new key', () => {
    const before = Metadata.of(entries(LIMITS.maxEntries));

    expect(before.merge({ k0: 'changed' }).entries.k0).toBe('changed');
  });

  it('rejects a key or a value of the change that is too long', () => {
    const before = Metadata.empty();

    expect(limitErrorOf(() => before.merge({ ['k'.repeat(257)]: 'x' })).dimension).toBe('key');
    expect(limitErrorOf(() => before.merge({ a: 'v'.repeat(16385) })).dimension).toBe('value');
  });

  it('rejects a change that makes the total bigger than the most, and counts what is stored', () => {
    const full = Object.fromEntries(
      ['a', 'b', 'c'].map((key) => [key, 'v'.repeat(LIMITS.maxValueBytes - 1)]),
    );
    const before = Metadata.of(full);

    // 3 x 16384 stored. One more entry of 16384 bytes still fits. Two bytes more do not.
    expect(() => before.merge({ d: 'v'.repeat(LIMITS.maxValueBytes - 1) })).not.toThrow();
    expect(
      limitErrorOf(() => before.merge({ d: 'v'.repeat(LIMITS.maxValueBytes - 1), e: 'x' }))
        .dimension,
    ).toBe('total');
  });

  it('counts the new value, not the old one, when a value is replaced', () => {
    const full = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((key) => [key, 'v'.repeat(LIMITS.maxValueBytes - 1)]),
    );
    const before = Metadata.of(full);

    // The metadata is exactly full. A smaller value fits, a bigger one does not.
    expect(before.merge({ a: 'short' }).entries.a).toBe('short');
    expect(
      limitErrorOf(() => before.merge({ a: 'v'.repeat(LIMITS.maxValueBytes) })).dimension,
    ).toBe('total');
  });

  it('does not change the metadata when it rejects the change', () => {
    const before = Metadata.of(entries(LIMITS.maxEntries));

    expect(() => before.merge({ extra: 'x' })).toThrow(MetadataLimitExceededError);
    expect(before.size).toBe(LIMITS.maxEntries);
  });

  describe('for metadata stored under older, bigger limits', () => {
    const legacyKey = 'k'.repeat(LIMITS.maxKeyBytes + 1);

    it('can still change another key when the old entry is only too long', () => {
      const before = Metadata.reconstitute({ [legacyKey]: 'x', env: 'prod' });

      expect(before.merge({ env: 'staging' }).entries).toEqual({
        [legacyKey]: 'x',
        env: 'staging',
      });
    });

    it('returns the same instance when nothing changes, even if it is over a limit', () => {
      const before = Metadata.reconstitute(entries(LIMITS.maxEntries + 1));

      expect(before.merge({ k0: '' })).toBe(before);
    });

    it('rejects a change while it still has too many keys', () => {
      const before = Metadata.reconstitute(entries(LIMITS.maxEntries + 1));

      expect(limitErrorOf(() => before.merge({ k0: 'changed' })).dimension).toBe('entries');
    });

    it('accepts a change once it is back under the limit', () => {
      const before = Metadata.reconstitute(entries(LIMITS.maxEntries + 1)).remove('k0');

      expect(before.merge({ k1: 'changed' }).entries.k1).toBe('changed');
    });
  });
});

describe('Metadata.remove', () => {
  const metadata = () => Metadata.of({ env: 'prod', team: 'payments' });

  it('removes the key and keeps the other keys', () => {
    expect(metadata().remove('env').entries).toEqual({ team: 'payments' });
  });

  it('can remove the last key', () => {
    expect(Metadata.of({ env: 'prod' }).remove('env').entries).toEqual({});
  });

  it('gives new metadata and does not change the old one', () => {
    const before = metadata();

    const after = before.remove('env');

    expect(after).not.toBe(before);
    expect(before.entries).toEqual({ env: 'prod', team: 'payments' });
  });

  it('gives frozen entries', () => {
    expect(Object.isFrozen(metadata().remove('env').entries)).toBe(true);
  });

  it('returns the same instance when the key is not there', () => {
    const before = metadata();

    expect(before.remove('unknown')).toBe(before);
  });

  it('matches the key exactly (case matters)', () => {
    const before = metadata();

    expect(before.remove('ENV')).toBe(before);
  });

  it('does not treat a key from Object.prototype as there', () => {
    const before = metadata();

    expect(before.remove('toString')).toBe(before);
  });

  it('works on metadata that is over a limit, because it only makes it smaller', () => {
    const tooLong = 'k'.repeat(LIMITS.maxKeyBytes + 1);
    const before = Metadata.reconstitute({ [tooLong]: 'x', env: 'prod' });

    expect(before.remove(tooLong).entries).toEqual({ env: 'prod' });
  });
});
