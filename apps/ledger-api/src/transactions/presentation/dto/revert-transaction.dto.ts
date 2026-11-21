import { z } from 'zod';
import { metadataSchema } from '../../../core/validation/metadata.dto.js';

/**
 * Body of `POST /ledgers/:ledgerName/transactions/:transactionId/revert`.
 *
 * The body is optional: a request with no body, or with `{}`, reverts with no
 * metadata. `prefault` gives the missing body to the schema as `{}`, so the
 * defaults below still apply.
 *
 * The metadata is for the NEW transaction (a `reason`, for example). The size
 * limits are not checked here: they are the rules of `Metadata` in
 * `@ledger/domain`.
 *
 * Unknown fields are rejected on purpose, like on create. A typo like
 * `metdata` would otherwise be dropped without a word.
 */
export const revertTransactionSchema = z
  .strictObject({
    metadata: metadataSchema.default({}),
  })
  .prefault({});

export type RevertTransactionDto = z.infer<typeof revertTransactionSchema>;
