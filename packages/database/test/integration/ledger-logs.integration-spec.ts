import type { Kysely } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import { insertLedger, insertLog } from '../support/fixtures.js';
import { uuidv7 } from '../support/uuidv7.js';

describe('ledger_logs', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb(10);
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function newLedger(org: string = uuidv7()): Promise<{ org: string; ledgerId: string }> {
    const ledger = await inTenant(db, org, (trx) => insertLedger(trx, org));
    return { org, ledgerId: ledger.id };
  }

  async function lastLogSeq(org: string, ledgerId: string): Promise<number> {
    const row = await inTenant(db, org, (trx) =>
      trx
        .selectFrom('ledgers')
        .select('last_log_seq')
        .where('id', '=', ledgerId)
        .executeTakeFirstOrThrow(),
    );
    return Number(row.last_log_seq);
  }

  describe('seq', () => {
    it('counts 1, 2, 3 ... inside a ledger', async () => {
      const { org, ledgerId } = await newLedger();

      const seqs = await inTenant(db, org, async (trx) => [
        await insertLog(trx, org, ledgerId),
        await insertLog(trx, org, ledgerId),
        await insertLog(trx, org, ledgerId),
      ]);

      expect(seqs).toEqual([1, 2, 3]);
    });

    it('ignores a seq sent by the client', async () => {
      const { org, ledgerId } = await newLedger();

      const seq = await inTenant(db, org, (trx) => insertLog(trx, org, ledgerId, { seq: 999 }));

      expect(seq).toBe(1);
    });

    it('has a separate counter for every ledger', async () => {
      const org = uuidv7();
      const one = await newLedger(org);
      const two = await newLedger(org);

      const [first, second, third] = await inTenant(db, org, async (trx) => [
        await insertLog(trx, org, one.ledgerId),
        await insertLog(trx, org, two.ledgerId),
        await insertLog(trx, org, one.ledgerId),
      ]);

      expect([first, second, third]).toEqual([1, 1, 2]);
    });

    it('keeps ledgers.last_log_seq equal to the last log', async () => {
      const { org, ledgerId } = await newLedger();

      await inTenant(db, org, async (trx) => {
        await insertLog(trx, org, ledgerId);
        await insertLog(trx, org, ledgerId);
      });

      expect(await lastLogSeq(org, ledgerId)).toBe(2);
    });

    it('leaves no gap when a transaction rolls back', async () => {
      const { org, ledgerId } = await newLedger();
      await inTenant(db, org, (trx) => insertLog(trx, org, ledgerId)); // seq 1

      await expect(
        inTenant(db, org, async (trx) => {
          await insertLog(trx, org, ledgerId); // would be seq 2
          throw new Error('rollback please');
        }),
      ).rejects.toThrow('rollback please');
      const next = await inTenant(db, org, (trx) => insertLog(trx, org, ledgerId));

      expect(next).toBe(2);
      expect(await lastLogSeq(org, ledgerId)).toBe(2);
    });

    it('gives unique numbers without gaps to writers that run at the same time', async () => {
      const { org, ledgerId } = await newLedger();
      const writers = 10;

      const seqs = await Promise.all(
        Array.from({ length: writers }, () =>
          inTenant(db, org, (trx) => insertLog(trx, org, ledgerId)),
        ),
      );

      expect([...seqs].sort((a, b) => a - b)).toEqual(
        Array.from({ length: writers }, (_, i) => i + 1),
      );
      expect(await lastLogSeq(org, ledgerId)).toBe(writers);
    });
  });

  describe('protection', () => {
    it('does not let the app change last_log_seq directly', async () => {
      const { org, ledgerId } = await newLedger();

      await expect(
        inTenant(db, org, (trx) =>
          trx
            .updateTable('ledgers')
            .set({ last_log_seq: 100 })
            .where('id', '=', ledgerId)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a log for a ledger of another organization', async () => {
      const mine = await newLedger();
      const theirs = await newLedger();

      await expect(
        inTenant(db, mine.org, (trx) => insertLog(trx, mine.org, theirs.ledgerId)),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('ledger not found for log'),
      });
      expect(await lastLogSeq(theirs.org, theirs.ledgerId)).toBe(0); // their counter is untouched
    });

    it.each(['transaction_created', 'AB', 'TRANSACTION CREATED', `A${'B'.repeat(64)}`])(
      'rejects the type %j',
      async (type) => {
        const { org, ledgerId } = await newLedger();

        await expect(
          inTenant(db, org, (trx) => insertLog(trx, org, ledgerId, { type })),
        ).rejects.toMatchObject({ code: '23514', constraint: 'ledger_logs_type_valid' });
      },
    );

    it('refuses a transaction that does not exist', async () => {
      const { org, ledgerId } = await newLedger();

      await expect(
        inTenant(db, org, (trx) => insertLog(trx, org, ledgerId, { transactionId: uuidv7() })),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });
});
