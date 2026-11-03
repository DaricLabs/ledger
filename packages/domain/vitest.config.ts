import { defineConfig } from 'vitest/config';

// Unit tests: pure code, no database, no network. Run with `pnpm test`.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
