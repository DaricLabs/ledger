import { randomUUIDv7 } from 'node:crypto';

/**
 * Creates a UUIDv7 (RFC 9562): 48-bit millisecond timestamp, version 7,
 * RFC variant, and random bits for the rest.
 *
 * The schema's `uuidv7` domain only accepts this format.
 */
export function uuidv7(): string {
  return randomUUIDv7();
}
