import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import { Pool } from 'pg';
import { unwrapTenantTransaction, withTenant, type DB } from '../../src/storage.js';
import { testDatabaseUrls } from './config.js';

export function createDb<T = DB>(connectionString: string, maxConnections = 5): Kysely<T> {
  return new Kysely<T>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: maxConnections, connectionTimeoutMillis: 10_000 }),
    }),
  });
}

/** Connects as `ledger_runtime`, the role the apps use. RLS and grants apply. */
export function createRuntimeDb(maxConnections?: number): Kysely<DB> {
  return createDb(testDatabaseUrls.runtime, maxConnections);
}

/** Connects as `ledger_migrator`, the table owner. It bypasses RLS and has all privileges. */
export function createMigratorDb(maxConnections?: number): Kysely<DB> {
  return createDb(testDatabaseUrls.migrator, maxConnections);
}

/**
 * Like `withTenant`, but hands the callback the real Kysely transaction.
 * Saves an `unwrapTenantTransaction` call in every test.
 */
export function inTenant<T>(
  db: Kysely<DB>,
  organizationId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return withTenant(db, organizationId, (tenantTrx) => fn(unwrapTenantTransaction(tenantTrx)));
}
