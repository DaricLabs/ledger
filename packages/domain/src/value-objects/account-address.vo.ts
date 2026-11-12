import { InvalidAccountAddressError } from '../errors/invalid-account-address.error.js';

/**
 * Allowed shape of an account address: parts separated by `:`. Each part
 * starts with a lowercase letter or digit, and has only lowercase letters,
 * digits, `_` and `-`. For example `world`, `users:42`, `platform:fees`.
 *
 * Must match the `account_address` domain in `0001_init.sql`. If you change
 * one, change the other. The total length is limited by
 * `ACCOUNT_ADDRESS_MAX_LENGTH`, which is checked on its own.
 */
export const ACCOUNT_ADDRESS_PATTERN = /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/;

/** Longest account address, in characters. */
export const ACCOUNT_ADDRESS_MAX_LENGTH = 256;

/**
 * The address of an account, for example `users:42:main`.
 *
 * It is a value object: it never changes, and two addresses with the same
 * text are equal. Make one with `AccountAddress.of`, which checks the rules,
 * so a value of this type is always valid.
 *
 * The `:` splits an address into parts, like folders in a path. The ledger
 * does not give the parts any meaning. `users:42:main` is just a name, and
 * the ledger does not know that `users:42` exists. Use `segments` when you
 * need the parts, so no one splits the text by hand.
 */
export class AccountAddress {
  /**
   * The special account that money enters the ledger from. It is the only
   * account the ledger creates by itself, and it may always go below zero.
   */
  static readonly WORLD: AccountAddress = new AccountAddress('world');

  private constructor(private readonly text: string) {}

  /**
   * @throws {InvalidAccountAddressError} If the text is too long or does not follow `ACCOUNT_ADDRESS_PATTERN`.
   */
  static of(value: string): AccountAddress {
    // The type check comes first on purpose: the pattern turns `null` or `42`
    // into text before it checks, and the text "null" is a valid address.
    if (
      typeof value !== 'string' ||
      value.length > ACCOUNT_ADDRESS_MAX_LENGTH ||
      !ACCOUNT_ADDRESS_PATTERN.test(value)
    ) {
      throw new InvalidAccountAddressError();
    }
    return new AccountAddress(value);
  }

  /** The address as text, for example `users:42:main`. */
  get value(): string {
    return this.text;
  }

  /** The parts of the address, for example `['users', '42', 'main']`. */
  get segments(): readonly string[] {
    return this.text.split(':');
  }

  isWorld(): boolean {
    return this.equals(AccountAddress.WORLD);
  }

  equals(other: AccountAddress): boolean {
    return this.text === other.text;
  }

  toString(): string {
    return this.text;
  }
}
