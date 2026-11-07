import { InvalidAssetCodeError } from './invalid-asset-code.error.js';

/**
 * Allowed shape of an asset code: 3 to 16 characters, uppercase letters and
 * digits, and it must start with a letter. For example `USD`, `BTC`, `USDC`.
 *
 * Must match the `asset_code` domain in `0001_init.sql`. If you change one,
 * change the other.
 *
 * It lives here as a constant so the HTTP request schema can reuse it
 * without making an `AssetCode` first.
 */
export const ASSET_CODE_PATTERN = /^[A-Z][A-Z0-9]{2,15}$/;

/**
 * The code of an asset, for example `USD` or `BTC`.
 *
 * It is a value object: it has no id, it never changes, and two codes with
 * the same text are equal. Make one with `AssetCode.of`, which checks the
 * rules, so a value of this type is always valid.
 *
 * Amounts are always whole numbers of the smallest unit of the asset (cents
 * for USD, satoshi for BTC). How many decimals the asset has is a question
 * for the layer that shows money to people, not for this class.
 */
export class AssetCode {
  private constructor(private readonly text: string) {}

  /**
   * @throws {InvalidAssetCodeError} If the text does not follow `ASSET_CODE_PATTERN`.
   */
  static of(value: string): AssetCode {
    if (typeof value !== 'string' || !ASSET_CODE_PATTERN.test(value)) {
      throw new InvalidAssetCodeError();
    }
    return new AssetCode(value);
  }

  /** The code as text, for example `USD`. */
  get value(): string {
    return this.text;
  }

  equals(other: AssetCode): boolean {
    return this.text === other.text;
  }

  toString(): string {
    return this.text;
  }
}
