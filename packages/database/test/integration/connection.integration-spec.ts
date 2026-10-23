import { sql } from 'kysely';
import {
  createDb,
  unwrapTenantTransaction,
  withTenant,
  type LedgerDatabase,
} from '../../src/storage.js';
import { testDatabaseUrls } from '../support/config.js';
import { inTenant } from '../support/db.js';
import { insertLedger } from '../support/fixtures.js';
import { uuidv7 } from '../support/uuidv7.js';

describe('createDb', () => {
  let db: LedgerDatabase;

  beforeAll(() => {
    db = createDb(testDatabaseUrls.runtime, { maxConnections: 2, onPoolError: () => undefined });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('connects with the URL it is given (here: as ledger_runtime)', async () => {
    const { rows } = await sql<{ name: string }>`select current_user as name`.execute(db);

    expect(rows[0].name).toBe('ledger_runtime');
  });

  it('gives a client that works with withTenant, so row-level security applies', async () => {
    const organizationId = uuidv7();
    const otherOrganizationId = uuidv7();
    const ledger = await inTenant(db, organizationId, (trx) => insertLedger(trx, organizationId));

    const seenByOwner = await withTenant(db, organizationId, (tenantTrx) =>
      unwrapTenantTransaction(tenantTrx)
        .selectFrom('ledgers')
        .select('id')
        .where('id', '=', ledger.id)
        .execute(),
    );
    const seenByOther = await withTenant(db, otherOrganizationId, (tenantTrx) =>
      unwrapTenantTransaction(tenantTrx)
        .selectFrom('ledgers')
        .select('id')
        .where('id', '=', ledger.id)
        .execute(),
    );

    expect(seenByOwner).toHaveLength(1);
    expect(seenByOther).toHaveLength(0);
  });

  it('queues work when all connections are busy, instead of failing', async () => {
    const single = createDb(testDatabaseUrls.runtime, {
      maxConnections: 1,
      onPoolError: () => undefined,
    });
    try {
      const results = await Promise.all(
        [1, 2, 3].map((n) =>
          withTenant(single, uuidv7(), async (tenantTrx) => {
            await sql`select pg_sleep(0.02)`.execute(unwrapTenantTransaction(tenantTrx));
            return n;
          }),
        ),
      );

      expect(results).toEqual([1, 2, 3]);
    } finally {
      await single.destroy();
    }
  });

  it('refuses new queries after destroy()', async () => {
    const short = createDb(testDatabaseUrls.runtime, {
      maxConnections: 1,
      onPoolError: () => undefined,
    });
    await sql`select 1`.execute(short);

    await short.destroy();

    await expect(sql`select 1`.execute(short)).rejects.toThrow();
  });
});
