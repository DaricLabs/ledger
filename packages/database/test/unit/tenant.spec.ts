import { sql } from 'kysely';
import type { TenantTransaction } from '../../src/index.js';
import { unwrapTenantTransaction, withTenant } from '../../src/storage.js';
import { createRecordingDb } from '../support/recording-db.js';
import { uuidv7 } from '../support/uuidv7.js';

const ORG_ID = uuidv7();

describe('unwrapTenantTransaction', () => {
  it('returns the very same object (the opaque type only exists at compile time)', () => {
    const real = { marker: 'kysely transaction' };

    const unwrapped = unwrapTenantTransaction(real as unknown as TenantTransaction);

    expect(unwrapped).toBe(real);
  });
});

describe('withTenant', () => {
  it('sets daric.organization_id for this transaction only (is_local = true)', async () => {
    const { db, events } = createRecordingDb();

    await withTenant(db, ORG_ID, async () => undefined);

    const [query] = events.filter((e) => e.type === 'query');
    expect(query).toEqual({
      type: 'query',
      sql: "select set_config('daric.organization_id', $1, true)",
      parameters: [ORG_ID],
    });
  });

  it('sends the organization id as a bound parameter, never inside the SQL text', async () => {
    const { db, events } = createRecordingDb();
    const hostile = `'); drop table ledgers; --`;

    await withTenant(db, hostile, async () => undefined);

    const [query] = events.filter((e) => e.type === 'query');
    expect(query).toMatchObject({ parameters: [hostile] });
    expect(query).not.toMatchObject({ sql: expect.stringContaining('drop table') });
  });

  it('sets the tenant before the first query of the callback', async () => {
    const { db, events } = createRecordingDb();

    await withTenant(db, ORG_ID, async (tenantTrx) => {
      await sql`select 1`.execute(unwrapTenantTransaction(tenantTrx));
    });

    expect(events.map((e) => (e.type === 'query' ? e.sql : e.type))).toEqual([
      'begin',
      "select set_config('daric.organization_id', $1, true)",
      'select 1',
      'commit',
    ]);
  });

  it('commits and returns the value of the callback', async () => {
    const { db, events } = createRecordingDb();

    const result = await withTenant(db, ORG_ID, async () => 'the result');

    expect(result).toBe('the result');
    expect(events.at(-1)).toEqual({ type: 'commit' });
    expect(events).not.toContainEqual({ type: 'rollback' });
  });

  it('rolls back and rethrows the same error when the callback fails', async () => {
    const { db, events } = createRecordingDb();
    const failure = new Error('callback failed');

    await expect(
      withTenant(db, ORG_ID, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(events.at(-1)).toEqual({ type: 'rollback' });
    expect(events).not.toContainEqual({ type: 'commit' });
  });

  it('does not run the callback when setting the tenant fails', async () => {
    const failure = new Error('set_config failed');
    const { db, events } = createRecordingDb((text) =>
      text.includes('set_config') ? failure : undefined,
    );
    let callbackRan = false;

    await expect(
      withTenant(db, ORG_ID, async () => {
        callbackRan = true;
      }),
    ).rejects.toBe(failure);

    expect(callbackRan).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'rollback' });
  });
});
