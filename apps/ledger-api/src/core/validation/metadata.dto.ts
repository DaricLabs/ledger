import { METADATA_LIMITS } from '@ledger/domain';
import { z } from 'zod';

/**
 * Shape of one metadata key at the HTTP edge: a key in a body and the `:key`
 * part of the delete URL. A key must not be empty, because an empty key has no
 * URL to delete it with.
 */
export const metadataKeySchema = z
  .string()
  .min(1, { error: 'Must not be empty' })
  .meta({
    description: `A metadata key: not empty, up to ${METADATA_LIMITS.maxKeyBytes} bytes in UTF-8.`,
    examples: ['orderId'],
  });

/**
 * Shape of a metadata object: non-empty keys and string values. Every body
 * that carries metadata uses it. The size limits are not checked here: they
 * are the rules of `Metadata` in `@ledger/domain`.
 *
 * A `__proto__` key is dropped by Zod without an error. That is safe (the
 * object is not polluted), so we accept it.
 */
export const metadataSchema = z.record(metadataKeySchema, z.string()).meta({
  description:
    'Key/value pairs of the caller. Every value is a string. ' +
    'Use ids, not personal data: the journal keeps what is written. ' +
    `Limits: up to ${METADATA_LIMITS.maxEntries} keys, ${METADATA_LIMITS.maxValueBytes} bytes for a value, ` +
    `${METADATA_LIMITS.maxTotalBytes} bytes for all keys and values together (UTF-8).`,
  examples: [{ orderId: '42' }],
});

/**
 * Body of a request that adds metadata entries (for example
 * `POST /ledgers/:name/metadata`): a plain object like `{ "env": "prod" }`.
 *
 * It needs at least one key, because an empty body is most likely a mistake of
 * the client. It does not change anything, so we say so.
 */
export const saveMetadataSchema = metadataSchema
  .refine((metadata) => Object.keys(metadata).length > 0, { error: 'Must have at least one key' })
  // `refine` is a function and cannot be written as JSON Schema, so the same rule is said here.
  .meta({ minProperties: 1 });

export type SaveMetadataDto = z.infer<typeof saveMetadataSchema>;
