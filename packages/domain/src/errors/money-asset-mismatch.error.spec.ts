import { MoneyAssetMismatchError } from './money-asset-mismatch.error.js';

describe('MoneyAssetMismatchError', () => {
  it('carries both assets and says which ones in the message', () => {
    const error = new MoneyAssetMismatchError('USD', 'EUR');

    expect(error.leftAsset).toBe('USD');
    expect(error.rightAsset).toBe('EUR');
    expect(error.message).toBe('Cannot combine amounts of different assets: "USD" and "EUR"');
  });
});
