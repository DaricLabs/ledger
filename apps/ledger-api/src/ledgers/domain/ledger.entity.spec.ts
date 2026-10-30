import { InvalidLedgerMetadataError } from './invalid-ledger-metadata.error.js';
import { InvalidLedgerNameError } from './invalid-ledger-name.error.js';
import { RESERVED_LEDGER_NAMES } from './ledger-name.js';
import { Ledger, type LedgerProps } from './ledger.entity.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789cd';

function props(overrides: Partial<LedgerProps> = {}): LedgerProps {
  return {
    id: LEDGER_ID,
    organizationId: ORG_ID,
    name: 'main',
    metadata: {},
    createdAt: new Date('2026-10-30T10:00:00.000Z'),
    ...overrides,
  };
}

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
    const metadata = { bad: value } as unknown as LedgerProps['metadata'];

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
      Ledger.create(props({ metadata: metadata as unknown as LedgerProps['metadata'] })),
    ).toThrow(InvalidLedgerMetadataError);
  });

  it('never puts a metadata value in the error message', () => {
    const metadata = { k: { password: 'hunter2' } } as unknown as LedgerProps['metadata'];

    expect(() => Ledger.create(props({ metadata }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
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
