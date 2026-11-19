import type { AccountAddress, Metadata, MetadataEntries, Money } from '@ledger/domain';

/** The data an account is made of. */
export interface IAccountProps {
  address: AccountAddress;
  /** `true` when the account may go below zero. */
  allowOverdraft: boolean;
  /** Free-form key/value pairs of the caller. Already checked: a `Metadata` is always valid. */
  metadata: Metadata;
  /** When the ledger first saw the account. */
  createdAt: Date;
  /**
   * What the account holds now: one entry for each asset the account has ever
   * held, in the order of the asset codes. An amount is negative only when
   * overdraft is allowed.
   */
  balances: readonly Money[];
}

/**
 * An account of a ledger, as it is now: its rules and what it holds.
 *
 * It is a view of storage and it is immutable, so it has getters and no
 * setters. Getters return safe values (a frozen list, an immutable `Metadata`
 * and a copy of the date), so callers cannot change an account by accident.
 * Only the metadata can be edited (`withMetadata`, `withoutMetadataKey`), and
 * an edit gives back a new account.
 *
 * It has no `create` yet, because an account is not made on its own. It is
 * made, with its balances, when a transaction first moves money through it
 * (see `IAccountBalanceRepository.open`). The rules of moving money are in
 * `AccountBalance`, which is what that write path uses.
 *
 * Make one with `Account.reconstitute`.
 */
export class Account {
  private constructor(private readonly props: Readonly<IAccountProps>) {}

  /** Rebuilds an account that was read from storage. It trusts the data. */
  static reconstitute(props: IAccountProps): Account {
    return Account.from(props);
  }

  /** Copies the data, so the caller cannot change an account through what it passed in. */
  private static from(props: IAccountProps): Account {
    return new Account(
      Object.freeze({
        address: props.address,
        allowOverdraft: props.allowOverdraft,
        // No copy needed: a `Metadata` never changes.
        metadata: props.metadata,
        createdAt: new Date(props.createdAt),
        balances: Object.freeze([...props.balances]),
      }),
    );
  }

  get address(): AccountAddress {
    return this.props.address;
  }

  get allowOverdraft(): boolean {
    return this.props.allowOverdraft;
  }

  /** A new `Date` every time, because `Date` objects can be changed. */
  get createdAt(): Date {
    return new Date(this.props.createdAt);
  }

  /** A frozen list, in the order of the asset codes. */
  get balances(): readonly Money[] {
    return this.props.balances;
  }

  /** Immutable: a change gives back a new account with a new `Metadata`. */
  get metadata(): Metadata {
    return this.props.metadata;
  }

  /**
   * Gives an account with these metadata entries added. A key that is already
   * there gets the new value, and the other keys stay as they are. The
   * balances and everything else stay as they are.
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
  withMetadata(changes: MetadataEntries): Account {
    const merged = this.props.metadata.merge(changes);
    if (merged === this.props.metadata) {
      return this;
    }
    return Account.from({ ...this.props, metadata: merged });
  }

  /**
   * Gives an account without this metadata key.
   *
   * Returns this same instance when the key is not there, so the caller can
   * compare with `===` and skip the save. Deleting a key that does not exist
   * is not an error. It never checks the limits (see `Metadata.remove`).
   */
  withoutMetadataKey(key: string): Account {
    const remaining = this.props.metadata.remove(key);
    if (remaining === this.props.metadata) {
      return this;
    }
    return Account.from({ ...this.props, metadata: remaining });
  }
}
