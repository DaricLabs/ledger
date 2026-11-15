/**
 * Limits of a transaction. They live in their own file so other layers (for
 * example the HTTP request schema) can reuse them without importing the
 * `Transaction` class.
 *
 * The limits are part of the public API. Making one bigger is safe. Making
 * one smaller can break clients that work today.
 */

/**
 * Most postings one transaction can have.
 *
 * Must match `postings_seq_max` in `0001_init.sql`: the database refuses a
 * posting with a `seq` above this. Changing it is a migration.
 */
export const TRANSACTION_MAX_POSTINGS = 100;

/**
 * Longest reference, in characters (UTF-16 code units, like `String.length`).
 *
 * The database allows 128 characters (`transactions_reference_length`). This
 * count is never lower than the database count, so a reference that passes
 * here always fits.
 */
export const TRANSACTION_REFERENCE_MAX_LENGTH = 128;
