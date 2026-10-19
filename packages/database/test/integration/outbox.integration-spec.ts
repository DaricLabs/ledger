import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import { insertLedger, insertOutboxEvent } from '../support/fixtures.js';
import { uuidv7 } from '../support/uuidv7.js';

describe('outbox_events', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** Runs `fn` inside a fresh ledger of a fresh tenant. */
  async function withLedger<T>(
    fn: (trx: Transaction<DB>, org: string, ledgerId: string) => Promise<T>,
  ): Promise<T> {
    const org = uuidv7();
    return inTenant(db, org, async (trx) => {
      const ledger = await insertLedger(trx, org);
      return fn(trx, org, ledger.id);
    });
  }

  it('starts unpublished, with no attempts and version 1', async () => {
    const event = await withLedger(async (trx, org, ledgerId) => {
      const id = await insertOutboxEvent(trx, org, ledgerId);
      return trx
        .selectFrom('outbox_events')
        .selectAll()
        .where('id', '=', String(id))
        .executeTakeFirstOrThrow();
    });

    expect(event).toMatchObject({
      published_at: null,
      publish_attempts: 0,
      last_error: null,
      event_version: 1,
      payload: {},
    });
  });

  it('lets the relay record a failed attempt and then a success', async () => {
    const event = await withLedger(async (trx, org, ledgerId) => {
      const id = String(await insertOutboxEvent(trx, org, ledgerId));
      await trx
        .updateTable('outbox_events')
        .set({ publish_attempts: 1, last_error: 'broker timeout' })
        .where('id', '=', id)
        .execute();
      await trx
        .updateTable('outbox_events')
        .set({ publish_attempts: 2, last_error: null, published_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
      return trx
        .selectFrom('outbox_events')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    });

    expect(event.publish_attempts).toBe(2);
    expect(event.last_error).toBeNull();
    expect(event.published_at).toBeInstanceOf(Date);
  });

  it.each([
    [
      'published without an attempt',
      { published_at: new Date(Date.now() + 3_600_000) },
      'outbox_events_published_requires_attempt',
    ],
    [
      'an error without an attempt',
      { last_error: 'boom' },
      'outbox_events_last_error_requires_attempt',
    ],
    [
      'published before it was created',
      { published_at: new Date(Date.now() - 3_600_000), publish_attempts: 1 },
      'outbox_events_published_after_created',
    ],
    ['an event_version below 1', { event_version: 0 }, 'outbox_events_event_version_positive'],
    [
      'negative publish_attempts',
      { publish_attempts: -1 },
      'outbox_events_publish_attempts_nonnegative',
    ],
    [
      'an uppercase aggregate_type',
      { aggregate_type: 'Transaction' },
      'outbox_events_aggregate_type_valid',
    ],
    [
      'an aggregate_type over 64 characters',
      { aggregate_type: 'a'.repeat(65) },
      'outbox_events_aggregate_type_valid',
    ],
    ['an empty aggregate_id', { aggregate_id: '' }, 'outbox_events_aggregate_id_length'],
    [
      'an aggregate_id over 128 characters',
      { aggregate_id: 'a'.repeat(129) },
      'outbox_events_aggregate_id_length',
    ],
  ])('rejects %s', async (_label, values, constraint) => {
    await expect(
      withLedger((trx, org, ledgerId) => insertOutboxEvent(trx, org, ledgerId, values)),
    ).rejects.toMatchObject({ code: '23514', constraint });
  });

  it.each(['Ledger.created', 'ledger', 'ledger..created'])(
    'rejects the event type %j',
    async (event_type) => {
      await expect(
        withLedger((trx, org, ledgerId) => insertOutboxEvent(trx, org, ledgerId, { event_type })),
      ).rejects.toMatchObject({ code: '23514' });
    },
  );

  it('does not let the app change the payload of an event', async () => {
    await expect(
      withLedger(async (trx, org, ledgerId) => {
        const id = String(await insertOutboxEvent(trx, org, ledgerId));
        await trx
          .updateTable('outbox_events')
          .set({ payload: { tampered: true } })
          .where('id', '=', id)
          .execute();
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('does not let the app delete events (yet)', async () => {
    await expect(
      withLedger(async (trx, org, ledgerId) => {
        await insertOutboxEvent(trx, org, ledgerId);
        await sql`delete from outbox_events`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
