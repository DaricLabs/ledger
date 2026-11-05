import { z } from 'zod';
import { ledgerMetadataSchema } from './ledger-metadata.dto.js';
import { ledgerNameSchema } from './ledger-name.dto.js';

/**
 * Body of `POST /ledgers`.
 *
 * This checks the shape only, so clients get one `VALIDATION` error with a
 * detail per bad field. The rules that need domain knowledge (reserved names)
 * stay in `Ledger.create` and come back as domain errors.
 *
 * Unknown fields are rejected on purpose. A typo like `metdata` would
 * otherwise be dropped without a word, and the client would think its
 * metadata was saved.
 */
export const createLedgerSchema = z.strictObject({
  name: ledgerNameSchema,
  metadata: ledgerMetadataSchema.default({}),
});

export type CreateLedgerDto = z.infer<typeof createLedgerSchema>;
