import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createMigratorDb, createRuntimeDb, inTenant } from '../support/db.js';
import { seedTenant, type SeededTenant } from '../support/fixtures.js';

const APPEND_ONLY_TABLES = ['postings', 'ledger_logs', 'ledger_audit_anchors'] as const;

// About TRUNCATE: Postgres itself refuses a plain TRUNCATE on a table that other
// tables point to (error 0A000), before any trigger runs. TRUNCATE ... CASCADE
// gets past that check, so the CASCADE tests are the ones that need our triggers.

/** Thrown on purpose after the statement, so every attempt is rolled back. */
class RollbackAfterAttempt extends Error {}

describe('append-only protection', () => {
  let runtime: Kysely<DB>;
  let migrator: Kysely<DB>;
  let tenant: SeededTenant;

  beforeAll(async () => {
    runtime = createRuntimeDb(2);
    migrator = createMigratorDb(2);
    tenant = await seedTenant(runtime);
  });

  afterAll(async () => {
    await Promise.all([runtime.destroy(), migrator.destroy()]);
  });

  /**
   * Runs one statement and always rolls back. It resolves when the database
   * allowed the statement, and rejects with the database error when it refused.
   * Nothing is ever changed, so a missing guard cannot damage other tests.
   */
  async function attempt(
    db: Kysely<DB>,
    statement: (trx: Transaction<DB>) => Promise<unknown>,
  ): Promise<void> {
    try {
      await inTenant(db, tenant.organizationId, async (trx) => {
        await statement(trx);
        throw new RollbackAfterAttempt();
      });
    } catch (error) {
      if (!(error instanceof RollbackAfterAttempt)) throw error;
    }
  }

  // The owner (migrator) has every privilege, so only the triggers can stop it.
  describe('triggers stop even the table owner', () => {
    describe.each(APPEND_ONLY_TABLES)('%s', (table) => {
      const refused = { code: 'P0001', message: `${table} rows are append-only` };

      it('rejects UPDATE', async () => {
        await expect(
          attempt(migrator, (trx) =>
            sql`update ${sql.table(table)} set created_at = created_at`.execute(trx),
          ),
        ).rejects.toMatchObject(refused);
      });

      it('rejects DELETE', async () => {
        await expect(
          attempt(migrator, (trx) => sql`delete from ${sql.table(table)}`.execute(trx)),
        ).rejects.toMatchObject(refused);
      });

      it('rejects TRUNCATE', async () => {
        await expect(
          attempt(migrator, (trx) => sql`truncate ${sql.table(table)}`.execute(trx)),
        ).rejects.toThrow();
      });

      it('rejects TRUNCATE ... CASCADE', async () => {
        await expect(
          attempt(migrator, (trx) => sql`truncate ${sql.table(table)} cascade`.execute(trx)),
        ).rejects.toMatchObject(refused);
      });
    });

    describe('transactions (may change, may not be deleted)', () => {
      const refused = { code: 'P0001', message: 'transactions rows cannot be deleted' };

      it('allows UPDATE', async () => {
        await expect(
          attempt(migrator, (trx) =>
            sql`update transactions set metadata = '{"a":1}'`.execute(trx),
          ),
        ).resolves.toBeUndefined();
      });

      it('rejects DELETE', async () => {
        await expect(
          attempt(migrator, (trx) => sql`delete from transactions`.execute(trx)),
        ).rejects.toMatchObject(refused);
      });

      it('rejects TRUNCATE', async () => {
        await expect(
          attempt(migrator, (trx) => sql`truncate transactions`.execute(trx)),
        ).rejects.toThrow();
      });

      it('rejects TRUNCATE ... CASCADE', async () => {
        await expect(
          attempt(migrator, (trx) => sql`truncate transactions cascade`.execute(trx)),
        ).rejects.toMatchObject(refused);
      });
    });

    it('rejects TRUNCATE ledgers CASCADE, which would wipe every table below it', async () => {
      await expect(
        attempt(migrator, (trx) => sql`truncate ledgers cascade`.execute(trx)),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringMatching(/rows (are append-only|cannot be deleted)$/),
      });
    });
  });

  // The app role is stopped earlier, by missing privileges: a second lock.
  describe('privileges stop the app role', () => {
    describe.each(APPEND_ONLY_TABLES)('%s', (table) => {
      it.each([
        ['UPDATE', `update ${table} set created_at = created_at`],
        ['DELETE', `delete from ${table}`],
        ['TRUNCATE', `truncate ${table}`],
        ['TRUNCATE ... CASCADE', `truncate ${table} cascade`],
      ])('rejects %s', async (_command, statement) => {
        await expect(
          attempt(runtime, (trx) => sql.raw(statement).execute(trx)),
        ).rejects.toMatchObject({ code: '42501' });
      });
    });

    it.each([
      ['DELETE', 'delete from transactions'],
      ['TRUNCATE', 'truncate transactions'],
      ['TRUNCATE ... CASCADE', 'truncate transactions cascade'],
    ])('transactions: rejects %s', async (_command, statement) => {
      await expect(
        attempt(runtime, (trx) => sql.raw(statement).execute(trx)),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
