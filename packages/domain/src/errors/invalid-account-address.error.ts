import { ValueObjectError } from './value-object.error.js';

/**
 * A text is not a valid account address. See `ACCOUNT_ADDRESS_PATTERN` and
 * `ACCOUNT_ADDRESS_MAX_LENGTH` for the rules.
 *
 * The message is safe to show to API clients. It does not repeat the bad
 * value, because the value can be very long.
 */
export class InvalidAccountAddressError extends ValueObjectError {
  readonly code = 'INVALID_ACCOUNT_ADDRESS';

  constructor(options?: ErrorOptions) {
    super(
      'Account address must have up to 256 characters, in parts separated by ":". Each part starts with a lowercase letter or digit, and has only lowercase letters, digits, "_" and "-"',
      options,
    );
  }
}
