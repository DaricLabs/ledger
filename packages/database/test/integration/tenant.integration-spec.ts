import { sql, type Kysely } from 'kysely';
import { unwrapTenantTransaction, withTenant, type DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import { insertLedger } from '../support/fixtures.js';
import { uuidv7 } from '../support/uuidv7.js';

describe('withTenant', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb(3);
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function currentTenant(executor: Kysely<DB>): Promise<string | null> {
    const { rows } = await sql<{ id: string | null }>`
      select current_organization_id() as id
    `.execute(executor);
    return rows[0].id;
  }

  async function countLedgers(organizationId: string, ledgerId: string): Promise<number> {
    const rows = await inTenant(db, organizationId, (trx) =>
      trx.selectFrom('ledgers').select('id').where('id', '=', ledgerId).execute(),
    );
    return rows.length;
  }

  it('makes current_organization_id() return the given tenant inside the callback', async () => {
    const organizationId = uuidv7();

    const seen = await withTenant(db, organizationId, async (tenantTrx) => {
      const { rows } = await sql<{ id: string }>`
        select current_organization_id() as id
      `.execute(unwrapTenantTransaction(tenantTrx));
      return rows[0].id;
    });

    expect(seen).toBe(organizationId);
  });

  it('commits when the callback resolves, and returns its value', async () => {
    const organizationId = uuidv7();

    const ledger = await inTenant(db, organizationId, (trx) => insertLedger(trx, organizationId));

    expect(await countLedgers(organizationId, ledger.id)).toBe(1);
  });

  it('rolls back and rethrows the same error when the callback fails', async () => {
    const organizationId = uuidv7();
    const failure = new Error('something went wrong');
    const ledgerId = uuidv7();

    await expect(
      inTenant(db, organizationId, async (trx) => {
        await insertLedger(trx, organizationId, { id: ledgerId });
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await countLedgers(organizationId, ledgerId)).toBe(0);
  });

  it('rolls back everything when a statement fails half way', async () => {
    const organizationId = uuidv7();
    const ledgerId = uuidv7();

    await expect(
      inTenant(db, organizationId, async (trx) => {
        await insertLedger(trx, organizationId, { id: ledgerId });
        await insertLedger(trx, organizationId, { name: 'Invalid Name' }); // breaks ledger_name
      }),
    ).rejects.toMatchObject({ code: '23514' });

    expect(await countLedgers(organizationId, ledgerId)).toBe(0);
  });

  describe('tenant isolation on reused connections', () => {
    it('does not leave the tenant on the connection after commit', async () => {
      const single = createRuntimeDb(1); // one connection, so every query reuses it
      try {
        await withTenant(single, uuidv7(), async () => undefined);

        expect(await currentTenant(single)).toBeNull();
      } finally {
        await single.destroy();
      }
    });

    it('does not leave the tenant on the connection after rollback', async () => {
      const single = createRuntimeDb(1);
      try {
        await expect(
          withTenant(single, uuidv7(), async () => {
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');

        expect(await currentTenant(single)).toBeNull();
      } finally {
        await single.destroy();
      }
    });

    it('keeps tenants apart when many transactions run at the same time', async () => {
      const organizationIds = Array.from({ length: 12 }, () => uuidv7());

      const seen = await Promise.all(
        organizationIds.map((organizationId) =>
          withTenant(db, organizationId, async (tenantTrx) => {
            // Wait a little, so transactions overlap on the small pool.
            await sql`select pg_sleep(0.02)`.execute(unwrapTenantTransaction(tenantTrx));
            const { rows } = await sql<{ id: string }>`
              select current_organization_id() as id
            `.execute(unwrapTenantTransaction(tenantTrx));
            return rows[0].id;
          }),
        ),
      );

      expect(seen).toEqual(organizationIds);
    });
  });

  describe('access without a tenant', () => {
    it('does not allow writes: a plain query has no tenant, so RLS refuses it', async () => {
      const insert = db
        .insertInto('ledgers')
        .values({ id: uuidv7(), organization_id: uuidv7(), name: 'no-tenant' })
        .execute();

      await expect(insert).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('row-level security'),
      });
    });
  });
});
