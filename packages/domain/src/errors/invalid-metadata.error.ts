import { ValueObjectError } from './value-object.error.js';

/**
 * Metadata breaks the rules: it is not an object, a key is empty, or a value
 * is not a string.
 *
 * The message may name the bad key, but never contains a metadata value,
 * because values are free-form and may hold secrets.
 */
export class InvalidMetadataError extends ValueObjectError {
  readonly code = 'INVALID_METADATA';
}
