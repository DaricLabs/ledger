import { InvalidLedgerMetadataError } from './invalid-ledger-metadata.error.js';
import { InvalidLedgerNameError } from './invalid-ledger-name.error.js';
import { LedgerMetadataLimitExceededError } from './ledger-metadata-limit-exceeded.error.js';
import { LEDGER_NAME_PATTERN, RESERVED_LEDGER_NAMES } from './ledger-name.js';

/** Free-form key/value pairs on a ledger. Every value is a string. */
export type LedgerMetadata = Readonly<Record<string, string>>;

/**
 * Size limits of ledger metadata. Sizes are in bytes of UTF-8 text, not
 * in characters: a letter like "a" is 1 byte, but an emoji is 4 bytes.
 *
 * The numbers are conservative defaults. They keep metadata small enough to
 * read by eye (128 keys of up to 256 bytes), and big enough for a JSON text
 * or a signature in one value (16 KiB). The total bounds what every
 * `GET /ledgers` response, log entry and outbox event can carry.
 *
 * We count not only what one command carries but also what is stored: a
 * ledger is saved under a row lock, so we know the whole metadata when we
 * check it, and many small saves cannot grow it without end.
 *
 * Limits are part of the public API. Making one bigger is safe. Making one
 * smaller can break clients that work today.
 */
export const LEDGER_METADATA_LIMITS = Object.freeze({
  /** Most keys one ledger can have. */
  maxEntries: 128,
  /** Longest key. */
  maxKeyBytes: 256,
  /** Longest value. */
  maxValueBytes: 16 * 1024,
  /** All keys and all values of one ledger, added together. */
  maxTotalBytes: 64 * 1024,
});

/** The data a ledger is made of. */
export interface LedgerProps {
  /** UUIDv7. Made by the caller (the use case), never by the database. */
  id: string;
  /** The owner organization. An opaque id from the Identity service. */
  organizationId: string;
  /** Unique inside the organization. Never changes after creation. */
  name: string;
  metadata: LedgerMetadata;
  createdAt: Date;
}

/**
 * A ledger: a named book of accounts and transactions that belongs to one
 * organization.
 *
 * It is immutable, so it has getters and no setters. A change gives back a
 * new ledger (`withMetadata`, `withoutMetadataKey`) and leaves the old one as
 * it was. The name never changes. Getters return safe values (a frozen
 * metadata object and a copy of the date), so callers cannot change a ledger
 * by accident.
 *
 * The counter that numbers `ledger_logs` is not part of this class. It is a
 * storage detail that only a database trigger changes.
 *
 * Make one with `Ledger.create` (new ledger, rules are checked) or
 * `Ledger.reconstitute` (a ledger loaded from storage, rules are not checked).
 */
export class Ledger {
  private constructor(private readonly props: Readonly<LedgerProps>) {}

  /**
   * Makes a NEW ledger and checks the rules for it.
   *
   * The checks repeat the ones at the API edge on purpose. Types disappear at
   * runtime, and the database only checks that metadata is a JSON object, so
   * this class stays safe even when a caller skips the edge checks.
   *
   * @throws {InvalidLedgerNameError} If the name has a wrong shape or is reserved.
   * @throws {InvalidLedgerMetadataError} If metadata is not an object, has an empty key, or has a non-string value.
   * @throws {LedgerMetadataLimitExceededError} If metadata is bigger than `LEDGER_METADATA_LIMITS` allow.
   */
  static create(props: LedgerProps): Ledger {
    assertValidName(props.name);
    assertValidMetadata(props.metadata);
    assertMetadataWithinLimits(props.metadata, props.metadata);
    return new Ledger(snapshot(props));
  }

  /**
   * Rebuilds a ledger that was already saved. It trusts storage and does not
   * check the creation rules.
   *
   * This is on purpose: if a name is reserved or a limit gets smaller later,
   * ledgers that already exist must still load.
   */
  static reconstitute(props: LedgerProps): Ledger {
    return new Ledger(snapshot(props));
  }

  get id(): string {
    return this.props.id;
  }

  get organizationId(): string {
    return this.props.organizationId;
  }

  get name(): string {
    return this.props.name;
  }

  /** A frozen object. Trying to change it throws a `TypeError`. */
  get metadata(): LedgerMetadata {
    return this.props.metadata;
  }

  /** A new `Date` every time, because `Date` objects can be changed. */
  get createdAt(): Date {
    return new Date(this.props.createdAt);
  }

  /**
   * Gives a ledger with these metadata entries added. A key that is already
   * there gets the new value, and the other keys stay as they are.
   *
   * Returns this same instance when nothing would change (every key already
   * has this value), so the caller can compare with `===` and skip the save.
   *
   * @throws {InvalidLedgerMetadataError} If `changes` is not an object, has an
   * empty key, or has a non-string value.
   * @throws {LedgerMetadataLimitExceededError} If a key or a value of `changes`
   * is too long, or the metadata after the change would have too many keys or
   * be too big. Only the entries of `changes` are checked one by one, so an old
   * long key or value that is already stored does not block a change. The
   * number of keys and the total size are checked on the whole result, so a
   * ledger that is over one of them must get smaller first (see
   * `withoutMetadataKey`).
   */
  withMetadata(changes: LedgerMetadata): Ledger {
    assertValidMetadata(changes);
    const current = this.props.metadata;
    const unchanged = Object.entries(changes).every(
      ([key, value]) => Object.hasOwn(current, key) && current[key] === value,
    );
    if (unchanged) {
      return this;
    }
    const merged = { ...current, ...changes };
    assertMetadataWithinLimits(changes, merged);
    return new Ledger(snapshot({ ...this.props, metadata: merged }));
  }

  /**
   * Gives a ledger without this metadata key.
   *
   * Returns this same instance when the key is not there, so the caller can
   * compare with `===` and skip the save. Deleting a key that does not exist
   * is not an error.
   *
   * It never checks the limits: removing a key only makes metadata smaller.
   */
  withoutMetadataKey(key: string): Ledger {
    if (!Object.hasOwn(this.props.metadata, key)) {
      return this;
    }
    const remaining = Object.fromEntries(
      Object.entries(this.props.metadata).filter(([existing]) => existing !== key),
    );
    return new Ledger(snapshot({ ...this.props, metadata: remaining }));
  }
}

/** Copies the input, so later changes by the caller cannot reach the ledger. */
function snapshot(props: LedgerProps): Readonly<LedgerProps> {
  return Object.freeze({
    id: props.id,
    organizationId: props.organizationId,
    name: props.name,
    metadata: Object.freeze({ ...props.metadata }),
    createdAt: new Date(props.createdAt),
  });
}

// The parameter is `unknown` on purpose: `RegExp.test` turns its input into a
// string, so `undefined` would become "undefined" and pass the pattern.
function assertValidName(name: unknown): void {
  if (typeof name !== 'string' || !LEDGER_NAME_PATTERN.test(name)) {
    throw new InvalidLedgerNameError(
      'Ledger name must be 1 to 63 characters: lowercase letters, digits, "_" or "-", and it must start with a letter or digit',
    );
  }
  if (RESERVED_LEDGER_NAMES.has(name)) {
    throw new InvalidLedgerNameError(`Ledger name "${name}" is reserved`);
  }
}

// The parameter is `unknown` on purpose: the type says "strings only", but at
// runtime the value may come from any JSON body.
function assertValidMetadata(metadata: unknown): void {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new InvalidLedgerMetadataError('Metadata must be an object');
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (key === '') {
      throw new InvalidLedgerMetadataError('Metadata keys must not be empty');
    }
    if (typeof value !== 'string') {
      throw new InvalidLedgerMetadataError(`Metadata value for key "${key}" must be a string`);
    }
  }
}

/**
 * Checks the size limits of metadata that is being written.
 *
 * `entries` are the keys and values this write brings. Each one is checked
 * alone (key length, value length). `result` is all the metadata the ledger
 * will have after the write, and it is checked as a whole (number of keys,
 * total size). On create, both are the same object.
 *
 * It expects metadata that already passed `assertValidMetadata`. The order is
 * fixed, so the same input always gives the same error: too many keys, then a
 * key that is too long, then a value that is too long, then the total.
 */
function assertMetadataWithinLimits(entries: LedgerMetadata, result: LedgerMetadata): void {
  const limits = LEDGER_METADATA_LIMITS;
  if (Object.keys(result).length > limits.maxEntries) {
    throw new LedgerMetadataLimitExceededError('entries', limits.maxEntries);
  }
  for (const [key, value] of Object.entries(entries)) {
    if (utf8Length(key) > limits.maxKeyBytes) {
      throw new LedgerMetadataLimitExceededError('key', limits.maxKeyBytes);
    }
    if (utf8Length(value) > limits.maxValueBytes) {
      throw new LedgerMetadataLimitExceededError('value', limits.maxValueBytes, key);
    }
  }
  let total = 0;
  for (const [key, value] of Object.entries(result)) {
    total += utf8Length(key) + utf8Length(value);
  }
  if (total > limits.maxTotalBytes) {
    throw new LedgerMetadataLimitExceededError('total', limits.maxTotalBytes);
  }
}

/** The size of a text in bytes when it is saved as UTF-8 (JSON in the database is UTF-8). */
function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
