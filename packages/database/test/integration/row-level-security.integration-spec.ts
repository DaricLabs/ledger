import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import {
  insertAccount,
  insertAnchor,
  insertIdempotencyKey,
  insertLedger,
  insertLog,
  insertOutboxEvent,
  insertPosting,
  insertTransaction,
  seedTenant,
  type SeededTenant,
} from '../support/fixtures.js';

const TENANT_TABLES = [
  'ledgers',
  'accounts',
  'transactions',
  'postings',
  'balances',
  'ledger_logs',
  'ledger_audit_anchors',
  'outbox_events',
  'idempotency_keys',
] as const;

describe('row-level security', () => {
  let db: Kysely<DB>;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    db = createRuntimeDb();
    tenantA = await seedTenant(db);
    tenantB = await seedTenant(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function organizationIdsSeen(organizationId: string, table: string): Promise<string[]> {
    return inTenant(db, organizationId, async (trx) => {
      const { rows } = await sql<{ organization_id: string }>`
        select organization_id from ${sql.table(table)}
      `.execute(trx);
      return rows.map((r) => r.organization_id);
    });
  }

  describe('policies', () => {
    it('covers exactly the tenant tables, which are all the tables with organization_id', async () => {
      const { rows } = await sql<{ table_name: string }>`
        select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'organization_id'
        order by table_name
      `.execute(db);

      expect(rows.map((r) => r.table_name)).toEqual([...TENANT_TABLES].sort());
    });

    it.each(TENANT_TABLES)('%s: RLS is on, with one policy for all commands', async (table) => {
      const { rows: tables } = await sql<{ relrowsecurity: boolean }>`
        select relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname = ${table}
      `.execute(db);
      const { rows: policies } = await sql<{
        policyname: string;
        cmd: string;
        qual: string;
        with_check: string;
      }>`
        select policyname, cmd, qual, with_check from pg_policies
        where schemaname = 'public' and tablename = ${table}
      `.execute(db);

      expect(tables).toEqual([{ relrowsecurity: true }]);
      expect(policies).toHaveLength(1);
      expect(policies[0].policyname).toBe(`${table}_tenant_isolation`);
      expect(policies[0].cmd).toBe('ALL');
      expect(policies[0].qual).toContain('current_organization_id()');
      expect(policies[0].with_check).toContain('current_organization_id()');
    });
  });

  describe('reading', () => {
    it.each(TENANT_TABLES)('%s: a tenant sees only its own rows', async (table) => {
      const seenByA = await organizationIdsSeen(tenantA.organizationId, table);
      const seenByB = await organizationIdsSeen(tenantB.organizationId, table);

      expect(seenByA.length).toBeGreaterThan(0);
      expect(new Set(seenByA)).toEqual(new Set([tenantA.organizationId]));
      expect(seenByB.length).toBeGreaterThan(0);
      expect(new Set(seenByB)).toEqual(new Set([tenantB.organizationId]));
    });

    it.each(TENANT_TABLES)('%s: no tenant set means no rows (fails closed)', async (table) => {
      // Plain query on the pool: no withTenant, so no tenant is set.
      const { rows } = await sql<{ count: string }>`
        select count(*) from ${sql.table(table)}
      `.execute(db);

      expect(rows[0].count).toBe('0');
    });

    it('treats an empty tenant id like no tenant', async () => {
      const seen = await organizationIdsSeen('', 'ledgers');

      expect(seen).toEqual([]);
    });

    it('rejects a tenant id that is not a UUID as soon as a tenant table is read', async () => {
      await expect(organizationIdsSeen('not-a-uuid', 'ledgers')).rejects.toMatchObject({
        code: '22P02',
      });
    });
  });

  describe('writing', () => {
    // Every insert targets tenant B's data while tenant A's context is set.
    const insertsForTenantB: Record<
      (typeof TENANT_TABLES)[number],
      (trx: Transaction<DB>, b: SeededTenant) => Promise<unknown>
    > = {
      ledgers: (trx, b) => insertLedger(trx, b.organizationId),
      accounts: (trx, b) => insertAccount(trx, b.organizationId, b.ledgerId, 'extra'),
      transactions: (trx, b) => insertTransaction(trx, b.organizationId, b.ledgerId),
      postings: (trx, b) =>
        insertPosting(trx, b.organizationId, b.ledgerId, b.transactionId, { seq: 2 }),
      balances: (trx, b) =>
        trx
          .insertInto('balances')
          .values({
            organization_id: b.organizationId,
            ledger_id: b.ledgerId,
            account_address: 'world',
            asset: 'EUR',
          })
          .execute(),
      ledger_logs: (trx, b) => insertLog(trx, b.organizationId, b.ledgerId),
      ledger_audit_anchors: (trx, b) =>
        insertAnchor(trx, b.organizationId, b.ledgerId, { from: 1, to: 1 }),
      outbox_events: (trx, b) => insertOutboxEvent(trx, b.organizationId, b.ledgerId),
      idempotency_keys: (trx, b) => insertIdempotencyKey(trx, b.organizationId, b.ledgerId),
    };

    it.each(TENANT_TABLES.filter((t) => t !== 'balances'))(
      '%s: a tenant cannot insert a row for another tenant',
      async (table) => {
        await expect(
          inTenant(db, tenantA.organizationId, (trx) => insertsForTenantB[table](trx, tenantB)),
        ).rejects.toMatchObject({
          code: '42501',
          message: expect.stringContaining('row-level security'),
        });
      },
    );

    it('balances: a tenant cannot insert a row for another tenant', async () => {
      // The BEFORE INSERT trigger runs first and cannot see the other
      // tenant's account (RLS), so it fails before the policy check.
      await expect(
        inTenant(db, tenantA.organizationId, (trx) => insertsForTenantB.balances(trx, tenantB)),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('account not found'),
      });
    });

    it("does not update another tenant's rows", async () => {
      const result = await inTenant(db, tenantA.organizationId, (trx) =>
        trx
          .updateTable('ledgers')
          .set({ metadata: { hacked: true } })
          .where('id', '=', tenantB.ledgerId)
          .executeTakeFirstOrThrow(),
      );

      const metadata = await inTenant(db, tenantB.organizationId, (trx) =>
        trx
          .selectFrom('ledgers')
          .select('metadata')
          .where('id', '=', tenantB.ledgerId)
          .executeTakeFirstOrThrow(),
      );
      expect(result.numUpdatedRows).toBe(0n);
      expect(metadata.metadata).toEqual({});
    });

    it("does not delete another tenant's rows", async () => {
      const result = await inTenant(db, tenantA.organizationId, (trx) =>
        trx
          .deleteFrom('idempotency_keys')
          .where('ledger_id', '=', tenantB.ledgerId)
          .executeTakeFirstOrThrow(),
      );

      const remaining = await organizationIdsSeen(tenantB.organizationId, 'idempotency_keys');
      expect(result.numDeletedRows).toBe(0n);
      expect(remaining.length).toBe(1);
    });
  });
});
