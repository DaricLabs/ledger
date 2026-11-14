import { InvalidLedgerMetadataError } from '../errors/invalid-ledger-metadata.error.js';
import { InvalidLedgerNameError } from '../errors/invalid-ledger-name.error.js';
import { RESERVED_LEDGER_NAMES } from '../constants/ledger-name.constant.js';
import { LedgerMetadataLimitExceededError } from '../errors/ledger-metadata-limit-exceeded.error.js';
import { LEDGER_METADATA_LIMITS, Ledger, type ILedgerProps } from './ledger.entity.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789cd';

function props(overrides: Partial<ILedgerProps> = {}): ILedgerProps {
  return {
    id: LEDGER_ID,
    organizationId: ORG_ID,
    name: 'main',
    metadata: {},
    createdAt: new Date('2026-10-30T10:00:00.000Z'),
    ...overrides,
  };
}

const LIMITS = LEDGER_METADATA_LIMITS;

/** `count` entries with short keys (`k0`, `k1`, ...) and empty values. */
function entries(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, '']));
}

/** Runs `action` and gives back the limit error it throws. Fails if it throws nothing else. */
function limitErrorOf(action: () => unknown): LedgerMetadataLimitExceededError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerMetadataLimitExceededError);
    return error as LedgerMetadataLimitExceededError;
  }
  throw new Error('Expected a LedgerMetadataLimitExceededError, but nothing was thrown');
}

describe('LEDGER_METADATA_LIMITS', () => {
  // These numbers are public API: clients build on them. A smaller number can
  // break clients that work today, so changing one here must be on purpose.
  it('has the Formance v3 defaults', () => {
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

describe('Ledger.create', () => {
  it('builds a ledger and shows its values through getters', () => {
    const ledger = Ledger.create(props({ metadata: { env: 'test' } }));

    expect(ledger.id).toBe(LEDGER_ID);
    expect(ledger.organizationId).toBe(ORG_ID);
    expect(ledger.name).toBe('main');
    expect(ledger.metadata).toEqual({ env: 'test' });
    expect(ledger.createdAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it.each(['main', 'a', '0', 'users_2026', 'my-ledger', 'a'.repeat(63)])(
    'accepts the name %j',
    (name) => {
      expect(Ledger.create(props({ name })).name).toBe(name);
    },
  );

  it.each([
    ['empty', ''],
    ['has an uppercase letter', 'Main'],
    ['starts with "_"', '_main'],
    ['starts with "-"', '-main'],
    ['has a dot', 'a.b'],
    ['has a space', 'a b'],
    ['has a new line at the end', 'main\n'],
    ['is 64 characters long', 'a'.repeat(64)],
  ])('rejects a name that %s', (_label, name) => {
    expect(() => Ledger.create(props({ name }))).toThrow(InvalidLedgerNameError);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 123],
  ])('rejects a name that is %s, not a string', (_label, name) => {
    expect(() => Ledger.create(props({ name: name as unknown as string }))).toThrow(
      InvalidLedgerNameError,
    );
  });

  it.each([...RESERVED_LEDGER_NAMES])('rejects the reserved name %j', (name) => {
    expect(() => Ledger.create(props({ name }))).toThrow(
      new InvalidLedgerNameError(`Ledger name "${name}" is reserved`),
    );
  });

  it('accepts empty metadata and string values', () => {
    expect(() => Ledger.create(props({ metadata: {} }))).not.toThrow();
    expect(() => Ledger.create(props({ metadata: { a: '', b: 'x' } }))).not.toThrow();
  });

  it.each([
    ['a number', 1],
    ['a boolean', true],
    ['null', null],
    ['an object', { a: 'b' }],
    ['an array', ['x']],
  ])('rejects a metadata value that is %s', (_label, value) => {
    const metadata = { bad: value } as unknown as ILedgerProps['metadata'];

    expect(() => Ledger.create(props({ metadata }))).toThrow(
      new InvalidLedgerMetadataError('Metadata value for key "bad" must be a string'),
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('rejects metadata that is %s', (_label, metadata) => {
    expect(() =>
      Ledger.create(props({ metadata: metadata as unknown as ILedgerProps['metadata'] })),
    ).toThrow(InvalidLedgerMetadataError);
  });

  it('rejects an empty metadata key', () => {
    expect(() => Ledger.create(props({ metadata: { '': 'x' } }))).toThrow(
      new InvalidLedgerMetadataError('Metadata keys must not be empty'),
    );
  });

  it('never puts a metadata value in the error message', () => {
    const metadata = { k: { password: 'hunter2' } } as unknown as ILedgerProps['metadata'];

    expect(() => Ledger.create(props({ metadata }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
  });
});

describe('Ledger.create metadata limits', () => {
  const create = (metadata: Record<string, string>) => () => Ledger.create(props({ metadata }));

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
    const metadata = Object.fromEntries(
      ['a'.repeat(250), 'b'.repeat(250), 'c'.repeat(250), 'd'.repeat(250), 'e'.repeat(250)].map(
        (key) => [key, 'v'.repeat(13_000)],
      ),
    );

    expect(limitErrorOf(create(metadata)).dimension).toBe('total');
  });

  it('reports too many entries before a key that is too long', () => {
    const metadata = { ...entries(LIMITS.maxEntries), ['k'.repeat(LIMITS.maxKeyBytes + 1)]: 'x' };

    expect(limitErrorOf(create(metadata)).dimension).toBe('entries');
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
    const metadata = { bad: 1, ...entries(LIMITS.maxEntries + 1) } as unknown as Record<
      string,
      string
    >;

    expect(create(metadata)).toThrow(InvalidLedgerMetadataError);
  });
});

describe('Ledger.reconstitute', () => {
  it('builds a ledger from stored data', () => {
    const ledger = Ledger.reconstitute(props({ metadata: { env: 'test' } }));

    expect(ledger.name).toBe('main');
    expect(ledger.metadata).toEqual({ env: 'test' });
  });

  it('does not apply the creation rules, so a ledger with a later-reserved name still loads', () => {
    expect(Ledger.reconstitute(props({ name: 'default' })).name).toBe('default');
  });

  it('does not apply the metadata limits, so a ledger stored under older limits still loads', () => {
    const metadata = {
      ...entries(LIMITS.maxEntries + 1),
      ['k'.repeat(LIMITS.maxKeyBytes + 1)]: '',
    };

    expect(Object.keys(Ledger.reconstitute(props({ metadata })).metadata)).toHaveLength(
      LIMITS.maxEntries + 2,
    );
  });
});

describe('Ledger.withMetadata', () => {
  const ledger = () => Ledger.create(props({ metadata: { env: 'prod', team: 'payments' } }));

  it('adds new keys and keeps the other keys', () => {
    expect(ledger().withMetadata({ tier: '1' }).metadata).toEqual({
      env: 'prod',
      team: 'payments',
      tier: '1',
    });
  });

  it('replaces the value of a key that is already there', () => {
    expect(ledger().withMetadata({ env: 'staging' }).metadata).toEqual({
      env: 'staging',
      team: 'payments',
    });
  });

  it('adds and replaces in one call', () => {
    expect(ledger().withMetadata({ env: 'staging', tier: '1' }).metadata).toEqual({
      env: 'staging',
      team: 'payments',
      tier: '1',
    });
  });

  it('accepts an empty string as a value', () => {
    expect(ledger().withMetadata({ env: '' }).metadata).toEqual({ env: '', team: 'payments' });
  });

  it('gives a new ledger and does not change the old one', () => {
    const before = ledger();

    const after = before.withMetadata({ env: 'staging' });

    expect(after).not.toBe(before);
    expect(before.metadata).toEqual({ env: 'prod', team: 'payments' });
  });

  it('keeps every other field', () => {
    const after = ledger().withMetadata({ env: 'staging' });

    expect(after.id).toBe(LEDGER_ID);
    expect(after.organizationId).toBe(ORG_ID);
    expect(after.name).toBe('main');
    expect(after.createdAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('gives a ledger with frozen metadata', () => {
    expect(Object.isFrozen(ledger().withMetadata({ tier: '1' }).metadata)).toBe(true);
  });

  it('is not changed when the caller edits the input afterwards', () => {
    const changes = { tier: '1' };
    const after = ledger().withMetadata(changes);

    changes.tier = 'changed';

    expect(after.metadata).toEqual({ env: 'prod', team: 'payments', tier: '1' });
  });

  it('returns the same ledger when every key already has this value', () => {
    const before = ledger();

    expect(before.withMetadata({ env: 'prod' })).toBe(before);
    expect(before.withMetadata({ env: 'prod', team: 'payments' })).toBe(before);
  });

  it('returns the same ledger for an empty object', () => {
    const before = ledger();

    expect(before.withMetadata({})).toBe(before);
  });

  it('does not treat a key from Object.prototype as already there', () => {
    const after = Ledger.create(props()).withMetadata({ toString: 'x' });

    expect(after.metadata).toEqual({ toString: 'x' });
  });

  it.each([
    ['a number', 1],
    ['null', null],
    ['an object', { a: 'b' }],
  ])('rejects a value that is %s', (_label, value) => {
    const changes = { bad: value } as unknown as ILedgerProps['metadata'];

    expect(() => ledger().withMetadata(changes)).toThrow(
      new InvalidLedgerMetadataError('Metadata value for key "bad" must be a string'),
    );
  });

  it('rejects an empty key', () => {
    expect(() => ledger().withMetadata({ '': 'x' })).toThrow(
      new InvalidLedgerMetadataError('Metadata keys must not be empty'),
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('rejects changes that are %s', (_label, changes) => {
    expect(() => ledger().withMetadata(changes as unknown as ILedgerProps['metadata'])).toThrow(
      InvalidLedgerMetadataError,
    );
  });

  it('does not change the ledger when it rejects the input', () => {
    const before = ledger();

    expect(() =>
      before.withMetadata({ ok: 'yes', bad: 1 } as unknown as ILedgerProps['metadata']),
    ).toThrow(InvalidLedgerMetadataError);
    expect(before.metadata).toEqual({ env: 'prod', team: 'payments' });
  });

  it('never puts a metadata value in the error message', () => {
    const changes = { k: { password: 'hunter2' } } as unknown as ILedgerProps['metadata'];

    expect(() => ledger().withMetadata(changes)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
  });
});

describe('Ledger.withMetadata limits', () => {
  it('rejects a change that gives the ledger one key more than the most', () => {
    const before = Ledger.create(props({ metadata: entries(LIMITS.maxEntries) }));

    const error = limitErrorOf(() => before.withMetadata({ extra: 'x' }));

    expect(error.dimension).toBe('entries');
  });

  it('accepts a change that reaches exactly the most keys', () => {
    const before = Ledger.create(props({ metadata: entries(LIMITS.maxEntries - 1) }));

    expect(Object.keys(before.withMetadata({ extra: 'x' }).metadata)).toHaveLength(
      LIMITS.maxEntries,
    );
  });

  it('does not count a key that is replaced as a new key', () => {
    const before = Ledger.create(props({ metadata: entries(LIMITS.maxEntries) }));

    expect(before.withMetadata({ k0: 'changed' }).metadata.k0).toBe('changed');
  });

  it('rejects a key or a value of the change that is too long', () => {
    const before = Ledger.create(props());

    expect(limitErrorOf(() => before.withMetadata({ ['k'.repeat(257)]: 'x' })).dimension).toBe(
      'key',
    );
    expect(limitErrorOf(() => before.withMetadata({ a: 'v'.repeat(16385) })).dimension).toBe(
      'value',
    );
  });

  it('rejects a change that makes the total bigger than the most, and counts what is stored', () => {
    const full = Object.fromEntries(
      ['a', 'b', 'c'].map((key) => [key, 'v'.repeat(LIMITS.maxValueBytes - 1)]),
    );
    const before = Ledger.create(props({ metadata: full }));

    // 3 x 16384 stored. One more entry of 16384 bytes still fits. Two bytes more do not.
    expect(() => before.withMetadata({ d: 'v'.repeat(LIMITS.maxValueBytes - 1) })).not.toThrow();
    expect(
      limitErrorOf(() => before.withMetadata({ d: 'v'.repeat(LIMITS.maxValueBytes - 1), e: 'x' }))
        .dimension,
    ).toBe('total');
  });

  it('counts the new value, not the old one, when a value is replaced', () => {
    const full = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((key) => [key, 'v'.repeat(LIMITS.maxValueBytes - 1)]),
    );
    const before = Ledger.create(props({ metadata: full }));

    // The ledger is exactly full. A smaller value fits, a bigger one does not.
    expect(before.withMetadata({ a: 'short' }).metadata.a).toBe('short');
    expect(
      limitErrorOf(() => before.withMetadata({ a: 'v'.repeat(LIMITS.maxValueBytes) })).dimension,
    ).toBe('total');
  });

  it('does not change the ledger when it rejects the change', () => {
    const before = Ledger.create(props({ metadata: entries(LIMITS.maxEntries) }));

    expect(() => before.withMetadata({ extra: 'x' })).toThrow(LedgerMetadataLimitExceededError);
    expect(Object.keys(before.metadata)).toHaveLength(LIMITS.maxEntries);
  });

  describe('for a ledger stored under older, bigger limits', () => {
    const legacyKey = 'k'.repeat(LIMITS.maxKeyBytes + 1);
    const legacy = (metadata: Record<string, string>) => Ledger.reconstitute(props({ metadata }));

    it('can still change another key when the old entry is only too long', () => {
      const before = legacy({ [legacyKey]: 'x', env: 'prod' });

      expect(before.withMetadata({ env: 'staging' }).metadata).toEqual({
        [legacyKey]: 'x',
        env: 'staging',
      });
    });

    it('returns the same ledger when nothing changes, even if it is over a limit', () => {
      const before = legacy(entries(LIMITS.maxEntries + 1));

      expect(before.withMetadata({ k0: '' })).toBe(before);
    });

    it('rejects a change while the ledger still has too many keys', () => {
      const before = legacy(entries(LIMITS.maxEntries + 1));

      expect(limitErrorOf(() => before.withMetadata({ k0: 'changed' })).dimension).toBe('entries');
    });

    it('accepts a change once the ledger is back under the limit', () => {
      const before = legacy(entries(LIMITS.maxEntries + 1)).withoutMetadataKey('k0');

      expect(before.withMetadata({ k1: 'changed' }).metadata.k1).toBe('changed');
    });
  });
});

describe('Ledger.withoutMetadataKey', () => {
  const ledger = () => Ledger.create(props({ metadata: { env: 'prod', team: 'payments' } }));

  it('removes the key and keeps the other keys', () => {
    expect(ledger().withoutMetadataKey('env').metadata).toEqual({ team: 'payments' });
  });

  it('can remove the last key', () => {
    const after = Ledger.create(props({ metadata: { env: 'prod' } })).withoutMetadataKey('env');

    expect(after.metadata).toEqual({});
  });

  it('gives a new ledger and does not change the old one', () => {
    const before = ledger();

    const after = before.withoutMetadataKey('env');

    expect(after).not.toBe(before);
    expect(before.metadata).toEqual({ env: 'prod', team: 'payments' });
  });

  it('keeps every other field', () => {
    const after = ledger().withoutMetadataKey('env');

    expect(after.id).toBe(LEDGER_ID);
    expect(after.organizationId).toBe(ORG_ID);
    expect(after.name).toBe('main');
    expect(after.createdAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('gives a ledger with frozen metadata', () => {
    expect(Object.isFrozen(ledger().withoutMetadataKey('env').metadata)).toBe(true);
  });

  it('returns the same ledger when the key is not there', () => {
    const before = ledger();

    expect(before.withoutMetadataKey('unknown')).toBe(before);
  });

  it('matches the key exactly (case matters)', () => {
    const before = ledger();

    expect(before.withoutMetadataKey('ENV')).toBe(before);
  });

  it('does not treat a key from Object.prototype as there', () => {
    const before = ledger();

    expect(before.withoutMetadataKey('toString')).toBe(before);
  });

  it('works on a ledger that is over a limit, because it only makes metadata smaller', () => {
    const tooLong = 'k'.repeat(LIMITS.maxKeyBytes + 1);
    const before = Ledger.reconstitute(props({ metadata: { [tooLong]: 'x', env: 'prod' } }));

    expect(before.withoutMetadataKey(tooLong).metadata).toEqual({ env: 'prod' });
  });
});

describe('Ledger immutability', () => {
  it('freezes metadata', () => {
    const ledger = Ledger.create(props({ metadata: { a: '1' } }));

    expect(Object.isFrozen(ledger.metadata)).toBe(true);
    expect(() => {
      (ledger.metadata as Record<string, string>).a = '2';
    }).toThrow(TypeError);
  });

  it('is not changed when the caller edits the input metadata afterwards', () => {
    const input = props({ metadata: { a: '1' } });
    const ledger = Ledger.create(input);

    (input.metadata as Record<string, string>).a = 'changed';

    expect(ledger.metadata).toEqual({ a: '1' });
  });

  it('is not changed when the caller edits the input date afterwards', () => {
    const input = props();
    const ledger = Ledger.create(input);

    input.createdAt.setFullYear(2000);

    expect(ledger.createdAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('gives a new Date each time, so editing it does not change the ledger', () => {
    const ledger = Ledger.create(props());

    ledger.createdAt.setFullYear(2000);

    expect(ledger.createdAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });
});
