import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // The test database must be running (compose.test.yaml, port 5433).
    // CI sets the URL in ci.yml; locally the default below is used.
    // The TEST_ name is on purpose: LEDGER_* points at the dev database.
    env: {
      LEDGER_RUNTIME_DATABASE_URL:
        process.env.TEST_LEDGER_RUNTIME_DATABASE_URL ??
        'postgres://ledger_runtime:password@127.0.0.1:5433/ledger',
    },
  },
});
