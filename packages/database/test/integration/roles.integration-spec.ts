import { sql, type Kysely } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createMigratorDb, createRuntimeDb } from '../support/db.js';

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER';
const ALL_PRIVILEGES: Privilege[] = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

interface ExpectedAccess {
  /** Table-level privileges `ledger_runtime` must have. */
  table: Privilege[];
  /** Columns `ledger_runtime` may UPDATE. `'all'` means every column. */
  updatableColumns: string[] | 'all';
}

const NO_ACCESS: ExpectedAccess = { table: [], updatableColumns: [] };
const READ_AND_ADD: Privilege[] = ['SELECT', 'INSERT'];

/**
 * The least-privilege access of `ledger_runtime`, written down on purpose.
 * A new table must be added here, so every new grant is a conscious decision.
 */
const EXPECTED_RUNTIME_ACCESS: Record<string, ExpectedAccess> = {
  ledgers: { table: READ_AND_ADD, updatableColumns: ['metadata'] },
  accounts: { table: READ_AND_ADD, updatableColumns: ['allow_overdraft', 'metadata'] },
  transactions: {
    table: READ_AND_ADD,
    updatableColumns: ['metadata', 'reverted_at', 'reverted_by_transaction_id'],
  },
  balances: { table: READ_AND_ADD, updatableColumns: ['allow_overdraft', 'balance'] },
  outbox_events: {
    table: READ_AND_ADD,
    updatableColumns: ['last_error', 'publish_attempts', 'published_at'],
  },
  // Append-only tables: read and add, never change.
  postings: { table: READ_AND_ADD, updatableColumns: [] },
  ledger_logs: { table: READ_AND_ADD, updatableColumns: [] },
  ledger_audit_anchors: { table: READ_AND_ADD, updatableColumns: [] },
  // Expired keys are cleaned up by the app.
  idempotency_keys: { table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], updatableColumns: 'all' },
  // Migration bookkeeping belongs to the migrator only.
  kysely_migration: NO_ACCESS,
  kysely_migration_lock: NO_ACCESS,
};

describe('database roles and grants', () => {
  let runtime: Kysely<DB>;
  let migrator: Kysely<DB>;

  beforeAll(() => {
    runtime = createRuntimeDb(2);
    migrator = createMigratorDb(2);
  });

  afterAll(async () => {
    await Promise.all([runtime.destroy(), migrator.destroy()]);
  });

  describe('bootstrap', () => {
    it('creates both roles without superuser, BYPASSRLS, CREATEDB or CREATEROLE', async () => {
      const { rows } = await sql<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>`
        select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
        from pg_roles
        where rolname in ('ledger_migrator', 'ledger_runtime')
        order by rolname
      `.execute(runtime);

      expect(rows).toEqual([
        {
          rolname: 'ledger_migrator',
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
        },
        {
          rolname: 'ledger_runtime',
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
        },
      ]);
    });

    it('lets the migrator own every table, so the runtime role is never the owner', async () => {
      const { rows } = await sql<{ tablename: string; tableowner: string }>`
        select tablename, tableowner from pg_tables where schemaname = 'public'
      `.execute(runtime);

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.tableowner !== 'ledger_migrator')).toEqual([]);
    });

    it('does not let the runtime role create objects in the public schema', async () => {
      await expect(
        sql`create table runtime_must_not_create (id int)`.execute(runtime),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('lets the migrator create objects in the public schema', async () => {
      await sql`create temp table migrator_can_create (id int)`.execute(migrator);
    });
  });

  describe('ledger_runtime grants', () => {
    it('has an expected-access entry for every table (add new tables to this test)', async () => {
      const { rows } = await sql<{ tablename: string }>`
        select tablename from pg_tables where schemaname = 'public' order by tablename
      `.execute(runtime);

      expect(rows.map((r) => r.tablename)).toEqual(Object.keys(EXPECTED_RUNTIME_ACCESS).sort());
    });

    it.each(Object.entries(EXPECTED_RUNTIME_ACCESS))(
      '%s: has exactly the expected table privileges',
      async (table, expected) => {
        const { rows } = await sql<{ privilege: Privilege; granted: boolean }>`
          select p.privilege, has_table_privilege('ledger_runtime', ${`public.${table}`}, p.privilege) as granted
          from unnest(${sql.val(ALL_PRIVILEGES)}::text[]) as p(privilege)
        `.execute(runtime);

        const granted = rows.filter((r) => r.granted).map((r) => r.privilege);

        expect(granted.sort()).toEqual([...expected.table].sort());
      },
    );

    it.each(Object.entries(EXPECTED_RUNTIME_ACCESS))(
      '%s: can update exactly the expected columns',
      async (table, expected) => {
        const { rows } = await sql<{ column_name: string; can_update: boolean }>`
          select a.attname as column_name,
                 has_column_privilege('ledger_runtime', c.oid, a.attnum, 'UPDATE') as can_update
          from pg_class c
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          where c.relnamespace = 'public'::regnamespace and c.relname = ${table}
        `.execute(runtime);

        const updatable = rows.filter((r) => r.can_update).map((r) => r.column_name);
        const want =
          expected.updatableColumns === 'all'
            ? rows.map((r) => r.column_name)
            : expected.updatableColumns;

        expect(rows.length).toBeGreaterThan(0);
        expect(updatable.sort()).toEqual([...want].sort());
      },
    );
  });

  describe('SECURITY DEFINER functions', () => {
    it('only ledger_logs_assign_seq runs with its owner rights, with a fixed search_path', async () => {
      const { rows } = await sql<{ proname: string; proconfig: string[] | null }>`
        select proname, proconfig
        from pg_proc
        where pronamespace = 'public'::regnamespace and prosecdef
      `.execute(runtime);

      expect(rows).toEqual([
        { proname: 'ledger_logs_assign_seq', proconfig: ['search_path=pg_catalog, pg_temp'] },
      ]);
    });
  });
});
