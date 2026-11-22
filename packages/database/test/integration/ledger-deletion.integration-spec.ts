import { randomUUIDv7 } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import { insertLedger, insertLog } from '../support/fixtures.js';

describe('ledger deletion', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb(5);
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function newLedger(): Promise<{ org: string; id: string; name: string }> {
    const org = randomUUIDv7();
    const ledger = await inTenant(db, org, (trx) => insertLedger(trx, org));
    return { org, ...ledger };
  }

  async function deleteLedger(org: string, id: string, at = new Date()): Promise<void> {
    await inTenant(db, org, (trx) =>
      trx.updateTable('ledgers').set({ deleted_at: at }).where('id', '=', id).execute(),
    );
  }

  async function readRow(org: string, id: string) {
    return inTenant(db, org, (trx) =>
      trx
        .selectFrom('ledgers')
        .select(['deleted_at', 'metadata', 'last_log_seq'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
  }

  it('starts live: a new ledger has no deleted_at', async () => {
    const { org, id } = await newLedger();

    expect((await readRow(org, id)).deleted_at).toBeNull();
  });

  it('lets the app set deleted_at on a live ledger', async () => {
    const { org, id } = await newLedger();
    const at = new Date('2026-11-22T10:00:00.000Z');

    await deleteLedger(org, id, at);

    expect((await readRow(org, id)).deleted_at).toEqual(at);
  });

  it('lets the deleting transaction write its log first and delete the ledger after it', async () => {
    const { org, id } = await newLedger();

    const seq = await inTenant(db, org, async (trx) => {
      const logSeq = await insertLog(trx, org, id, { type: 'LEDGER_DELETED' });
      await trx
        .updateTable('ledgers')
        .set({ deleted_at: new Date() })
        .where('id', '=', id)
        .execute();
      return logSeq;
    });

    expect(seq).toBe(1);
    const row = await readRow(org, id);
    expect(row.deleted_at).not.toBeNull();
    expect(Number(row.last_log_seq)).toBe(1);
  });

  describe('after the delete', () => {
    it('refuses to clear deleted_at, so a deleted ledger cannot come back', async () => {
      const { org, id } = await newLedger();
      await deleteLedger(org, id);

      await expect(
        inTenant(db, org, (trx) =>
          trx.updateTable('ledgers').set({ deleted_at: null }).where('id', '=', id).execute(),
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('is deleted and cannot be changed'),
      });
      expect((await readRow(org, id)).deleted_at).not.toBeNull();
    });

    it('refuses to move deleted_at to another time', async () => {
      const { org, id } = await newLedger();
      const first = new Date('2026-11-22T10:00:00.000Z');
      await deleteLedger(org, id, first);

      await expect(
        deleteLedger(org, id, new Date('2026-11-23T10:00:00.000Z')),
      ).rejects.toMatchObject({ code: 'P0001' });
      expect((await readRow(org, id)).deleted_at).toEqual(first);
    });

    it('refuses to change the metadata of a deleted ledger', async () => {
      const { org, id } = await newLedger();
      await deleteLedger(org, id);

      await expect(
        inTenant(db, org, (trx) =>
          trx
            .updateTable('ledgers')
            .set({ metadata: { env: 'prod' } })
            .where('id', '=', id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      expect((await readRow(org, id)).metadata).toEqual({});
    });

    it('keeps the name taken, so the organization cannot create it again', async () => {
      const { org, id, name } = await newLedger();
      await deleteLedger(org, id);

      await expect(
        inTenant(db, org, (trx) => insertLedger(trx, org, { name })),
      ).rejects.toMatchObject({ code: '23505', constraint: 'ledgers_organization_id_name_key' });
    });

    it('still lets another organization use the same name', async () => {
      const { org, id, name } = await newLedger();
      await deleteLedger(org, id);
      const otherOrg = randomUUIDv7();

      await expect(
        inTenant(db, otherOrg, (trx) => insertLedger(trx, otherOrg, { name })),
      ).resolves.toMatchObject({ name });
    });

    it('keeps the logs that were written before the delete', async () => {
      const { org, id } = await newLedger();
      await inTenant(db, org, (trx) => insertLog(trx, org, id));
      await deleteLedger(org, id);

      const logs = await inTenant(db, org, (trx) =>
        trx.selectFrom('ledger_logs').select('seq').where('ledger_id', '=', id).execute(),
      );

      expect(logs.map((log) => Number(log.seq))).toEqual([1]);
    });
  });

  it('does not delete the ledger of another organization', async () => {
    const mine = await newLedger();
    const theirs = await newLedger();

    // Row-level security hides their row, so the update changes 0 rows and no error is raised.
    const result = await inTenant(db, mine.org, (trx) =>
      trx
        .updateTable('ledgers')
        .set({ deleted_at: new Date() })
        .where('id', '=', theirs.id)
        .executeTakeFirstOrThrow(),
    );

    expect(result.numUpdatedRows).toBe(0n);
    expect((await readRow(theirs.org, theirs.id)).deleted_at).toBeNull();
  });

  it('does not let the app remove a ledger row', async () => {
    const { org, id } = await newLedger();

    await expect(
      inTenant(db, org, (trx) => trx.deleteFrom('ledgers').where('id', '=', id).execute()),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
