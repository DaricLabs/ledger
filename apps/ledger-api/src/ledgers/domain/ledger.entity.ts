import { InvalidLedgerMetadataError } from './invalid-ledger-metadata.error.js';
import { InvalidLedgerNameError } from './invalid-ledger-name.error.js';
import { LEDGER_NAME_PATTERN, RESERVED_LEDGER_NAMES } from './ledger-name.js';

/** Free-form key/value pairs on a ledger. Every value is a string. */
export type LedgerMetadata = Readonly<Record<string, string>>;

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
 * It is immutable, so it has getters and no setters. Nothing about a ledger
 * changes through the domain: the name never changes, and metadata edits are
 * done in storage. Getters return safe values (a frozen metadata object and a
 * copy of the date), so callers cannot change a ledger by accident.
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
   * @throws {InvalidLedgerMetadataError} If metadata is not an object or has a non-string value.
   */
  static create(props: LedgerProps): Ledger {
    assertValidName(props.name);
    assertValidMetadata(props.metadata);
    return new Ledger(snapshot(props));
  }

  /**
   * Rebuilds a ledger that was already saved. It trusts storage and does not
   * check the creation rules.
   *
   * This is on purpose: if a name is reserved later, ledgers that already use
   * it must still load.
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
    if (typeof value !== 'string') {
      throw new InvalidLedgerMetadataError(`Metadata value for key "${key}" must be a string`);
    }
  }
}
