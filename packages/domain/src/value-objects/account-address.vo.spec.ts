import { InvalidAccountAddressError } from '../errors/invalid-account-address.error.js';
import { ACCOUNT_ADDRESS_MAX_LENGTH, AccountAddress } from './account-address.vo.js';

describe('AccountAddress', () => {
  it.each([
    'world',
    'users:42',
    'users:42:main',
    'platform:fees',
    'a',
    '0',
    'a-b_c:d-e_f',
    'x:1:2:3:4',
  ])('accepts %s', (text) => {
    expect(AccountAddress.of(text).value).toBe(text);
  });

  it('accepts an address of exactly the longest size', () => {
    const text = 'a'.repeat(ACCOUNT_ADDRESS_MAX_LENGTH);

    expect(AccountAddress.of(text).value).toBe(text);
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(ACCOUNT_ADDRESS_MAX_LENGTH + 1)],
    ['uppercase', 'Users:42'],
    ['starts with a colon', ':users'],
    ['ends with a colon', 'users:'],
    ['has an empty part', 'users::42'],
    ['a part starts with an underscore', 'users:_42'],
    ['a part starts with a dash', 'users:-42'],
    ['starts with a dash', '-users'],
    ['has a space', 'users 42'],
    ['has a slash', 'users/42'],
    ['has a dot', 'users.42'],
    ['has a trailing newline', 'users:42\n'],
    ['has a non-ASCII letter', 'usérs'],
  ])('rejects an address that is %s', (_name, text) => {
    expect(() => AccountAddress.of(text)).toThrow(InvalidAccountAddressError);
  });

  it('rejects a value that is not a string', () => {
    expect(() => AccountAddress.of(42 as unknown as string)).toThrow(InvalidAccountAddressError);
    expect(() => AccountAddress.of(null as unknown as string)).toThrow(InvalidAccountAddressError);
  });

  it('does not repeat the bad value in the error message', () => {
    expect(() => AccountAddress.of('Bad Address')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('Bad Address') }),
    );
  });

  it('splits into parts', () => {
    expect(AccountAddress.of('users:42:main').segments).toEqual(['users', '42', 'main']);
    expect(AccountAddress.of('world').segments).toEqual(['world']);
  });

  it('knows the world account', () => {
    expect(AccountAddress.WORLD.value).toBe('world');
    expect(AccountAddress.of('world').isWorld()).toBe(true);
    expect(AccountAddress.of('world:fees').isWorld()).toBe(false);
    expect(AccountAddress.of('users:1').isWorld()).toBe(false);
  });

  it('compares by text', () => {
    expect(AccountAddress.of('users:1').equals(AccountAddress.of('users:1'))).toBe(true);
    expect(AccountAddress.of('users:1').equals(AccountAddress.of('users:2'))).toBe(false);
    expect(AccountAddress.of('world').equals(AccountAddress.WORLD)).toBe(true);
  });

  it('turns into its text', () => {
    expect(String(AccountAddress.of('users:1'))).toBe('users:1');
  });
});
