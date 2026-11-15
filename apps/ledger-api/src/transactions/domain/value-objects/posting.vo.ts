import type { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { InvalidPostingError } from '../errors/invalid-posting.error.js';

/** The data a posting is made of. */
interface IPostingProps {
  source: AccountAddress;
  destination: AccountAddress;
  money: Money;
}

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
  private constructor(private readonly props: Readonly<IPostingProps>) {}

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
    return new Posting(Object.freeze({ source, destination, money }));
  }

  /** The account the money leaves. */
  get source(): AccountAddress {
    return this.props.source;
  }

  /** The account the money goes to. */
  get destination(): AccountAddress {
    return this.props.destination;
  }

  /** The amount that moves. It is always above zero. */
  get money(): Money {
    return this.props.money;
  }

  /** The asset of the amount. */
  get asset(): AssetCode {
    return this.props.money.asset;
  }
}
