import { defineConfig } from 'vitest/config';

// Integration tests: need the Postgres from compose.test.yaml (port 5433), already migrated.
// Run with `pnpm test:integration`. The `-spec` suffix keeps the unit config from picking these up.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.integration-spec.ts'],
    env: {
      LEDGER_RUNTIME_DATABASE_URL:
        process.env.LEDGER_RUNTIME_DATABASE_URL ??
        'postgres://ledger_runtime:password@localhost:5433/ledger',
    },
  },
});
