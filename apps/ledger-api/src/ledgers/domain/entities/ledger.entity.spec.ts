import { Metadata, MetadataLimitExceededError } from '@ledger/domain';
import { InvalidLedgerNameError } from '../errors/invalid-ledger-name.error.js';
import { RESERVED_LEDGER_NAMES } from '../constants/ledger-name.constant.js';
import { Ledger, type ILedgerProps } from './ledger.entity.js';

const ORG_ID = '0190a5d4-7b3c-7abc-8def-0123456789ab';
const LEDGER_ID = '0190a5d4-7b3c-7abc-8def-0123456789cd';

function props(overrides: Partial<ILedgerProps> = {}): ILedgerProps {
  return {
    id: LEDGER_ID,
    organizationId: ORG_ID,
    name: 'main',
    metadata: Metadata.empty(),
    createdAt: new Date('2026-10-30T10:00:00.000Z'),
    ...overrides,
  };
}

describe('Ledger.create', () => {
  it('builds a ledger and shows its values through getters', () => {
    const metadata = Metadata.of({ env: 'test' });
    const ledger = Ledger.create(props({ metadata }));

    expect(ledger.id).toBe(LEDGER_ID);
    expect(ledger.organizationId).toBe(ORG_ID);
    expect(ledger.name).toBe('main');
    expect(ledger.metadata).toBe(metadata);
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
});

describe('Ledger.reconstitute', () => {
  it('builds a ledger from stored data', () => {
    const ledger = Ledger.reconstitute(props({ metadata: Metadata.of({ env: 'test' }) }));

    expect(ledger.name).toBe('main');
    expect(ledger.metadata.entries).toEqual({ env: 'test' });
  });

  it('does not apply the creation rules, so a ledger with a later-reserved name still loads', () => {
    expect(Ledger.reconstitute(props({ name: 'default' })).name).toBe('default');
  });
});

// The metadata rules and limits are tested in `Metadata`. These tests only check
// that the ledger uses them and gives back a new ledger.
describe('Ledger.withMetadata', () => {
  const ledger = () => Ledger.create(props({ metadata: Metadata.of({ env: 'prod' }) }));

  it('gives a new ledger with the entries added, and does not change the old one', () => {
    const before = ledger();

    const after = before.withMetadata({ env: 'staging', tier: '1' });

    expect(after).not.toBe(before);
    expect(after.metadata.entries).toEqual({ env: 'staging', tier: '1' });
    expect(before.metadata.entries).toEqual({ env: 'prod' });
  });

  it('keeps every other field', () => {
    const after = ledger().withMetadata({ tier: '1' });

    expect(after.id).toBe(LEDGER_ID);
    expect(after.organizationId).toBe(ORG_ID);
    expect(after.name).toBe('main');
    expect(after.createdAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('returns the same ledger when every key already has this value', () => {
    const before = ledger();

    expect(before.withMetadata({ env: 'prod' })).toBe(before);
    expect(before.withMetadata({})).toBe(before);
  });

  it('passes the metadata errors through', () => {
    const changes = { bad: 1 } as unknown as Record<string, string>;

    expect(() => ledger().withMetadata(changes)).toThrow(
      expect.objectContaining({ code: 'INVALID_METADATA' }),
    );
    expect(() => ledger().withMetadata({ big: 'v'.repeat(16385) })).toThrow(
      MetadataLimitExceededError,
    );
  });
});

describe('Ledger.withoutMetadataKey', () => {
  const ledger = () => Ledger.create(props({ metadata: Metadata.of({ env: 'prod', team: 'a' }) }));

  it('gives a new ledger without the key, and does not change the old one', () => {
    const before = ledger();

    const after = before.withoutMetadataKey('env');

    expect(after).not.toBe(before);
    expect(after.metadata.entries).toEqual({ team: 'a' });
    expect(before.metadata.entries).toEqual({ env: 'prod', team: 'a' });
  });

  it('keeps every other field', () => {
    const after = ledger().withoutMetadataKey('env');

    expect(after.id).toBe(LEDGER_ID);
    expect(after.organizationId).toBe(ORG_ID);
    expect(after.name).toBe('main');
    expect(after.createdAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('returns the same ledger when the key is not there', () => {
    const before = ledger();

    expect(before.withoutMetadataKey('unknown')).toBe(before);
  });
});

describe('Ledger immutability', () => {
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
