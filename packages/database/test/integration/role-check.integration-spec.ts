import { assertSafeRuntimeRole, createDb, type LedgerDatabase } from '../../src/storage.js';
import { testDatabaseUrls } from '../support/config.js';

/** Runs `fn` with a short-lived client and always closes its pool. */
async function withDb(url: string, fn: (db: LedgerDatabase) => Promise<void>) {
  const db = createDb(url, { maxConnections: 1, onPoolError: () => undefined });
  try {
    await fn(db);
  } finally {
    await db.destroy();
  }
}

describe('assertSafeRuntimeRole', () => {
  it('accepts the ledger_runtime role', async () => {
    await withDb(testDatabaseUrls.runtime, async (db) => {
      await expect(assertSafeRuntimeRole(db)).resolves.toBeUndefined();
    });
  });

  it('rejects a superuser', async () => {
    await withDb(testDatabaseUrls.superuser, async (db) => {
      await expect(assertSafeRuntimeRole(db)).rejects.toThrow(
        'Database role "postgres" must not be a superuser',
      );
    });
  });

  // The migrator owns the tenant tables, and RLS is enabled but not forced on them,
  // so it skips the policies even though it has no superuser or BYPASSRLS flag.
  it('rejects a role that owns a table with RLS enabled but not forced', async () => {
    await withDb(testDatabaseUrls.migrator, async (db) => {
      await expect(assertSafeRuntimeRole(db)).rejects.toThrow(
        /Database role "ledger_migrator" owns table .* not forced/,
      );
    });
  });
});
