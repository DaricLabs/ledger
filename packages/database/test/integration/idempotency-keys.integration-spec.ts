import { randomUUIDv7 } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import {
  insertIdempotencyKey,
  insertLedger,
  insertTransaction,
  randomName,
  sha256Like,
} from '../support/fixtures.js';

const HOUR = 3_600_000;

describe('idempotency_keys', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function withLedger<T>(
    fn: (trx: Transaction<DB>, org: string, ledgerId: string) => Promise<T>,
  ): Promise<T> {
    const org = randomUUIDv7();
    return inTenant(db, org, async (trx) => {
      const ledger = await insertLedger(trx, org);
      return fn(trx, org, ledger.id);
    });
  }

  it('accepts a key that points to a transaction of the same ledger', async () => {
    await withLedger((trx, org, ledgerId) => insertIdempotencyKey(trx, org, ledgerId));
  });

  describe('uniqueness (organization, ledger, operation, key)', () => {
    it('rejects the same key for the same operation in the same ledger', async () => {
      await expect(
        withLedger(async (trx, org, ledgerId) => {
          await insertIdempotencyKey(trx, org, ledgerId, { key: 'k1' });
          await insertIdempotencyKey(trx, org, ledgerId, { key: 'k1' });
        }),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('accepts the same key for another operation or another ledger', async () => {
      await withLedger(async (trx, org, ledgerId) => {
        const other = await insertLedger(trx, org);
        await insertIdempotencyKey(trx, org, ledgerId, { key: 'k1' });
        await insertIdempotencyKey(trx, org, ledgerId, { key: 'k1', operation: 'ledgers.create' });
        await insertIdempotencyKey(trx, org, other.id, { key: 'k1' });
      });
    });
  });

  describe('key', () => {
    it.each([
      ['one character', 'k'],
      ['255 characters', 'k'.repeat(255)],
      ['spaces and symbols', 'order 42/retry#1 (a+b)~'],
    ])('accepts %s', async (_label, key) => {
      await withLedger((trx, org, ledgerId) => insertIdempotencyKey(trx, org, ledgerId, { key }));
    });

    it.each([
      ['an empty key', ''],
      ['a key over 255 characters', 'k'.repeat(256)],
      ['a key with a new line', 'k\nk'],
      ['a key with a tab', 'k\tk'],
      ['a key with a letter that is not ASCII', 'cl\u00e9'],
    ])('rejects %s', async (_label, key) => {
      await expect(
        withLedger((trx, org, ledgerId) => insertIdempotencyKey(trx, org, ledgerId, { key })),
      ).rejects.toMatchObject({ code: '23514', constraint: 'idempotency_keys_key_valid' });
    });
  });

  it('rejects an expiry that is not after the creation', async () => {
    await expect(
      withLedger((trx, org, ledgerId) =>
        insertIdempotencyKey(trx, org, ledgerId, { expires_at: new Date(Date.now() - HOUR) }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'idempotency_keys_expiry_after_created' });
  });

  it.each([16, 64])('rejects a request hash of %i bytes', async (size) => {
    await expect(
      withLedger((trx, org, ledgerId) =>
        insertIdempotencyKey(trx, org, ledgerId, { request_hash: Buffer.alloc(size, 1) }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts a request hash of exactly 32 bytes', async () => {
    await withLedger((trx, org, ledgerId) =>
      insertIdempotencyKey(trx, org, ledgerId, { request_hash: sha256Like(0xff) }),
    );
  });

  describe('transaction_id', () => {
    it('can be written before the transaction row, in the same database transaction', async () => {
      // The use case claims the key first and saves the transaction after it.
      await withLedger(async (trx, org, ledgerId) => {
        const transactionId = randomUUIDv7();
        await insertIdempotencyKey(trx, org, ledgerId, { transaction_id: transactionId });
        await insertTransaction(trx, org, ledgerId, { id: transactionId });
      });
    });

    it('fails the commit when the transaction row is never saved', async () => {
      await expect(
        withLedger((trx, org, ledgerId) =>
          insertIdempotencyKey(trx, org, ledgerId, { transaction_id: randomUUIDv7() }),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('fails the commit when the transaction is in another ledger', async () => {
      await expect(
        withLedger(async (trx, org, ledgerId) => {
          const other = await insertLedger(trx, org);
          const otherTransactionId = await insertTransaction(trx, org, other.id);
          await insertIdempotencyKey(trx, org, ledgerId, { transaction_id: otherTransactionId });
        }),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('lets the app replace an expired key and later delete it', async () => {
    const key = randomName('key');

    const { replaced, deleted } = await withLedger(async (trx, org, ledgerId) => {
      await insertIdempotencyKey(trx, org, ledgerId, { key });
      const newTransactionId = await insertTransaction(trx, org, ledgerId);
      await trx
        .updateTable('idempotency_keys')
        .set({
          request_hash: sha256Like(9),
          transaction_id: newTransactionId,
          created_at: sql<Date>`now()`,
          expires_at: new Date(Date.now() + HOUR),
        })
        .where('key', '=', key)
        .execute();
      const row = await trx
        .selectFrom('idempotency_keys')
        .select(['request_hash', 'transaction_id'])
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
      const result = await trx
        .deleteFrom('idempotency_keys')
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
      return {
        replaced: { hash: row.request_hash, transactionId: row.transaction_id, newTransactionId },
        deleted: result.numDeletedRows,
      };
    });

    expect(replaced.hash).toEqual(sha256Like(9));
    expect(replaced.transactionId).toBe(replaced.newTransactionId);
    expect(deleted).toBe(1n);
  });
});
