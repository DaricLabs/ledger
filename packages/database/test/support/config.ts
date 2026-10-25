/**
 * Connection strings for the integration tests.
 *
 * Defaults match `compose.test.yaml` (port 5433, default passwords). The env
 * variable names start with `TEST_` on purpose: the normal `LEDGER_*` names
 * point at the dev database (`.env`), and tests must never run against it.
 * `superuser` is only used to check that the app refuses superuser roles.
 */
export const testDatabaseUrls = {
  migrator:
    process.env.TEST_LEDGER_MIGRATOR_DATABASE_URL ??
    'postgres://ledger_migrator:password@127.0.0.1:5433/ledger',
  runtime:
    process.env.TEST_LEDGER_RUNTIME_DATABASE_URL ??
    'postgres://ledger_runtime:password@127.0.0.1:5433/ledger',
  superuser:
    process.env.TEST_LEDGER_SUPERUSER_DATABASE_URL ??
    'postgres://postgres:postgres@127.0.0.1:5433/ledger',
} as const;
