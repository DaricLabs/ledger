/**
 * Rules for a ledger name. They live in their own file so other layers (for
 * example the HTTP request schema) can reuse them without importing the
 * `Ledger` class.
 */

/**
 * Allowed shape of a ledger name: 1 to 63 characters, lowercase letters,
 * digits, `_` and `-`, and it must start with a letter or digit.
 *
 * Must match the `ledger_name` domain in `0001_init.sql`. If you change one,
 * change the other.
 */
export const LEDGER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Names nobody may use for a new ledger, because the platform keeps them.
 *
 * Only `Ledger.create` checks this list. `Ledger.reconstitute` does not, so
 * adding a name here never breaks a ledger that already exists.
 */
export const RESERVED_LEDGER_NAMES: ReadonlySet<string> = new Set(['default', 'system']);
