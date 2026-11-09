import type { AccountAddress, Money } from '@ledger/domain';

/** The data an account is made of. */
export interface AccountProps {
  address: AccountAddress;
  /** `true` when the account may go below zero. */
  allowOverdraft: boolean;
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
 * setters. Getters return safe values (a frozen list and a copy of the date),
 * so callers cannot change an account by accident.
 *
 * It has no `create` yet, because an account is not made on its own. It is
 * made, with its balances, when a transaction first moves money through it
 * (see `IAccountBalanceRepository.open`). The rules of moving money are in
 * `AccountBalance`, which is what that write path uses.
 *
 * Make one with `Account.reconstitute`.
 */
export class Account {
  private constructor(private readonly props: Readonly<AccountProps>) {}

  /** Rebuilds an account that was read from storage. It trusts the data. */
  static reconstitute(props: AccountProps): Account {
    return new Account(
      Object.freeze({
        address: props.address,
        allowOverdraft: props.allowOverdraft,
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
}
