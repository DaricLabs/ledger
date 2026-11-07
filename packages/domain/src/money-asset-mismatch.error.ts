import { ValueObjectError } from './value-object-error.js';

/**
 * Two amounts of money were combined, but they are in different assets (for
 * example USD and EUR). Amounts of different assets cannot be added or
 * subtracted.
 *
 * The message is safe to show to API clients.
 */
export class MoneyAssetMismatchError extends ValueObjectError {
  readonly code = 'MONEY_ASSET_MISMATCH';

  constructor(
    readonly leftAsset: string,
    readonly rightAsset: string,
    options?: ErrorOptions,
  ) {
    super(
      `Cannot combine amounts of different assets: "${leftAsset}" and "${rightAsset}"`,
      options,
    );
  }
}
