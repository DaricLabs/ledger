import { Kysely, sql } from 'kysely';
import { migrateToLatest } from '../../src/migrator.js';
import { testDatabaseUrls } from '../support/config.js';
import { createDb } from '../support/db.js';

const HELP = `
Could not prepare the test database. The integration tests need the Postgres
from compose.test.yaml, with the roles created. From the repo root, run:

  podman compose -f compose.test.yaml up -d postgres
  podman compose -f compose.test.yaml --profile setup run --rm --no-deps bootstrap

(Use "docker compose" instead of "podman compose" if you use Docker.)

To use another database, set TEST_LEDGER_MIGRATOR_DATABASE_URL and
TEST_LEDGER_RUNTIME_DATABASE_URL. Use a throwaway database: tests add data
and never clean it up.
`;

/** Runs once before all integration test files. */
export async function setup(): Promise<void> {
  const migrator = createDb<unknown>(testDatabaseUrls.migrator, 1);
  const runtime = createDb<unknown>(testDatabaseUrls.runtime, 1);

  try {
    // Fail early (and clearly) if a role or the server is missing.
    await sql`select 1`.execute(runtime as Kysely<unknown>);
    await migrateToLatest(migrator);
  } catch (error) {
    throw new Error(HELP, { cause: error });
  } finally {
    await Promise.all([migrator.destroy(), runtime.destroy()]);
  }
}
