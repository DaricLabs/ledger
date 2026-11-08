import { z } from 'zod';
import {
  ACCOUNT_ADDRESS_MAX_LENGTH,
  ACCOUNT_ADDRESS_PATTERN,
  ASSET_CODE_PATTERN,
} from '@ledger/domain';
import {
  TRANSACTION_MAX_POSTINGS,
  TRANSACTION_REFERENCE_MAX_LENGTH,
} from '../../domain/transaction-limits.js';

/** An account address in a request. It checks the shape only. */
const accountAddressSchema = z
  .string()
  .max(ACCOUNT_ADDRESS_MAX_LENGTH, {
    error: `Must have up to ${ACCOUNT_ADDRESS_MAX_LENGTH} characters`,
  })
  .regex(ACCOUNT_ADDRESS_PATTERN, {
    error:
      'Must be parts separated by ":". Each part starts with a lowercase letter or digit, and has only lowercase letters, digits, "_" and "-"',
  });

/** An asset code in a request. It checks the shape only. */
const assetCodeSchema = z.string().regex(ASSET_CODE_PATTERN, {
  error:
    'Must be 3 to 16 characters: uppercase letters and digits, and it must start with a letter',
});

/**
 * An amount in a request: a string of digits for a whole number above zero,
 * like `"1050"`. It is a string and not a JSON number on purpose. Many JSON
 * readers turn a number into a float and lose digits above 2^53, and money
 * must never lose a digit. Up to 78 digits fit the database column.
 *
 * The result is a `bigint`, because that is what the domain uses.
 */
const amountSchema = z
  .string({ error: 'Must be a string of digits, like "1050"' })
  .regex(/^[1-9][0-9]{0,77}$/, {
    error: 'Must be a whole number above zero, with up to 78 digits and no leading zeros',
  })
  .transform((amount) => BigInt(amount));

const postingSchema = z.strictObject({
  source: accountAddressSchema,
  destination: accountAddressSchema,
  asset: assetCodeSchema,
  amount: amountSchema,
});

/**
 * Body of `POST /ledgers/:ledgerName/transactions`.
 *
 * This checks the shape only, so clients get one `VALIDATION` error with a
 * detail per bad field. The rules that need domain knowledge (a posting needs
 * two different accounts) stay in the domain and come back as domain errors.
 *
 * Unknown fields are rejected on purpose. A typo like `refrence` would
 * otherwise be dropped without a word, and the client would think its
 * protection against repeats was on.
 */
export const createTransactionSchema = z.strictObject({
  postings: z.array(postingSchema).min(1).max(TRANSACTION_MAX_POSTINGS),
  reference: z.string().min(1).max(TRANSACTION_REFERENCE_MAX_LENGTH).optional(),
});

export type CreateTransactionDto = z.infer<typeof createTransactionSchema>;
