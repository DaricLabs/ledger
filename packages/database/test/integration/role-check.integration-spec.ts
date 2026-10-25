import { createDb } from '../../src/connection.js';
import { assertSafeRuntimeRole } from '../../src/role-check.js';

// Same defaults as compose.test.yaml (port 5433).
const runtimeUrl =
  process.env.LEDGER_RUNTIME_DATABASE_URL ??
  'postgres://ledger_runtime:password@127.0.0.1:5433/ledger';
const superuserUrl = 'postgres://postgres:postgres@127.0.0.1:5433/ledger';

/** Runs `fn` with a short-lived client and always closes its pool. */
async function withDb(url: string, fn: (db: ReturnType<typeof createDb>) => Promise<void>) {
  const db = createDb(url, { maxConnections: 1, onPoolError: () => undefined });
  try {
    await fn(db);
  } finally {
    await db.destroy();
  }
}

describe('assertSafeRuntimeRole', () => {
  it('accepts the ledger_runtime role', async () => {
    await withDb(runtimeUrl, async (db) => {
      await expect(assertSafeRuntimeRole(db)).resolves.toBeUndefined();
    });
  });

  it('rejects a superuser', async () => {
    await withDb(superuserUrl, async (db) => {
      await expect(assertSafeRuntimeRole(db)).rejects.toThrow(
        'Database role "postgres" must not be a superuser',
      );
    });
  });
});
