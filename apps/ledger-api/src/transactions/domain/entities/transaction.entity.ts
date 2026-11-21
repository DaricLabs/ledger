import { Metadata, type MetadataEntries } from '@ledger/domain';
import {
  balanceKeyText,
  compareBalanceKeys,
  type AccountBalance,
  type IBalanceKey,
} from '../../../accounts/domain/entities/account-balance.entity.js';
import { InvalidTransactionError } from '../errors/invalid-transaction.error.js';
import { TransactionAlreadyRevertedError } from '../errors/transaction-already-reverted.error.js';
import type { Posting } from '../value-objects/posting.vo.js';
import {
  TRANSACTION_MAX_POSTINGS,
  TRANSACTION_REFERENCE_MAX_LENGTH,
} from '../constants/transaction-limits.constant.js';

/** The data a NEW transaction is made of. A new transaction is not reverted. */
export interface INewTransactionProps {
  /** UUIDv7. Made by the caller (the use case), never by the database. */
  id: string;
  /** The owner organization. An opaque id from the Identity service. */
  organizationId: string;
  /** The ledger the transaction belongs to. */
  ledgerId: string;
  /**
   * The id the caller gives to the transaction, if any. It is unique inside
   * the ledger, so it also protects against sending the same transaction twice.
   */
  reference: string | null;
  /** The moves of money, applied one after the other, in this order. */
  postings: readonly Posting[];
  /** Free-form key/value pairs of the caller. Already checked: a `Metadata` is always valid. */
  metadata: Metadata;
  /** The business time of the transaction: when it happened. */
  postedAt: Date;
  /** When the ledger saved it. */
  createdAt: Date;
}

/** The data a transaction is made of, as it is saved. */
export interface ITransactionProps extends INewTransactionProps {
  /** When the transaction was reverted, or `null` if it was not. */
  revertedAt: Date | null;
  /** The transaction that reverted this one, or `null` if it was not reverted. */
  revertedByTransactionId: string | null;
}

/**
 * A transaction: a list of postings that happen together, all or nothing.
 *
 * It is immutable, so it has getters and no setters. Getters return safe
 * values (a frozen list, an immutable `Metadata` and copies of the dates), so
 * callers cannot change a transaction by accident. Once saved, a transaction
 * is never changed or removed: a mistake is fixed by a new transaction. Only
 * two things change later. A transaction can get reverted (see `reverse`),
 * which is saved by the repository, not by this class. And its metadata can
 * be edited (`withMetadata`, `withoutMetadataKey`), which gives back a new
 * transaction. The postings never change.
 *
 * Make a new one with `Transaction.create`, and one that is read from
 * storage with `Transaction.reconstitute`.
 */
export class Transaction {
  private constructor(private readonly props: Readonly<ITransactionProps>) {}

  /**
   * Makes a NEW transaction and checks the rules for it.
   *
   * @throws {InvalidTransactionError} If there are no postings or more than
   * `TRANSACTION_MAX_POSTINGS`, or the reference is empty or too long.
   */
  static create(props: INewTransactionProps): Transaction {
    if (props.postings.length < 1 || props.postings.length > TRANSACTION_MAX_POSTINGS) {
      throw new InvalidTransactionError(
        `A transaction must have 1 to ${TRANSACTION_MAX_POSTINGS} postings`,
      );
    }
    // The parameter is typed, but the value can come from any JSON body, and
    // an empty reference would pass the database check only by luck.
    if (
      props.reference !== null &&
      (typeof props.reference !== 'string' ||
        props.reference.length < 1 ||
        props.reference.length > TRANSACTION_REFERENCE_MAX_LENGTH)
    ) {
      throw new InvalidTransactionError(
        `Reference must be 1 to ${TRANSACTION_REFERENCE_MAX_LENGTH} characters`,
      );
    }
    return Transaction.from({ ...props, revertedAt: null, revertedByTransactionId: null });
  }

  /**
   * Rebuilds a transaction that was read from storage.
   *
   * It trusts the data and does not check the rules of `create` again: only a
   * transaction that followed them was ever saved, and the database has the
   * same checks. The postings must be in the order of their `seq`.
   */
  static reconstitute(props: ITransactionProps): Transaction {
    return Transaction.from(props);
  }

  /**
   * This transaction as it was when it was saved: not reverted, and with the
   * metadata it was created with. This is what the request that made it
   * answered. A repeated request (same idempotency key) must answer the same,
   * even if the transaction was reverted or its metadata was edited since.
   *
   * @param createdMetadata The metadata the transaction was created with. The
   * transaction does not keep it, because edits replace it. The caller knows
   * it: the key matched, so the repeated request has the same metadata as the
   * first one.
   */
  asCreated(createdMetadata: Metadata): Transaction {
    return Transaction.from({
      ...this.props,
      metadata: createdMetadata,
      revertedAt: null,
      revertedByTransactionId: null,
    });
  }

  /** Copies the data, so the caller cannot change a transaction through what it passed in. */
  private static from(props: ITransactionProps): Transaction {
    return new Transaction(
      Object.freeze({
        id: props.id,
        organizationId: props.organizationId,
        ledgerId: props.ledgerId,
        reference: props.reference,
        postings: Object.freeze([...props.postings]),
        // No copy needed: a `Metadata` never changes.
        metadata: props.metadata,
        postedAt: new Date(props.postedAt),
        createdAt: new Date(props.createdAt),
        revertedAt: props.revertedAt === null ? null : new Date(props.revertedAt),
        revertedByTransactionId: props.revertedByTransactionId,
      }),
    );
  }

  get id(): string {
    return this.props.id;
  }

  get organizationId(): string {
    return this.props.organizationId;
  }

  get ledgerId(): string {
    return this.props.ledgerId;
  }

  get reference(): string | null {
    return this.props.reference;
  }

  /** A frozen list. Postings are applied in this order. */
  get postings(): readonly Posting[] {
    return this.props.postings;
  }

  /** Immutable: a change gives back a new transaction with a new `Metadata`. */
  get metadata(): Metadata {
    return this.props.metadata;
  }

  /** A new `Date` every time, because `Date` objects can be changed. */
  get postedAt(): Date {
    return new Date(this.props.postedAt);
  }

  /** A new `Date` every time, because `Date` objects can be changed. */
  get createdAt(): Date {
    return new Date(this.props.createdAt);
  }

  /** When the transaction was reverted. A new `Date` every time. `null` if it was not reverted. */
  get revertedAt(): Date | null {
    return this.props.revertedAt === null ? null : new Date(this.props.revertedAt);
  }

  /** The transaction that reverted this one, or `null` if it was not reverted. */
  get revertedByTransactionId(): string | null {
    return this.props.revertedByTransactionId;
  }

  /** `true` when a later transaction undid this one. */
  get isReverted(): boolean {
    return this.props.revertedByTransactionId !== null;
  }

  /**
   * Gives a transaction with these metadata entries added. A key that is
   * already there gets the new value, and the other keys stay as they are.
   * The postings and everything else stay as they are.
   *
   * Returns this same instance when nothing would change (every key already
   * has this value), so the caller can compare with `===` and skip the save.
   * Reverted or not, a transaction can always get metadata.
   *
   * @throws {InvalidMetadataError} If `changes` is not an object, has an empty
   * key, or has a non-string value.
   * @throws {MetadataLimitExceededError} If a key or a value of `changes` is
   * too long, or the metadata after the change would have too many keys or be
   * too big. See `Metadata.merge` for the details.
   */
  withMetadata(changes: MetadataEntries): Transaction {
    const merged = this.props.metadata.merge(changes);
    if (merged === this.props.metadata) {
      return this;
    }
    return Transaction.from({ ...this.props, metadata: merged });
  }

  /**
   * Gives a transaction without this metadata key.
   *
   * Returns this same instance when the key is not there, so the caller can
   * compare with `===` and skip the save. Deleting a key that does not exist
   * is not an error. It never checks the limits (see `Metadata.remove`).
   */
  withoutMetadataKey(key: string): Transaction {
    const remaining = this.props.metadata.remove(key);
    if (remaining === this.props.metadata) {
      return this;
    }
    return Transaction.from({ ...this.props, metadata: remaining });
  }

  /**
   * Makes the NEW transaction that undoes this one: every posting goes the
   * other way, in the opposite order.
   *
   * The order is reversed on purpose. Postings are checked one after the
   * other, so for `a -> b` and then `b -> c`, the money must go back from `c`
   * to `b` first, and only then from `b` to `a`. In the same order, `b` would
   * have to pay `a` before it got the money back.
   *
   * The new transaction has no reference, because a reference belongs to one
   * transaction. Its metadata is only what the caller gives for the revert (a
   * `reason`, for example), and empty by default. The metadata of this
   * transaction is never copied, because it describes the facts of this one
   * (an order id, a payment id) and the revert has its own. The new
   * transaction is not saved and it does not apply anything. The caller
   * applies it like any new transaction (`touchedBalances` and `applyTo`),
   * which fails if the money was spent in the meantime. This transaction is
   * not changed: the caller saves that it was reverted.
   *
   * @param reversal The `id` of the new transaction, `at`, the time it
   * happened and was saved, and the optional `metadata` of the revert. A
   * `Metadata` is already checked.
   * @throws {TransactionAlreadyRevertedError} If this transaction was
   * reverted before.
   */
  reverse(reversal: { id: string; at: Date; metadata?: Metadata }): Transaction {
    if (this.isReverted) {
      throw new TransactionAlreadyRevertedError(this.props.id);
    }
    return Transaction.create({
      id: reversal.id,
      organizationId: this.props.organizationId,
      ledgerId: this.props.ledgerId,
      reference: null,
      postings: this.props.postings.map((posting) => posting.reversed()).reverse(),
      metadata: reversal.metadata ?? Metadata.empty(),
      postedAt: reversal.at,
      createdAt: reversal.at,
    });
  }

  /**
   * The balances this transaction reads or changes: each pair of account and
   * asset that is in a posting, once.
   *
   * The list is in the lock order (see `compareBalanceKeys`). A caller that
   * locks the balances must lock them in this order.
   */
  touchedBalances(): IBalanceKey[] {
    const unique = new Map<string, IBalanceKey>();
    for (const posting of this.props.postings) {
      for (const address of [posting.source, posting.destination]) {
        const key = { address, asset: posting.asset };
        unique.set(balanceKeyText(key), key);
      }
    }
    return [...unique.values()].sort(compareBalanceKeys);
  }

  /**
   * Applies the postings, one after the other, to the balances they touch.
   *
   * Each posting is checked when it is applied, so the order of the postings
   * matters. A transaction that takes money out of an account before the money
   * comes in fails, even if the account would end above zero.
   *
   * @param balances The current balance of every key of `touchedBalances()`,
   * in any order. Nothing is changed in them: new balances are returned.
   * @returns The new balance of every key of `touchedBalances()`.
   * @throws {InsufficientFundsError} If a posting takes more out of an account
   * than it has, and the account may not go below zero.
   * @throws {MoneyAmountOutOfRangeError} If a balance would be too big to store.
   * @throws {Error} If a balance is missing. The caller loads the balances of
   * `touchedBalances()`, so this is a bug and not a user mistake.
   */
  applyTo(balances: readonly AccountBalance[]): AccountBalance[] {
    const current = new Map(balances.map((balance) => [balanceKeyText(balance.key), balance]));
    const balanceOf = (key: IBalanceKey): AccountBalance => {
      const balance = current.get(balanceKeyText(key));
      if (balance === undefined) {
        throw new Error(`Balance of "${key.address.value}" in "${key.asset.value}" was not loaded`);
      }
      return balance;
    };

    for (const posting of this.props.postings) {
      const source = balanceOf({ address: posting.source, asset: posting.asset });
      const destination = balanceOf({ address: posting.destination, asset: posting.asset });
      // `debit` first: if the source cannot pay, nothing else matters.
      const debited = source.debit(posting.money);
      current.set(balanceKeyText(debited.key), debited);
      const credited = destination.credit(posting.money);
      current.set(balanceKeyText(credited.key), credited);
    }

    return this.touchedBalances().map(balanceOf);
  }
}
