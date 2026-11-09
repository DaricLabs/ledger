import {
  balanceKeyText,
  compareBalanceKeys,
  type AccountBalance,
  type IBalanceKey,
} from '../../accounts/domain/account-balance.js';
import { InvalidTransactionError } from './invalid-transaction.error.js';
import type { Posting } from './posting.js';
import {
  TRANSACTION_MAX_POSTINGS,
  TRANSACTION_REFERENCE_MAX_LENGTH,
} from './transaction-limits.js';

/** The data a transaction is made of. */
export interface TransactionProps {
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
  /** The business time of the transaction: when it happened. */
  postedAt: Date;
  /** When the ledger saved it. */
  createdAt: Date;
}

/**
 * A transaction: a list of postings that happen together, all or nothing.
 *
 * It is immutable, so it has getters and no setters. Getters return safe
 * values (a frozen list and copies of the dates), so callers cannot change a
 * transaction by accident. Once saved, a transaction is never changed or
 * removed: a mistake is fixed by a new transaction.
 *
 * Make a new one with `Transaction.create`, and one that is read from
 * storage with `Transaction.reconstitute`.
 */
export class Transaction {
  private constructor(private readonly props: Readonly<TransactionProps>) {}

  /**
   * Makes a NEW transaction and checks the rules for it.
   *
   * @throws {InvalidTransactionError} If there are no postings or more than
   * `TRANSACTION_MAX_POSTINGS`, or the reference is empty or too long.
   */
  static create(props: TransactionProps): Transaction {
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
    return Transaction.from(props);
  }

  /**
   * Rebuilds a transaction that was read from storage.
   *
   * It trusts the data and does not check the rules of `create` again: only a
   * transaction that followed them was ever saved, and the database has the
   * same checks. The postings must be in the order of their `seq`.
   */
  static reconstitute(props: TransactionProps): Transaction {
    return Transaction.from(props);
  }

  /** Copies the data, so the caller cannot change a transaction through what it passed in. */
  private static from(props: TransactionProps): Transaction {
    return new Transaction(
      Object.freeze({
        id: props.id,
        organizationId: props.organizationId,
        ledgerId: props.ledgerId,
        reference: props.reference,
        postings: Object.freeze([...props.postings]),
        postedAt: new Date(props.postedAt),
        createdAt: new Date(props.createdAt),
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

  /** A new `Date` every time, because `Date` objects can be changed. */
  get postedAt(): Date {
    return new Date(this.props.postedAt);
  }

  /** A new `Date` every time, because `Date` objects can be changed. */
  get createdAt(): Date {
    return new Date(this.props.createdAt);
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
