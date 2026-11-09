import { z } from 'zod';
import { ACCOUNT_ADDRESS_MAX_LENGTH, ACCOUNT_ADDRESS_PATTERN } from '@ledger/domain';

/**
 * An account address in a request (a body, a URL or a cursor). It checks the
 * shape only: a value that passes is a valid `AccountAddress`, and a value that
 * fails is a `VALIDATION` error (400) that never reaches the domain or the
 * database.
 */
export const accountAddressSchema = z
  .string()
  .max(ACCOUNT_ADDRESS_MAX_LENGTH, {
    error: `Must have up to ${ACCOUNT_ADDRESS_MAX_LENGTH} characters`,
  })
  .regex(ACCOUNT_ADDRESS_PATTERN, {
    error:
      'Must be parts separated by ":". Each part starts with a lowercase letter or digit, and has only lowercase letters, digits, "_" and "-"',
  });
