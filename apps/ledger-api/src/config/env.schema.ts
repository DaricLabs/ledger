import { z } from 'zod';

/**
 * Environment variables that `ledger-api` needs.
 *
 * ConfigModule checks them once at startup. If one is missing or wrong,
 * the app stops with a clear message instead of failing later on a request.
 */
export const envSchema = z.object({
  // Env values are always strings, so `coerce` turns "3000" into the number 3000.
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Must use the `ledger_runtime` role, not `ledger_migrator`:
  // row-level security only applies to the runtime role.
  LEDGER_RUNTIME_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

/** Validated shape of the environment, for `ConfigService<Env, true>`. */
export type Env = z.infer<typeof envSchema>;
