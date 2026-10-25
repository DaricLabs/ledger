import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // The test database must be running (compose.test.yaml, port 5433).
    // CI sets the URL in ci.yml; locally the default below is used.
    env: {
      LEDGER_RUNTIME_DATABASE_URL:
        process.env.LEDGER_RUNTIME_DATABASE_URL ??
        'postgres://ledger_runtime:password@localhost:5433/ledger',
    },
  },
});
