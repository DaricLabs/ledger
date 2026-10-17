import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import { insertIdempotencyKey, insertLedger, randomName, sha256Like } from '../support/fixtures.js';
import { uuidv7 } from '../support/uuidv7.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
    const org = uuidv7();
    return inTenant(db, org, async (trx) => {
      const ledger = await insertLedger(trx, org);
      return fn(trx, org, ledger.id);
    });
  }

  // `created_at` is set explicitly (30 minutes ago) so `completed_at` is clearly after it,
  // even if the database clock and the test clock differ a little.
  const completed = {
    state: 'completed',
    response_status: 201,
    response_body: {},
    created_at: new Date(Date.now() - 30 * MINUTE),
    completed_at: new Date(),
    lock_expires_at: null,
  } as const;

  it('accepts an in-progress key that holds a lease', async () => {
    await withLedger((trx, org, ledgerId) => insertIdempotencyKey(trx, org, ledgerId));
  });

  it('accepts a completed key that stores the response', async () => {
    await withLedger((trx, org, ledgerId) =>
      insertIdempotencyKey(trx, org, ledgerId, { ...completed }),
    );
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

  it.each([
    [
      'a completed key without response_status',
      { ...completed, response_status: null },
      'idempotency_keys_completed_requires_response',
    ],
    [
      'a completed key without response_body',
      { ...completed, response_body: null },
      'idempotency_keys_completed_requires_response',
    ],
    [
      'a completed key without completed_at',
      { ...completed, completed_at: null },
      'idempotency_keys_completed_requires_response',
    ],
    [
      'an in-progress key without a lease',
      { lock_expires_at: null },
      'idempotency_keys_in_progress_requires_lock',
    ],
    [
      'an expiry that is not after creation',
      { expires_at: new Date(Date.now() - HOUR) },
      'idempotency_keys_expiry_after_created',
    ],
    [
      'completion before creation',
      { ...completed, completed_at: new Date(Date.now() - HOUR) },
      'idempotency_keys_completed_after_created',
    ],
    [
      'a response status below 100',
      { response_status: 99 },
      'idempotency_keys_response_status_valid',
    ],
    [
      'a response status above 599',
      { response_status: 600 },
      'idempotency_keys_response_status_valid',
    ],
    ['the method GET', { method: 'GET' as never }, 'idempotency_keys_method_valid'],
    ['a path without a leading slash', { path: 'v2/transactions' }, 'idempotency_keys_path_valid'],
    ['a path over 512 characters', { path: `/${'a'.repeat(512)}` }, 'idempotency_keys_path_valid'],
    ['an empty key', { key: '' }, 'idempotency_keys_key_length'],
    ['a key over 256 characters', { key: 'k'.repeat(257) }, 'idempotency_keys_key_length'],
    ['an unknown state', { state: 'weird' as never }, 'idempotency_keys_state_valid'],
  ])('rejects %s', async (_label, values, constraint) => {
    await expect(
      withLedger((trx, org, ledgerId) => insertIdempotencyKey(trx, org, ledgerId, values)),
    ).rejects.toMatchObject({ code: '23514', constraint });
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

  it('lets the app complete a key and later delete it (cleanup of expired keys)', async () => {
    const key = randomName('key');

    const { deleted, state } = await withLedger(async (trx, org, ledgerId) => {
      await insertIdempotencyKey(trx, org, ledgerId, { key });
      await trx
        .updateTable('idempotency_keys')
        .set({
          state: 'completed',
          response_status: 200,
          response_body: {},
          completed_at: sql<Date>`now()`,
          lock_expires_at: null,
        })
        .where('key', '=', key)
        .execute();
      const row = await trx
        .selectFrom('idempotency_keys')
        .select('state')
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
      const result = await trx
        .deleteFrom('idempotency_keys')
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
      return { deleted: result.numDeletedRows, state: row.state };
    });

    expect(state).toBe('completed');
    expect(deleted).toBe(1n);
  });
});
