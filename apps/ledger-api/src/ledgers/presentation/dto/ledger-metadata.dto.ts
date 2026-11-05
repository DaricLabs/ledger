import { z } from 'zod';

/**
 * Shape of one metadata key at the HTTP edge: a key in a body and the `:key`
 * part of the delete URL. A key must not be empty, because an empty key has no
 * URL to delete it with.
 */
export const ledgerMetadataKeySchema = z.string().min(1, { error: 'Must not be empty' });

/**
 * Shape of a metadata object: non-empty keys and string values. It is used by
 * the create body and the save body.
 *
 * A `__proto__` key is dropped by Zod without an error. That is safe (the
 * object is not polluted), so we accept it.
 */
export const ledgerMetadataSchema = z.record(ledgerMetadataKeySchema, z.string());

/**
 * Body of `POST /ledgers/:name/metadata`: the entries to add, as a plain
 * object like `{ "env": "prod" }`.
 *
 * It needs at least one key, because an empty body is most likely a mistake of
 * the client. It does not change anything, so we say so.
 */
export const saveLedgerMetadataSchema = ledgerMetadataSchema.refine(
  (metadata) => Object.keys(metadata).length > 0,
  { error: 'Must have at least one key' },
);

export type SaveLedgerMetadataDto = z.infer<typeof saveLedgerMetadataSchema>;
