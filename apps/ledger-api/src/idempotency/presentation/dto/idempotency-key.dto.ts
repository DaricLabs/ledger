import { z } from 'zod';
import { IDEMPOTENCY_KEY_PATTERN } from '../../domain/constants/idempotency-key.constant.js';

/**
 * Shape of the `Idempotency-Key` header: 1 to 255 printable ASCII characters.
 * A key with another shape is a `VALIDATION` error (400), so the database never
 * has to refuse it.
 */
export const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_PATTERN, {
  error: 'Must be 1 to 255 printable ASCII characters',
});
