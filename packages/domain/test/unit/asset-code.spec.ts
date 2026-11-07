import { AssetCode } from '../../src/asset-code.js';
import { InvalidAssetCodeError } from '../../src/invalid-asset-code.error.js';

describe('AssetCode', () => {
  it.each(['USD', 'EUR', 'BTC', 'USDC', 'A00', 'ABCDEFGHIJKLMNOP', 'A'.concat('0'.repeat(15))])(
    'accepts %s',
    (text) => {
      expect(AssetCode.of(text).value).toBe(text);
    },
  );

  it.each([
    ['empty', ''],
    ['too short', 'US'],
    ['too long (17 characters)', 'ABCDEFGHIJKLMNOPQ'],
    ['lowercase', 'usd'],
    ['mixed case', 'Usd'],
    ['starts with a digit', '1USD'],
    ['has a slash', 'USD/2'],
    ['has an underscore', 'US_D'],
    ['has a space', 'US D'],
    ['has a trailing newline', 'USD\n'],
    ['has a non-ASCII letter', 'USÉ'],
  ])('rejects a text that is %s', (_name, text) => {
    expect(() => AssetCode.of(text)).toThrow(InvalidAssetCodeError);
  });

  it('rejects a value that is not a string', () => {
    expect(() => AssetCode.of(42 as unknown as string)).toThrow(InvalidAssetCodeError);
    expect(() => AssetCode.of(undefined as unknown as string)).toThrow(InvalidAssetCodeError);
  });

  it('has a stable error code and does not repeat the bad value', () => {
    const error = catchError(() => AssetCode.of('<script>'));

    expect(error).toBeInstanceOf(InvalidAssetCodeError);
    expect((error as InvalidAssetCodeError).code).toBe('INVALID_ASSET_CODE');
    expect((error as InvalidAssetCodeError).message).not.toContain('<script>');
  });

  it('compares by text', () => {
    expect(AssetCode.of('USD').equals(AssetCode.of('USD'))).toBe(true);
    expect(AssetCode.of('USD').equals(AssetCode.of('EUR'))).toBe(false);
  });

  it('turns into its text', () => {
    expect(String(AssetCode.of('USD'))).toBe('USD');
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}
