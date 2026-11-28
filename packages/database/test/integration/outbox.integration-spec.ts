import { randomUUIDv7 } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRelayDb, createRuntimeDb, inTenant } from '../support/db.js';
import { insertLedger, insertLog, insertOutboxEvent } from '../support/fixtures.js';

describe('outbox_events', () => {
  let db: Kysely<DB>;
  let relay: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb();
    relay = createRelayDb();
  });

  afterAll(async () => {
    await Promise.all([db.destroy(), relay.destroy()]);
  });

  /** Runs `fn` inside a fresh ledger of a fresh tenant. */
  async function withLedger<T>(
    fn: (trx: Transaction<DB>, org: string, ledgerId: string) => Promise<T>,
  ): Promise<T> {
    const org = randomUUIDv7();
    return inTenant(db, org, async (trx) => {
      const ledger = await insertLedger(trx, org);
      return fn(trx, org, ledger.id);
    });
  }

  /** Commits an event as the app does and returns its id (the relay reads committed rows). */
  async function commitEvent(
    values: Parameters<typeof insertOutboxEvent>[3] = {},
  ): Promise<{ org: string; id: string }> {
    return withLedger(async (trx, org, ledgerId) => ({
      org,
      id: String(await insertOutboxEvent(trx, org, ledgerId, values)),
    }));
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
    expect(event.next_attempt_at).toEqual(event.created_at);
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
    [
      'a last_error over 1000 characters',
      { last_error: 'e'.repeat(1001), publish_attempts: 1 },
      'outbox_events_last_error_length',
    ],
    ['an empty aggregate_id', { aggregate_id: '' }, 'outbox_events_aggregate_id_length'],
    [
      'an aggregate_id over 256 characters',
      { aggregate_id: 'a'.repeat(257) },
      'outbox_events_aggregate_id_length',
    ],
  ])('rejects %s', async (_label, values, constraint) => {
    await expect(
      withLedger((trx, org, ledgerId) => insertOutboxEvent(trx, org, ledgerId, values)),
    ).rejects.toMatchObject({ code: '23514', constraint });
  });

  it('accepts an aggregate_id of exactly 256 characters, the longest account address', async () => {
    const id = await withLedger((trx, org, ledgerId) =>
      insertOutboxEvent(trx, org, ledgerId, { aggregate_id: 'a'.repeat(256) }),
    );

    expect(id).toBeGreaterThan(0);
  });

  it.each(['Ledger.created', 'ledger', 'ledger..created'])(
    'rejects the event type %j',
    async (event_type) => {
      await expect(
        withLedger((trx, org, ledgerId) => insertOutboxEvent(trx, org, ledgerId, { event_type })),
      ).rejects.toMatchObject({ code: '23514' });
    },
  );

  it('keeps the seq of the log entry it was written with', async () => {
    const { logSeq, event } = await withLedger(async (trx, org, ledgerId) => {
      const seq = await insertLog(trx, org, ledgerId);
      const id = String(await insertOutboxEvent(trx, org, ledgerId, { log_seq: seq }));
      const row = await trx
        .selectFrom('outbox_events')
        .select('log_seq')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return { logSeq: seq, event: row };
    });

    expect(event.log_seq).toBe(String(logSeq));
  });

  it('rejects an event without a log entry', async () => {
    await expect(
      withLedger((trx, org, ledgerId) => insertOutboxEvent(trx, org, ledgerId, { log_seq: 99 })),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects an event that points to a log entry of another ledger', async () => {
    await expect(
      withLedger(async (trx, org, ledgerId) => {
        const other = await insertLedger(trx, org);
        const seq = await insertLog(trx, org, other.id);
        await insertOutboxEvent(trx, org, ledgerId, { log_seq: seq });
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a second event for the same log entry', async () => {
    await expect(
      withLedger(async (trx, org, ledgerId) => {
        const seq = await insertLog(trx, org, ledgerId);
        await insertOutboxEvent(trx, org, ledgerId, { log_seq: seq });
        await insertOutboxEvent(trx, org, ledgerId, { log_seq: seq });
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'outbox_events_organization_id_ledger_id_log_seq_key',
    });
  });

  it('accepts a last_error of exactly 1000 characters', async () => {
    const id = await withLedger((trx, org, ledgerId) =>
      insertOutboxEvent(trx, org, ledgerId, { last_error: 'e'.repeat(1000), publish_attempts: 1 }),
    );

    expect(id).toBeGreaterThan(0);
  });

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

  it('does not let the app record publish status (only the relay does)', async () => {
    await expect(
      withLedger(async (trx, org, ledgerId) => {
        const id = String(await insertOutboxEvent(trx, org, ledgerId));
        await trx
          .updateTable('outbox_events')
          .set({ publish_attempts: 1, published_at: sql<Date>`now()` })
          .where('id', '=', id)
          .execute();
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('does not let the app delete events', async () => {
    await expect(
      withLedger(async (trx, org, ledgerId) => {
        await insertOutboxEvent(trx, org, ledgerId);
        await sql`delete from outbox_events`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  describe('as the relay (ledger_relay)', () => {
    it('sees the events of every tenant without setting a tenant', async () => {
      const a = await commitEvent();
      const b = await commitEvent();

      const rows = await relay
        .selectFrom('outbox_events')
        .select(['id', 'organization_id'])
        .where('id', 'in', [a.id, b.id])
        .execute();

      expect(rows.map((r) => r.organization_id).sort()).toEqual([a.org, b.org].sort());
    });

    it('records a failed attempt with a retry time, and then a success', async () => {
      const { id } = await commitEvent();
      const retryAt = new Date(Date.now() + 60_000);

      await relay
        .updateTable('outbox_events')
        .set({ publish_attempts: 1, last_error: 'broker timeout', next_attempt_at: retryAt })
        .where('id', '=', id)
        .execute();
      const failed = await relay
        .selectFrom('outbox_events')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      await relay
        .updateTable('outbox_events')
        .set({ publish_attempts: 2, last_error: null, published_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
      const published = await relay
        .selectFrom('outbox_events')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      expect(failed).toMatchObject({ publish_attempts: 1, last_error: 'broker timeout' });
      expect(failed.next_attempt_at).toEqual(retryAt);
      expect(published.publish_attempts).toBe(2);
      expect(published.last_error).toBeNull();
      expect(published.published_at).toBeInstanceOf(Date);
    });

    it('does not let the relay cut in with an error longer than 1000 characters', async () => {
      const { id } = await commitEvent();

      await expect(
        relay
          .updateTable('outbox_events')
          .set({ publish_attempts: 1, last_error: 'e'.repeat(1001) })
          .where('id', '=', id)
          .execute(),
      ).rejects.toMatchObject({ code: '23514', constraint: 'outbox_events_last_error_length' });
    });

    it.each([
      ['payload', { payload: { tampered: true } }],
      ['event_type', { event_type: 'ledger.transaction.reverted' }],
      ['log_seq', { log_seq: 1 }],
      ['created_at', { created_at: new Date(0) }],
    ])('does not let the relay change %s', async (_column, values) => {
      const { id } = await commitEvent();

      await expect(
        relay.updateTable('outbox_events').set(values).where('id', '=', id).execute(),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('does not let the relay add events', async () => {
      await expect(
        relay
          .insertInto('outbox_events')
          .values({
            organization_id: randomUUIDv7(),
            ledger_id: randomUUIDv7(),
            log_seq: 1,
            aggregate_type: 'transaction',
            aggregate_id: randomUUIDv7(),
            event_type: 'ledger.transaction.created',
            payload: {},
          })
          .execute(),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('freezes a published event: the relay can no longer change it', async () => {
      const { id } = await commitEvent();
      await relay
        .updateTable('outbox_events')
        .set({ publish_attempts: 1, published_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();

      const result = await relay
        .updateTable('outbox_events')
        .set({ published_at: null, last_error: 'again' })
        .where('id', '=', id)
        .executeTakeFirst();
      const row = await relay
        .selectFrom('outbox_events')
        .select(['published_at', 'last_error'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      expect(result.numUpdatedRows).toBe(0n);
      expect(row.published_at).toBeInstanceOf(Date);
      expect(row.last_error).toBeNull();
    });

    it('deletes a published event', async () => {
      const { id } = await commitEvent();
      await relay
        .updateTable('outbox_events')
        .set({ publish_attempts: 1, published_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();

      const result = await relay
        .deleteFrom('outbox_events')
        .where('id', '=', id)
        .executeTakeFirst();
      const left = await relay
        .selectFrom('outbox_events')
        .select('id')
        .where('id', '=', id)
        .execute();

      expect(result.numDeletedRows).toBe(1n);
      expect(left).toEqual([]);
    });

    it('does not delete an event that is not published yet', async () => {
      const { id } = await commitEvent();

      const result = await relay
        .deleteFrom('outbox_events')
        .where('id', '=', id)
        .executeTakeFirst();
      const left = await relay
        .selectFrom('outbox_events')
        .select('id')
        .where('id', '=', id)
        .execute();

      expect(result.numDeletedRows).toBe(0n);
      expect(left).toHaveLength(1);
    });

    it.each(['ledgers', 'ledger_logs', 'transactions', 'idempotency_keys'])(
      'cannot read %s',
      async (table) => {
        await expect(sql`select 1 from ${sql.table(table)}`.execute(relay)).rejects.toMatchObject({
          code: '42501',
        });
      },
    );
  });
});
