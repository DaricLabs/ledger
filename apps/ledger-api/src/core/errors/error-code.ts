/**
 * Every `errorCode` the API can return. Clients switch on these values, so
 * they are part of the public API: add new ones freely, never rename or remove.
 *
 * Domain codes (like `LEDGER_NOT_FOUND`) are added by the features that need them.
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
