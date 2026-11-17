/**
 * The header that carries the idempotency key, in lowercase (Express lowercases
 * all incoming header names). A client sends it to make a request safe to
 * repeat.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * The header that the response has, with the value `true`, when it is a
 * replay: the request was done before, nothing ran again, and the response
 * is the one of the first call.
 */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';
