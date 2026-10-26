import { defineConfig } from 'vitest/config';

// Integration tests: need the Postgres from compose.test.yaml (port 5433), already migrated.
// Run with `pnpm test:integration`. The `-spec` suffix keeps the unit config from picking these up.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.integration-spec.ts'],
    env: {
      // TEST_ name on purpose: LEDGER_* points at the dev database, tests must never use it.
      LEDGER_RUNTIME_DATABASE_URL:
        process.env.TEST_LEDGER_RUNTIME_DATABASE_URL ??
        'postgres://ledger_runtime:password@127.0.0.1:5433/ledger',
    },
  },
});
