import { Money, type AccountAddress, type AssetCode } from '@ledger/domain';
import { InsufficientFundsError } from './insufficient-funds.error.js';

/** Which balance: the money of one asset on one account. */
export interface IBalanceKey {
  address: AccountAddress;
  asset: AssetCode;
}

/**
 * Turns a balance key into a text, to use as a key of a `Map`. A space cannot
 * be in an address or in an asset code, so two different keys never give the
 * same text.
 */
export function balanceKeyText(key: IBalanceKey): string {
  return `${key.address.value} ${key.asset.value}`;
}

/**
 * The order in which balances are locked: by address, then by asset, compared
 * by character code (not by language rules, so every place gives the same
 * order).
 *
 * One order for everyone is what stops two transactions from waiting for each
 * other forever (a deadlock): both lock the shared balances in the same order,
 * so one of them always goes first. The database adapter orders its queries in
 * the same way.
 */
export function compareBalanceKeys(left: IBalanceKey, right: IBalanceKey): number {
  if (left.address.value !== right.address.value) {
    return left.address.value < right.address.value ? -1 : 1;
  }
  if (left.asset.value !== right.asset.value) {
    return left.asset.value < right.asset.value ? -1 : 1;
  }
  return 0;
}

/** The data an `AccountBalance` is made of. */
interface AccountBalanceProps {
  address: AccountAddress;
  balance: Money;
  allowOverdraft: boolean;
}

/**
 * The money of one asset on one account, and whether the account may go below
 * zero.
 *
 * It never changes: `credit` and `debit` give a new balance and leave the old
 * one as it was. This is where the rule "an account cannot spend more than it
 * has" lives. The database has the same rule as a last guard
 * (`balances_nonnegative_unless_overdraft`), but a person gets a useful error
 * from here, and the database only knows that something is wrong.
 *
 * Make one with `AccountBalance.open` (a new account) or
 * `AccountBalance.reconstitute` (a balance loaded from storage).
 */
export class AccountBalance {
  private constructor(private readonly props: Readonly<AccountBalanceProps>) {}

  /**
   * The balance of an account that has never held this asset: zero. The
   * account may go below zero only if it is `world`, the account that money
   * enters the ledger from.
   */
  static open(address: AccountAddress, asset: AssetCode): AccountBalance {
    return new AccountBalance({
      address,
      balance: Money.zero(asset),
      allowOverdraft: address.isWorld(),
    });
  }

  /** Rebuilds a balance that was already saved. It trusts storage. */
  static reconstitute(props: AccountBalanceProps): AccountBalance {
    return new AccountBalance({ ...props });
  }

  get address(): AccountAddress {
    return this.props.address;
  }

  get asset(): AssetCode {
    return this.props.balance.asset;
  }

  /** What the account holds now. It is negative only when overdraft is allowed. */
  get balance(): Money {
    return this.props.balance;
  }

  /** `true` when the account may go below zero. */
  get allowOverdraft(): boolean {
    return this.props.allowOverdraft;
  }

  get key(): IBalanceKey {
    return { address: this.props.address, asset: this.props.balance.asset };
  }

  /**
   * Gives a balance with this money added.
   *
   * @throws {MoneyAssetMismatchError} If the money is of another asset.
   * @throws {MoneyAmountOutOfRangeError} If the result is too big to store.
   */
  credit(money: Money): AccountBalance {
    return new AccountBalance({ ...this.props, balance: this.props.balance.plus(money) });
  }

  /**
   * Gives a balance with this money taken out.
   *
   * @throws {InsufficientFundsError} If the result would be below zero and the
   * account is not allowed to go below zero.
   * @throws {MoneyAssetMismatchError} If the money is of another asset.
   * @throws {MoneyAmountOutOfRangeError} If the result is too big to store.
   */
  debit(money: Money): AccountBalance {
    const remaining = this.props.balance.minus(money);
    if (remaining.isNegative() && !this.props.allowOverdraft) {
      throw new InsufficientFundsError(
        this.props.address.value,
        this.asset.value,
        this.props.balance.amount.toString(),
        money.amount.toString(),
      );
    }
    return new AccountBalance({ ...this.props, balance: remaining });
  }
}
