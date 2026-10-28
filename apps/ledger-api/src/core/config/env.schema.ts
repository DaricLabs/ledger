import { z } from 'zod';
import { LOG_LEVELS } from '../logging/log-levels.js';

// The only role the API may use. `ledger_migrator` owns the tables and
// skips row-level security, so using it would silently turn tenant isolation off.
const RUNTIME_ROLE = 'ledger_runtime';

/**
 * Environment variables that ledger-api needs.
 *
 * ConfigModule checks them once at startup. If one is missing or wrong,
 * the app stops with a clear message instead of failing later on a request.
 */
export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Fast check on the role name in the URL. It catches the likely mistake of
  // using the migrator URL. The message must never contain the URL (it has the password).
  LEDGER_RUNTIME_DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .refine((value) => !URL.canParse(value) || new URL(value).username === RUNTIME_ROLE, {
      error: `must connect as the ${RUNTIME_ROLE} role`,
    }),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** Validated shape of the environment, for `ConfigService<Env, true>`. */
export type Env = z.infer<typeof envSchema>;
