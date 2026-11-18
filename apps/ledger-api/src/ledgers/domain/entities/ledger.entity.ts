import type { Metadata, MetadataEntries } from '@ledger/domain';
import { InvalidLedgerNameError } from '../errors/invalid-ledger-name.error.js';
import { LEDGER_NAME_PATTERN, RESERVED_LEDGER_NAMES } from '../constants/ledger-name.constant.js';

/** The data a ledger is made of. */
export interface ILedgerProps {
  /** UUIDv7. Made by the caller (the use case), never by the database. */
  id: string;
  /** The owner organization. An opaque id from the Identity service. */
  organizationId: string;
  /** Unique inside the organization. Never changes after creation. */
  name: string;
  /** Already checked: a `Metadata` is always valid. */
  metadata: Metadata;
  createdAt: Date;
}

/**
 * A ledger: a named book of accounts and transactions that belongs to one
 * organization.
 *
 * It is immutable, so it has getters and no setters. A change gives back a
 * new ledger (`withMetadata`, `withoutMetadataKey`) and leaves the old one as
 * it was. The name never changes. Getters return safe values (an immutable
 * `Metadata` and a copy of the date), so callers cannot change a ledger by
 * accident.
 *
 * The metadata rules and limits are the rules of `Metadata`, not of this
 * class.
 *
 * The counter that numbers `ledger_logs` is not part of this class. It is a
 * storage detail that only a database trigger changes.
 *
 * Make one with `Ledger.create` (new ledger, the name rules are checked) or
 * `Ledger.reconstitute` (a ledger loaded from storage, rules are not checked).
 */
export class Ledger {
  private constructor(private readonly props: Readonly<ILedgerProps>) {}

  /**
   * Makes a NEW ledger and checks the rules for it.
   *
   * The check repeats the one at the API edge on purpose. Types disappear at
   * runtime, so this class stays safe even when a caller skips the edge
   * checks. The metadata needs no check here, because a `Metadata` is already
   * valid.
   *
   * @throws {InvalidLedgerNameError} If the name has a wrong shape or is reserved.
   */
  static create(props: ILedgerProps): Ledger {
    assertValidName(props.name);
    return new Ledger(snapshot(props));
  }

  /**
   * Rebuilds a ledger that was already saved. It trusts storage and does not
   * check the creation rules.
   *
   * This is on purpose: if a name is reserved or a limit gets smaller later,
   * ledgers that already exist must still load.
   */
  static reconstitute(props: ILedgerProps): Ledger {
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

  /** Immutable: a change gives back a new `Metadata`. */
  get metadata(): Metadata {
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
   * @throws {InvalidMetadataError} If `changes` is not an object, has an empty
   * key, or has a non-string value.
   * @throws {MetadataLimitExceededError} If a key or a value of `changes` is
   * too long, or the metadata after the change would have too many keys or be
   * too big. See `Metadata.merge` for the details.
   */
  withMetadata(changes: MetadataEntries): Ledger {
    const merged = this.props.metadata.merge(changes);
    if (merged === this.props.metadata) {
      return this;
    }
    return new Ledger(snapshot({ ...this.props, metadata: merged }));
  }

  /**
   * Gives a ledger without this metadata key.
   *
   * Returns this same instance when the key is not there, so the caller can
   * compare with `===` and skip the save. Deleting a key that does not exist
   * is not an error. It never checks the limits (see `Metadata.remove`).
   */
  withoutMetadataKey(key: string): Ledger {
    const remaining = this.props.metadata.remove(key);
    if (remaining === this.props.metadata) {
      return this;
    }
    return new Ledger(snapshot({ ...this.props, metadata: remaining }));
  }
}

/**
 * Copies the input, so later changes by the caller cannot reach the ledger.
 * The metadata needs no copy: a `Metadata` never changes.
 */
function snapshot(props: ILedgerProps): Readonly<ILedgerProps> {
  return Object.freeze({
    id: props.id,
    organizationId: props.organizationId,
    name: props.name,
    metadata: props.metadata,
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
