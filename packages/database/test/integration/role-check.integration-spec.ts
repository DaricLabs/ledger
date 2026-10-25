import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
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
        /Database role "ledger_migrator" is, or can become, the owner of table .* not forced/,
      );
    });
  });

  // A role that has no owner rights by itself (NOINHERIT), but can SET ROLE to the owner.
  // This is the case 'USAGE' missed and 'MEMBER' catches.
  describe('a role that can only SET ROLE to the table owner', () => {
    const role = `tmp_setrole_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    const roleUrl = new URL(testDatabaseUrls.runtime); // same host, port and database as runtime
    roleUrl.username = role;
    roleUrl.password = password;

    beforeAll(async () => {
      await withDb(testDatabaseUrls.superuser, async (db) => {
        // CREATE ROLE cannot take bound parameters, so the password is written as a literal.
        // It is random hex, so it is safe.
        await sql`create role ${sql.id(role)} login noinherit password ${sql.lit(password)}`.execute(
          db,
        );
        await sql`grant ledger_migrator to ${sql.id(role)}`.execute(db);
      });
    });

    afterAll(async () => {
      // Dropping the role also removes its membership in ledger_migrator
      await withDb(testDatabaseUrls.superuser, async (db) => {
        await sql`drop role if exists ${sql.id(role)}`.execute(db);
      });
    });

    // Without this, the next test could pass for the wrong reason if the setup broke.
    it('has no inherited owner rights, but is a member of the owner role', async () => {
      await withDb(roleUrl.toString(), async (db) => {
        const { rows } = await sql<{ usage: boolean; member: boolean }>`
          select pg_has_role(current_user, 'ledger_migrator', 'USAGE') as usage,
                 pg_has_role(current_user, 'ledger_migrator', 'MEMBER') as member
        `.execute(db);

        expect(rows[0]).toEqual({ usage: false, member: true });
      });
    });

    it('is rejected', async () => {
      await withDb(roleUrl.toString(), async (db) => {
        await expect(assertSafeRuntimeRole(db)).rejects.toThrow(
          new RegExp(`Database role "${role}" is, or can become, the owner of table .* not forced`),
        );
      });
    });
  });
});
