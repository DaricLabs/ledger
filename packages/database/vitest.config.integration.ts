import { defineConfig } from 'vitest/config';

// Integration tests: need the Postgres from compose.test.yaml. Run with `pnpm test:integration`.
// File suffix is `-spec` (not `.spec`), so the unit config can never pick these files up.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/integration/**/*.integration-spec.ts'],
    // Runs once before all files: applies migrations as `ledger_migrator`.
    globalSetup: ['./test/integration/global-setup.ts'],
    // Files share one database. Some tests take table locks (TRUNCATE checks),
    // so run files one after another to keep results stable.
    fileParallelism: false,
    isolate: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
