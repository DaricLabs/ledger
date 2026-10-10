import { join } from 'node:path';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { SqlFileMigrationProvider } from './migration-provider.js';

/**
 * Executes all pending database migrations to the latest version.
 *
 * Reads `.sql` files from the `../migrations` directory relative to this file.
 * Logs the status of each migration to the console and throws an error if the process fails.
 *
 * @param db - The Kysely database instance to run migrations against.
 * @throws Will throw an error if any migration fails.
 */
export async function migrateToLatest(db: Kysely<unknown>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(join(import.meta.dirname, '../migrations')),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((r) => console.log(`${r.status}: ${r.migrationName}`));

  if (error) {
    throw error;
  }
}
