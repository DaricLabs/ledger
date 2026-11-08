import type { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { InvalidPostingError } from './invalid-posting.error.js';

/**
 * One move of money: an amount of one asset goes from the source account to
 * the destination account.
 *
 * It is a value object: it never changes, and a value of this type always
 * follows the rules. A transaction is a list of postings, and it either
 * happens fully or not at all.
 *
 * Money enters the ledger from `world` and leaves it to `world`. The ledger
 * does not treat `world` as special here: it is an account like any other
 * (its overdraft rule is in `AccountBalance`).
 */
export class Posting {
  private constructor(
    private readonly from: AccountAddress,
    private readonly to: AccountAddress,
    private readonly value: Money,
  ) {}

  /**
   * @throws {InvalidPostingError} If the amount is not above zero, or the
   * source and the destination are the same account.
   */
  static of(source: AccountAddress, destination: AccountAddress, money: Money): Posting {
    if (!money.isPositive()) {
      throw new InvalidPostingError('Posting amount must be greater than zero');
    }
    if (source.equals(destination)) {
      throw new InvalidPostingError('Posting source and destination must be different accounts');
    }
    return new Posting(source, destination, money);
  }

  /** The account the money leaves. */
  get source(): AccountAddress {
    return this.from;
  }

  /** The account the money goes to. */
  get destination(): AccountAddress {
    return this.to;
  }

  /** The amount that moves. It is always above zero. */
  get money(): Money {
    return this.value;
  }

  get asset(): AssetCode {
    return this.value.asset;
  }
}
