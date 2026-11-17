/**
 * What an idempotency key looks like: 1 to 255 printable ASCII characters
 * (from space to `~`). The database checks the same rule
 * (`idempotency_keys_key_valid`), so change both together.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[ -~]{1,255}$/;

/** How long a key is remembered. After this time the same key starts a new request. */
export const IDEMPOTENCY_KEY_TTL_SECONDS = 24 * 60 * 60;
