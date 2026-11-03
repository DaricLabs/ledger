import { z } from 'zod';
import { LEDGER_NAME_PATTERN } from '../../domain/ledger-name.js';

/**
 * Body of `POST /ledgers`.
 *
 * This checks the shape only, so clients get one `VALIDATION` error with a
 * detail per bad field. The rules that need domain knowledge (reserved names)
 * stay in `Ledger.create` and come back as domain errors.
 *
 * A `__proto__` key in metadata is dropped by Zod without an error. That is
 * safe (the object is not polluted), so we accept it.
 *
 * Unknown fields are rejected on purpose. A typo like `metdata` would
 * otherwise be dropped without a word, and the client would think its
 * metadata was saved.
 */
export const createLedgerSchema = z.strictObject({
  name: z.string().regex(LEDGER_NAME_PATTERN, {
    error:
      'Must be 1 to 63 characters: lowercase letters, digits, "_" or "-", and start with a letter or digit',
  }),
  metadata: z.record(z.string(), z.string()).default({}),
});

export type CreateLedgerDto = z.infer<typeof createLedgerSchema>;
