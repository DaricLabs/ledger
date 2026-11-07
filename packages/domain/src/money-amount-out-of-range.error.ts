import { ValueObjectError } from './value-object-error.js';

/**
 * An amount of money is bigger (or smaller) than the storage can hold.
 *
 * Thrown by `Money.of`, and by `Money.plus` and `Money.minus` when the result
 * is out of range. See `MAX_MONEY_AMOUNT`.
 *
 * The message is safe to show to API clients.
 */
export class MoneyAmountOutOfRangeError extends ValueObjectError {
  readonly code = 'MONEY_AMOUNT_OUT_OF_RANGE';

  constructor(options?: ErrorOptions) {
    super('Amount must be a whole number with at most 78 digits', options);
  }
}
