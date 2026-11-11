/**
 * The `errorCode` values that `core/` itself returns. Clients switch on these
 * values, so they are part of the public API: add new ones freely, never
 * rename or remove.
 *
 * Domain codes (like `LEDGER_NOT_FOUND`) do not go here. A feature sets them
 * with the `errorCode` option of an `HttpException` (a NestJS v12 feature).
 */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL',
  'UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
