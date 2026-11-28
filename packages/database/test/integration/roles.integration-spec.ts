import { sql, type Kysely } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createMigratorDb, createRelayDb, createRuntimeDb } from '../support/db.js';

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
  /** Table-level privileges the role must have. */
  table: Privilege[];
  /** Columns the role may UPDATE. */
  updatableColumns: string[];
}

const NO_ACCESS: ExpectedAccess = { table: [], updatableColumns: [] };
const READ_AND_ADD: Privilege[] = ['SELECT', 'INSERT'];

/**
 * The least-privilege access of `ledger_runtime`, written down on purpose.
 * A new table must be added here, so every new grant is a conscious decision.
 */
const EXPECTED_RUNTIME_ACCESS: Record<string, ExpectedAccess> = {
  ledgers: { table: READ_AND_ADD, updatableColumns: ['deleted_at', 'metadata'] },
  accounts: { table: READ_AND_ADD, updatableColumns: ['allow_overdraft', 'metadata'] },
  transactions: {
    table: READ_AND_ADD,
    updatableColumns: ['metadata', 'reverted_at', 'reverted_by_transaction_id'],
  },
  balances: { table: READ_AND_ADD, updatableColumns: ['allow_overdraft', 'balance'] },
  // Only adds events (the relay role records publish status). Reads stay for the app's tests.
  outbox_events: { table: READ_AND_ADD, updatableColumns: [] },
  // Append-only tables: read and add, never change.
  postings: { table: READ_AND_ADD, updatableColumns: [] },
  ledger_logs: { table: READ_AND_ADD, updatableColumns: [] },
  ledger_audit_anchors: { table: READ_AND_ADD, updatableColumns: [] },
  // An expired key is replaced by the next request, and the app deletes expired keys.
  idempotency_keys: {
    table: ['SELECT', 'INSERT', 'DELETE'],
    updatableColumns: ['created_at', 'expires_at', 'request_hash', 'transaction_id'],
  },
  // Migration bookkeeping belongs to the migrator only.
  kysely_migration: NO_ACCESS,
  kysely_migration_lock: NO_ACCESS,
};

/**
 * The access of `ledger_relay`: the outbox relay and nothing else. Every table
 * not listed has no access at all. The row rules are policies, tested in
 * `outbox.integration-spec.ts` and `row-level-security.integration-spec.ts`.
 */
const EXPECTED_RELAY_ACCESS: Record<string, ExpectedAccess> = {
  outbox_events: {
    table: ['SELECT', 'DELETE'],
    updatableColumns: ['last_error', 'next_attempt_at', 'publish_attempts', 'published_at'],
  },
};

describe('database roles and grants', () => {
  let runtime: Kysely<DB>;
  let migrator: Kysely<DB>;
  let relay: Kysely<DB>;

  beforeAll(() => {
    runtime = createRuntimeDb(2);
    migrator = createMigratorDb(2);
    relay = createRelayDb(2);
  });

  afterAll(async () => {
    await Promise.all([runtime.destroy(), migrator.destroy(), relay.destroy()]);
  });

  describe('bootstrap', () => {
    it('creates the three roles without superuser, BYPASSRLS, CREATEDB or CREATEROLE', async () => {
      const { rows } = await sql<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>`
        select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
        from pg_roles
        where rolname in ('ledger_migrator', 'ledger_relay', 'ledger_runtime')
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
          rolname: 'ledger_relay',
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

    it.each([
      ['runtime', () => runtime],
      ['relay', () => relay],
    ])('does not let the %s role create objects in the public schema', async (_name, getDb) => {
      await expect(
        sql`create table must_not_create (id int)`.execute(getDb()),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('lets the migrator create objects in the public schema', async () => {
      // Created in `public` on purpose (a temp table would not need CREATE on it),
      // then rolled back so the table list checked below stays clean.
      const rollback = new Error('rollback');

      await expect(
        migrator.transaction().execute(async (trx) => {
          await sql`create table public.migrator_can_create (id int)`.execute(trx);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });
  });

  it('has an expected-access entry for every table (add new tables to this test)', async () => {
    const { rows } = await sql<{ tablename: string }>`
      select tablename from pg_tables where schemaname = 'public' order by tablename
    `.execute(runtime);

    expect(rows.map((r) => r.tablename)).toEqual(Object.keys(EXPECTED_RUNTIME_ACCESS).sort());
  });

  describe.each([
    ['ledger_runtime', EXPECTED_RUNTIME_ACCESS],
    ['ledger_relay', EXPECTED_RELAY_ACCESS],
  ])('%s grants', (role, expectedAccess) => {
    /** What the role may do on `table`; a table missing from the map has no access. */
    const expectedFor = (table: string): ExpectedAccess => expectedAccess[table] ?? NO_ACCESS;

    it('has exactly the expected table privileges on every table', async () => {
      const { rows } = await sql<{ tablename: string; privilege: Privilege; granted: boolean }>`
        select t.tablename, p.privilege,
               has_table_privilege(${role}, format('public.%I', t.tablename), p.privilege) as granted
        from pg_tables t
        cross join unnest(${sql.val(ALL_PRIVILEGES)}::text[]) as p(privilege)
        where t.schemaname = 'public'
      `.execute(migrator);

      const tables = [...new Set(rows.map((r) => r.tablename))];
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        const granted = rows
          .filter((r) => r.tablename === table && r.granted)
          .map((r) => r.privilege)
          .sort();

        expect({ table, granted }).toEqual({
          table,
          granted: [...expectedFor(table).table].sort(),
        });
      }
    });

    it('can update exactly the expected columns on every table', async () => {
      const { rows } = await sql<{ table_name: string; column_name: string; can_update: boolean }>`
        select c.relname as table_name, a.attname as column_name,
               has_column_privilege(${role}, c.oid, a.attnum, 'UPDATE') as can_update
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      `.execute(migrator);

      const tables = [...new Set(rows.map((r) => r.table_name))];
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        const updatable = rows
          .filter((r) => r.table_name === table && r.can_update)
          .map((r) => r.column_name)
          .sort();

        expect({ table, updatable }).toEqual({
          table,
          updatable: [...expectedFor(table).updatableColumns].sort(),
        });
      }
    });
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
