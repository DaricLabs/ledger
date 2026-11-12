import { InvalidAssetCodeError } from '../errors/invalid-asset-code.error.js';
import { AssetCode } from './asset-code.vo.js';

describe('AssetCode', () => {
  it.each(['USD', 'EUR', 'BTC', 'USDC', 'A00', 'ABCDEFGHIJKLMNOP', `A${'0'.repeat(15)}`])(
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

  it('does not repeat the bad value in the error message', () => {
    expect(() => AssetCode.of('<script>')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('<script>') }),
    );
  });

  it('compares by text', () => {
    expect(AssetCode.of('USD').equals(AssetCode.of('USD'))).toBe(true);
    expect(AssetCode.of('USD').equals(AssetCode.of('EUR'))).toBe(false);
  });

  it('turns into its text', () => {
    expect(String(AssetCode.of('USD'))).toBe('USD');
  });
});
