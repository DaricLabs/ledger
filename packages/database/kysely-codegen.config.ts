import { defineConfig } from 'kysely-codegen';

export default defineConfig({
  dialect: 'postgres',
  url: process.env.LEDGER_RUNTIME_DATABASE_URL ?? 'env(LEDGER_RUNTIME_DATABASE_URL)',
  outFile: './src/generated/db.ts',
  typeMapping: { numeric: 'MoneyColumn' },
  customImports: { MoneyColumn: '../money-column.js#MoneyColumn' },
  overrides: {
    columns: {
      'idempotency_keys.method': `'POST' | 'PUT' | 'PATCH' | 'DELETE'`,
      'idempotency_keys.state': `Generated<'in_progress' | 'completed'>`,
    },
  },
});
