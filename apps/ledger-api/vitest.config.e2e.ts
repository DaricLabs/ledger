import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // AppModule checks the environment when it loads. /health never opens a
    // connection, so a fake URL is enough here.
    // Use the real URL if the environment has one (CI sets it, port 5433).
    env: {
      LEDGER_RUNTIME_DATABASE_URL:
        process.env.LEDGER_RUNTIME_DATABASE_URL ??
        'postgres://ledger_runtime:password@localhost:5433/ledger',
    },
  },
});
