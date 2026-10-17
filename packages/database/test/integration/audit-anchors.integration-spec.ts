import type { Kysely } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import { insertAnchor, insertLedger, insertLog, sha256Like } from '../support/fixtures.js';
import { uuidv7 } from '../support/uuidv7.js';

const LOGS_PER_LEDGER = 6;

describe('ledger_audit_anchors', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** A ledger that already has logs 1..6, so anchors have something to cover. */
  async function ledgerWithLogs(
    org: string = uuidv7(),
  ): Promise<{ org: string; ledgerId: string }> {
    const ledgerId = await inTenant(db, org, async (trx) => {
      const ledger = await insertLedger(trx, org);
      for (let i = 0; i < LOGS_PER_LEDGER; i++) await insertLog(trx, org, ledger.id);
      return ledger.id;
    });
    return { org, ledgerId };
  }

  const FIRST_ROOT = sha256Like(0xa1);

  it('accepts a first anchor that starts at log 1 and has no previous hash', async () => {
    const { org, ledgerId } = await ledgerWithLogs();

    await inTenant(db, org, (trx) =>
      insertAnchor(trx, org, ledgerId, { from: 1, to: 3, root: FIRST_ROOT }),
    );
  });

  it('rejects a first anchor that has a previous hash', async () => {
    const { org, ledgerId } = await ledgerWithLogs();

    await expect(
      inTenant(db, org, (trx) =>
        insertAnchor(trx, org, ledgerId, { from: 1, to: 3, previous: sha256Like(9) }),
      ),
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('null previous_root_hash'),
    });
  });

  it('rejects a first anchor that does not start at log 1', async () => {
    const { org, ledgerId } = await ledgerWithLogs();

    await expect(
      inTenant(db, org, (trx) => insertAnchor(trx, org, ledgerId, { from: 2, to: 3 })),
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('start at log seq 1'),
    });
  });

  describe('after a first anchor (logs 1-3)', () => {
    let ctx: { org: string; ledgerId: string };

    beforeEach(async () => {
      ctx = await ledgerWithLogs();
      await inTenant(db, ctx.org, (trx) =>
        insertAnchor(trx, ctx.org, ctx.ledgerId, { from: 1, to: 3, root: FIRST_ROOT }),
      );
    });

    it('accepts the next anchor when it starts right after and links the previous hash', async () => {
      await inTenant(db, ctx.org, (trx) =>
        insertAnchor(trx, ctx.org, ctx.ledgerId, {
          from: 4,
          to: 6,
          root: sha256Like(0xb2),
          previous: FIRST_ROOT,
        }),
      );
    });

    it('rejects the wrong previous hash', async () => {
      await expect(
        inTenant(db, ctx.org, (trx) =>
          insertAnchor(trx, ctx.org, ctx.ledgerId, { from: 4, to: 6, previous: sha256Like(0xee) }),
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('does not match'),
      });
    });

    it('rejects a missing previous hash', async () => {
      await expect(
        inTenant(db, ctx.org, (trx) =>
          insertAnchor(trx, ctx.org, ctx.ledgerId, { from: 4, to: 6 }),
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('does not match'),
      });
    });

    it.each([
      ['a gap (skips log 4)', 5],
      ['an overlap (repeats log 3)', 3],
    ])('rejects %s', async (_label, from) => {
      await expect(
        inTenant(db, ctx.org, (trx) =>
          insertAnchor(trx, ctx.org, ctx.ledgerId, { from, to: 6, previous: FIRST_ROOT }),
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('previous to_log_seq + 1'),
      });
    });

    it('rejects an anchor for logs that do not exist yet', async () => {
      await expect(
        inTenant(db, ctx.org, (trx) =>
          insertAnchor(trx, ctx.org, ctx.ledgerId, { from: 4, to: 99, previous: FIRST_ROOT }),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('rejects a range that ends before it starts', async () => {
    const { org, ledgerId } = await ledgerWithLogs();

    await expect(
      inTenant(db, org, (trx) => insertAnchor(trx, org, ledgerId, { from: 1, to: 0 })),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ledger_audit_anchors_range_valid' });
  });

  it.each([31, 33])('rejects a root hash of %i bytes', async (size) => {
    const { org, ledgerId } = await ledgerWithLogs();
    const root = Buffer.alloc(size, 1);

    await expect(
      inTenant(db, org, (trx) => insertAnchor(trx, org, ledgerId, { from: 1, to: 3, root })),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('chains every ledger on its own', async () => {
    const org = uuidv7();
    const one = await ledgerWithLogs(org);
    const two = await ledgerWithLogs(org);

    await inTenant(db, org, async (trx) => {
      await insertAnchor(trx, org, one.ledgerId, { from: 1, to: 3, root: FIRST_ROOT });
      // Ledger two has no anchor yet, so it must also start at 1 with no previous hash.
      await insertAnchor(trx, org, two.ledgerId, { from: 1, to: 2, root: sha256Like(0xc3) });
    });
  });

  it('lets only one of two competing anchors win (they are serialized per ledger)', async () => {
    const { org, ledgerId } = await ledgerWithLogs();

    const results = await Promise.allSettled([
      inTenant(db, org, (trx) =>
        insertAnchor(trx, org, ledgerId, { from: 1, to: 3, root: sha256Like(0xd1) }),
      ),
      inTenant(db, org, (trx) =>
        insertAnchor(trx, org, ledgerId, { from: 1, to: 4, root: sha256Like(0xd2) }),
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
