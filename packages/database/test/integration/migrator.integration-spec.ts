import { sql, type Kysely } from 'kysely';
import { migrateToLatest } from '../../src/migrator.js';
import { createDb } from '../support/db.js';
import { testDatabaseUrls } from '../support/config.js';

describe('migrateToLatest', () => {
  let db: Kysely<unknown>;

  beforeAll(() => {
    db = createDb<unknown>(testDatabaseUrls.migrator, 2);
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function appliedMigrations(): Promise<string[]> {
    const { rows } = await sql<{
      name: string;
    }>`select name from kysely_migration order by name`.execute(db);
    return rows.map((r) => r.name);
  }

  it('has applied 0001_init (done once by the global setup)', async () => {
    expect(await appliedMigrations()).toContain('0001_init');
  });

  it('is safe to run again: applies nothing and does not fail', async () => {
    const before = await appliedMigrations();

    await expect(migrateToLatest(db)).resolves.toBeUndefined();

    expect(await appliedMigrations()).toEqual(before);
  });

  it('keeps two runs at the same time safe (Kysely migration lock)', async () => {
    const before = await appliedMigrations();

    await expect(Promise.all([migrateToLatest(db), migrateToLatest(db)])).resolves.toBeDefined();

    expect(await appliedMigrations()).toEqual(before);
  });
});
