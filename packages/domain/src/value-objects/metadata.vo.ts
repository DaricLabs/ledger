import { InvalidMetadataError } from '../errors/invalid-metadata.error.js';
import { MetadataLimitExceededError } from '../errors/metadata-limit-exceeded.error.js';

/** The key/value pairs of a `Metadata`. Every value is a string. */
export type MetadataEntries = Readonly<Record<string, string>>;

/**
 * Size limits of metadata. Sizes are in bytes of UTF-8 text, not in
 * characters: a letter like "a" is 1 byte, but an emoji is 4 bytes.
 *
 * The numbers are conservative defaults. They keep metadata small enough to
 * read by eye (128 keys of up to 256 bytes), and big enough for a JSON text
 * or a signature in one value (16 KiB). The total bounds what every list
 * response, log entry and outbox event can carry.
 *
 * We count not only what one command carries but also what is stored: a
 * record is saved under a row lock, so we know the whole metadata when we
 * check it, and many small saves cannot grow it without end.
 *
 * Limits are part of the public API. Making one bigger is safe. Making one
 * smaller can break clients that work today.
 */
export const METADATA_LIMITS = Object.freeze({
  /** Most keys one record can have. */
  maxEntries: 128,
  /** Longest key. */
  maxKeyBytes: 256,
  /** Longest value. */
  maxValueBytes: 16 * 1024,
  /** All keys and all values of one record, added together. */
  maxTotalBytes: 64 * 1024,
});

/**
 * Free-form key/value pairs that a client attaches to a record (a ledger,
 * and later a transaction or an account), for example `{ "orderId": "42" }`.
 *
 * It is a value object: it never changes, and two metadata with the same
 * entries are equal. A change (`merge`, `remove`) gives back a new instance.
 * Make one with `Metadata.of`, which checks the rules, so a value of this
 * type is always valid. A record that holds metadata can trust it.
 *
 * The ledger never reads metadata to make a decision. It only stores it and
 * gives it back. Do not put personal data in it: the journal and the outbox
 * keep what is written, and they are append-only. Use ids instead.
 */
export class Metadata {
  private static readonly EMPTY = new Metadata(Object.freeze({}));

  private constructor(private readonly values: MetadataEntries) {}

  /** Metadata with no entries. */
  static empty(): Metadata {
    return Metadata.EMPTY;
  }

  /**
   * Makes metadata from new input and checks the rules and the size limits.
   *
   * The checks repeat the ones at the API edge on purpose. Types disappear at
   * runtime, and the database only checks that metadata is a JSON object, so
   * this class stays safe even when a caller skips the edge checks.
   *
   * @throws {InvalidMetadataError} If `entries` is not an object, has an empty
   * key, or has a non-string value.
   * @throws {MetadataLimitExceededError} If `entries` is bigger than
   * `METADATA_LIMITS` allow.
   */
  static of(entries: MetadataEntries): Metadata {
    const snapshot = checkedSnapshot(entries);
    assertWithinLimits(snapshot, snapshot);
    return new Metadata(snapshot);
  }

  /**
   * Rebuilds metadata that was already saved. It trusts storage and does not
   * check the rules.
   *
   * This is on purpose: if a limit gets smaller later, records that already
   * exist must still load.
   */
  static reconstitute(entries: MetadataEntries): Metadata {
    return new Metadata(freeze(entries));
  }

  /** A frozen object. Trying to change it throws a `TypeError`. */
  get entries(): MetadataEntries {
    return this.values;
  }

  /** The number of keys. */
  get size(): number {
    return Object.keys(this.values).length;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.values, key);
  }

  equals(other: Metadata): boolean {
    const mine = Object.entries(this.values);
    return mine.length === other.size && mine.every(([key, value]) => other.values[key] === value);
  }

  /**
   * Gives metadata with these entries added. A key that is already there
   * gets the new value, and the other keys stay as they are.
   *
   * Returns this same instance when nothing would change (every key already
   * has this value), so the caller can compare with `===` and skip the save.
   *
   * @throws {InvalidMetadataError} If `changes` is not an object, has an empty
   * key, or has a non-string value.
   * @throws {MetadataLimitExceededError} If a key or a value of `changes` is
   * too long, or the metadata after the change would have too many keys or be
   * too big. Only the entries of `changes` are checked one by one, so an old
   * long key or value that is already stored does not block a change. The
   * number of keys and the total size are checked on the whole result, so
   * metadata that is over one of them must get smaller first (see `remove`).
   */
  merge(changes: MetadataEntries): Metadata {
    const snapshot = checkedSnapshot(changes);
    const unchanged = Object.entries(snapshot).every(
      ([key, value]) => this.has(key) && this.values[key] === value,
    );
    if (unchanged) {
      return this;
    }
    const merged = { ...this.values, ...snapshot };
    assertWithinLimits(snapshot, merged);
    return new Metadata(freeze(merged));
  }

  /**
   * Gives metadata without this key.
   *
   * Returns this same instance when the key is not there, so the caller can
   * compare with `===` and skip the save. Removing a key that does not exist
   * is not an error.
   *
   * It never checks the limits: removing a key only makes metadata smaller.
   */
  remove(key: string): Metadata {
    if (!this.has(key)) {
      return this;
    }
    const remaining = Object.fromEntries(
      Object.entries(this.values).filter(([existing]) => existing !== key),
    );
    return new Metadata(freeze(remaining));
  }
}

/** Copies the input, so later changes by the caller cannot reach the metadata. */
function freeze(entries: MetadataEntries): MetadataEntries {
  return Object.freeze({ ...entries });
}

/**
 * Copies input from a caller and checks the copy, never the original.
 *
 * Checking the original and then copying it would read it twice. An object
 * with a getter can answer differently the second time, so a value could pass
 * the checks and still be stored unchecked. One copy is read once, and every
 * later check and the storage use that copy.
 *
 * The parameter is `unknown` on purpose: the type says "strings only", but at
 * runtime the value may come from any JSON body.
 */
function checkedSnapshot(input: unknown): MetadataEntries {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InvalidMetadataError('Metadata must be an object');
  }
  const snapshot = freeze(input as MetadataEntries);
  assertStringEntries(snapshot);
  return snapshot;
}

function assertStringEntries(entries: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (key === '') {
      throw new InvalidMetadataError('Metadata keys must not be empty');
    }
    if (typeof value !== 'string') {
      throw new InvalidMetadataError(`Metadata value for key "${key}" must be a string`);
    }
  }
}

/**
 * Checks the size limits of metadata that is being written.
 *
 * `entries` are the keys and values this write brings. Each one is checked
 * alone (key length, value length). `result` is all the metadata the record
 * will have after the write, and it is checked as a whole (number of keys,
 * total size). On create, both are the same object.
 *
 * It expects entries that already passed `checkedSnapshot`. The order is
 * fixed, so the same input always gives the same error: too many keys, then a
 * key that is too long, then a value that is too long, then the total.
 */
function assertWithinLimits(entries: MetadataEntries, result: MetadataEntries): void {
  const limits = METADATA_LIMITS;
  if (Object.keys(result).length > limits.maxEntries) {
    throw new MetadataLimitExceededError('entries', limits.maxEntries);
  }
  for (const [key, value] of Object.entries(entries)) {
    if (utf8Length(key) > limits.maxKeyBytes) {
      throw new MetadataLimitExceededError('key', limits.maxKeyBytes);
    }
    if (utf8Length(value) > limits.maxValueBytes) {
      throw new MetadataLimitExceededError('value', limits.maxValueBytes, key);
    }
  }
  let total = 0;
  for (const [key, value] of Object.entries(result)) {
    total += utf8Length(key) + utf8Length(value);
  }
  if (total > limits.maxTotalBytes) {
    throw new MetadataLimitExceededError('total', limits.maxTotalBytes);
  }
}

/**
 * The size of a text in bytes when it is saved as UTF-8 (JSON in the database
 * is UTF-8). It is counted by hand because this package has no Node.js types,
 * so there is no `Buffer`. A lone surrogate counts 3 bytes, like `Buffer` does.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(index + 1))) {
      // A pair of two UTF-16 units is one character of 4 bytes.
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
