import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from './migrator.js';

/**
 * Connects to the database and runs the migration process.
 *
 * @throws {Error} If the `LEDGER_MIGRATOR_DATABASE_URL` environment variable is not set.
 * @returns {Promise<void>} Resolves when migrations are applied and the database connection is closed.
 */
async function main() {
  const url = process.env.LEDGER_MIGRATOR_DATABASE_URL;
  if (!url) throw new Error('LEDGER_MIGRATOR_DATABASE_URL is required');

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 }),
    }),
  });

  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1); // fail CI/deploy
});
