import { ValueObjectError } from './value-object.error.js';

/**
 * A text is not a valid asset code. See `ASSET_CODE_PATTERN` for the rules.
 *
 * The message is safe to show to API clients. It does not repeat the bad
 * value, because the value can be very long.
 */
export class InvalidAssetCodeError extends ValueObjectError {
  readonly code = 'INVALID_ASSET_CODE';

  constructor(options?: ErrorOptions) {
    super(
      'Asset code must have 3 to 16 characters: an uppercase letter first, then uppercase letters or digits',
      options,
    );
  }
}
