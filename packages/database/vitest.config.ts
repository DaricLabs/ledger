import { defineConfig } from 'vitest/config';

// Unit tests: no database, no network. Run with `pnpm test`.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.spec.ts'],
  },
});
