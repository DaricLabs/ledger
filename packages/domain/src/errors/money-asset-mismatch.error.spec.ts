import { MoneyAssetMismatchError } from './money-asset-mismatch.error.js';

describe('MoneyAssetMismatchError', () => {
  it('carries both assets and names them in the message', () => {
    const error = new MoneyAssetMismatchError('USD', 'EUR');

    expect(error.leftAsset).toBe('USD');
    expect(error.rightAsset).toBe('EUR');
    expect(error.message).toContain('USD');
    expect(error.message).toContain('EUR');
  });
});
