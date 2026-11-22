import { Metadata } from '@ledger/domain';
import {
  createDb,
  sql,
  SqlState,
  unwrapTenantTransaction,
  withTenant,
  type LedgerDatabase,
} from '@ledger/database/storage';
import type {
  ILedgerPage,
  ILedgerPageQuery,
} from '../../application/ports/ledger-repository.port.js';
import { LedgerAlreadyExistsError } from '../../domain/errors/ledger-already-exists.error.js';
import { Ledger } from '../../domain/entities/ledger.entity.js';
import { KyselyLedgerRepository } from './kysely-ledger.repository.js';
import { Uuidv7IdGenerator } from '../../../ids/infrastructure/adapters/uuidv7-id-generator.adapter.js';

// The repository has no constructor arguments, so these tests do not need Nest.
// Every test uses a new organization id, so tests never see each other's rows.
const ids = new Uuidv7IdGenerator();
const repository = new KyselyLedgerRepository();
let db: LedgerDatabase;

beforeAll(() => {
  // The runtime role, like the app. Row-level security applies to it.
  db = createDb(process.env.LEDGER_RUNTIME_DATABASE_URL!, {
    onPoolError: (error) => console.error(error),
  });
});

afterAll(() => db.destroy());

/** Makes a valid ledger. Pass `id` to force an id clash. */
const makeLedger = (organizationId: string, name: string, id = ids.next()) =>
  Ledger.create({ id, organizationId, name, metadata: Metadata.of({}), createdAt: new Date() });

describe('KyselyLedgerRepository.insert', () => {
  it('maps a duplicate name to LedgerAlreadyExistsError', async () => {
    const organizationId = ids.next();
    await withTenant(db, organizationId, (trx) =>
      repository.insert(trx, makeLedger(organizationId, 'main')),
    );

    await expect(
      withTenant(db, organizationId, (trx) =>
        repository.insert(trx, makeLedger(organizationId, 'main')),
      ),
    ).rejects.toBeInstanceOf(LedgerAlreadyExistsError);
  });

  it('does not hide another unique violation (same id, different name)', async () => {
    const organizationId = ids.next();
    const id = ids.next();
    await withTenant(db, organizationId, (trx) =>
      repository.insert(trx, makeLedger(organizationId, 'one', id)),
    );

    // Catch the error, so the test can look at it.
    const error = await withTenant(db, organizationId, (trx) =>
      repository.insert(trx, makeLedger(organizationId, 'two', id)),
    ).catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(LedgerAlreadyExistsError);
    expect(error).toMatchObject({ code: SqlState.UniqueViolation }); // the raw database error
  });
});

describe('KyselyLedgerRepository.findByName', () => {
  it('loads a saved ledger with all its fields', async () => {
    const organizationId = ids.next();
    const saved = Ledger.create({
      id: ids.next(),
      organizationId,
      name: 'main',
      metadata: Metadata.of({ env: 'prod', team: 'payments' }),
      createdAt: new Date('2026-11-04T10:00:00.123Z'),
    });
    await withTenant(db, organizationId, (trx) => repository.insert(trx, saved));

    const found = await withTenant(db, organizationId, (trx) => repository.findByName(trx, 'main'));

    expect(found).toBeInstanceOf(Ledger);
    expect(found?.id).toBe(saved.id);
    expect(found?.organizationId).toBe(organizationId);
    expect(found?.name).toBe('main');
    expect(found?.metadata.entries).toEqual({ env: 'prod', team: 'payments' });
    expect(found?.createdAt).toEqual(saved.createdAt);
  });

  it('returns null when the organization has no ledger with this name', async () => {
    const organizationId = ids.next();
    await withTenant(db, organizationId, (trx) =>
      repository.insert(trx, makeLedger(organizationId, 'main')),
    );

    const found = await withTenant(db, organizationId, (trx) =>
      repository.findByName(trx, 'other'),
    );

    expect(found).toBeNull();
  });

  it('does not find the ledger of another organization', async () => {
    const owner = ids.next();
    const other = ids.next();
    await withTenant(db, owner, (trx) => repository.insert(trx, makeLedger(owner, 'main')));

    const found = await withTenant(db, other, (trx) => repository.findByName(trx, 'main'));

    expect(found).toBeNull();
  });

  it('finds the ledger of its own organization when another one uses the same name', async () => {
    const first = ids.next();
    const second = ids.next();
    const firstLedger = makeLedger(first, 'main');
    const secondLedger = makeLedger(second, 'main');
    await withTenant(db, first, (trx) => repository.insert(trx, firstLedger));
    await withTenant(db, second, (trx) => repository.insert(trx, secondLedger));

    const found = await withTenant(db, second, (trx) => repository.findByName(trx, 'main'));

    expect(found?.id).toBe(secondLedger.id);
  });
});

describe('KyselyLedgerRepository.findByNameForUpdate', () => {
  it('loads a saved ledger with all its fields', async () => {
    const organizationId = ids.next();
    const saved = Ledger.create({
      id: ids.next(),
      organizationId,
      name: 'main',
      metadata: Metadata.of({ env: 'prod' }),
      createdAt: new Date('2026-11-05T10:00:00.123Z'),
    });
    await withTenant(db, organizationId, (trx) => repository.insert(trx, saved));

    const found = await withTenant(db, organizationId, (trx) =>
      repository.findByNameForUpdate(trx, 'main'),
    );

    expect(found).toBeInstanceOf(Ledger);
    expect(found?.id).toBe(saved.id);
    expect(found?.organizationId).toBe(organizationId);
    expect(found?.name).toBe('main');
    expect(found?.metadata.entries).toEqual({ env: 'prod' });
    expect(found?.createdAt).toEqual(saved.createdAt);
  });

  it('returns null when the organization has no ledger with this name', async () => {
    const found = await withTenant(db, ids.next(), (trx) =>
      repository.findByNameForUpdate(trx, 'main'),
    );

    expect(found).toBeNull();
  });

  it('does not find the ledger of another organization', async () => {
    const owner = ids.next();
    await withTenant(db, owner, (trx) => repository.insert(trx, makeLedger(owner, 'main')));

    const found = await withTenant(db, ids.next(), (trx) =>
      repository.findByNameForUpdate(trx, 'main'),
    );

    expect(found).toBeNull();
  });

  describe('the lock', () => {
    /**
     * Locks the ledger in a transaction that stays open until `release` is
     * called. Resolves when the lock is taken.
     */
    async function holdLock(organizationId: string) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let taken!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        taken = resolve;
      });

      const done = withTenant(db, organizationId, async (trx) => {
        await repository.findByNameForUpdate(trx, 'main');
        taken();
        await released;
      });
      await Promise.race([lockTaken, done]); // `done` ends first only if locking failed
      return { release, done };
    }

    it('makes a second locking read wait until the first transaction ends', async () => {
      const organizationId = ids.next();
      await withTenant(db, organizationId, (trx) =>
        repository.insert(trx, makeLedger(organizationId, 'main')),
      );
      const first = await holdLock(organizationId);

      // A short lock timeout turns "waits forever" into an error we can check.
      const second = withTenant(db, organizationId, async (trx) => {
        await sql`set local lock_timeout = '300ms'`.execute(unwrapTenantTransaction(trx));
        await repository.findByNameForUpdate(trx, 'main');
      });

      await expect(second).rejects.toMatchObject({ code: SqlState.LockNotAvailable });
      first.release();
      await first.done;
    });

    it('lets the next locking read go on after the first transaction ends', async () => {
      const organizationId = ids.next();
      await withTenant(db, organizationId, (trx) =>
        repository.insert(trx, makeLedger(organizationId, 'main')),
      );
      const first = await holdLock(organizationId);
      first.release();
      await first.done;

      const found = await withTenant(db, organizationId, (trx) =>
        repository.findByNameForUpdate(trx, 'main'),
      );

      expect(found?.name).toBe('main');
    });

    it('does not block a plain read of the same ledger', async () => {
      const organizationId = ids.next();
      await withTenant(db, organizationId, (trx) =>
        repository.insert(trx, makeLedger(organizationId, 'main')),
      );
      const first = await holdLock(organizationId);

      const found = await withTenant(db, organizationId, async (trx) => {
        await sql`set local lock_timeout = '300ms'`.execute(unwrapTenantTransaction(trx));
        return repository.findByName(trx, 'main');
      });

      expect(found?.name).toBe('main');
      first.release();
      await first.done;
    });
  });
});

describe('KyselyLedgerRepository.updateMetadata', () => {
  const insertWithMetadata = async (
    organizationId: string,
    name: string,
    metadata: Record<string, string>,
  ) => {
    const ledger = Ledger.create({
      id: ids.next(),
      organizationId,
      name,
      metadata: Metadata.of(metadata),
      createdAt: new Date('2026-11-05T10:00:00.123Z'),
    });
    await withTenant(db, organizationId, (trx) => repository.insert(trx, ledger));
    return ledger;
  };

  it('saves the new metadata and changes nothing else', async () => {
    const organizationId = ids.next();
    const saved = await insertWithMetadata(organizationId, 'main', { env: 'prod' });

    await withTenant(db, organizationId, (trx) =>
      repository.updateMetadata(trx, saved.withMetadata({ env: 'staging', tier: '1' })),
    );
    const found = await withTenant(db, organizationId, (trx) => repository.findByName(trx, 'main'));

    expect(found?.metadata.entries).toEqual({ env: 'staging', tier: '1' });
    expect(found?.id).toBe(saved.id);
    expect(found?.name).toBe('main');
    expect(found?.createdAt).toEqual(saved.createdAt);
  });

  it('writes exactly the metadata of the ledger it is given, so a removed key is gone', async () => {
    const organizationId = ids.next();
    const saved = await insertWithMetadata(organizationId, 'main', { env: 'prod', team: 'pay' });

    await withTenant(db, organizationId, (trx) =>
      repository.updateMetadata(trx, saved.withoutMetadataKey('env')),
    );
    const found = await withTenant(db, organizationId, (trx) => repository.findByName(trx, 'main'));

    expect(found?.metadata.entries).toEqual({ team: 'pay' });
  });

  it('can save empty metadata', async () => {
    const organizationId = ids.next();
    const saved = await insertWithMetadata(organizationId, 'main', { env: 'prod' });

    await withTenant(db, organizationId, (trx) =>
      repository.updateMetadata(trx, saved.withoutMetadataKey('env')),
    );
    const found = await withTenant(db, organizationId, (trx) => repository.findByName(trx, 'main'));

    expect(found?.metadata.entries).toEqual({});
  });

  it('keeps quotes, unicode and long values as they are', async () => {
    const organizationId = ids.next();
    const saved = await insertWithMetadata(organizationId, 'main', {});
    const metadata = {
      'key "with" quotes': `it's a "value" with \\ backslash`,
      größe: 'Zürich ✓ 日本語 😀',
      long: 'x'.repeat(10_000),
    };

    await withTenant(db, organizationId, (trx) =>
      repository.updateMetadata(trx, saved.withMetadata(metadata)),
    );
    const found = await withTenant(db, organizationId, (trx) => repository.findByName(trx, 'main'));

    expect(found?.metadata.entries).toEqual(metadata);
  });

  it('does not change another ledger of the same organization', async () => {
    const organizationId = ids.next();
    const main = await insertWithMetadata(organizationId, 'main', { env: 'prod' });
    await insertWithMetadata(organizationId, 'other', { env: 'dev' });

    await withTenant(db, organizationId, (trx) =>
      repository.updateMetadata(trx, main.withMetadata({ env: 'staging' })),
    );
    const other = await withTenant(db, organizationId, (trx) =>
      repository.findByName(trx, 'other'),
    );

    expect(other?.metadata.entries).toEqual({ env: 'dev' });
  });

  it('throws, and changes nothing, for a ledger of another organization', async () => {
    const owner = ids.next();
    const stranger = ids.next();
    const saved = await insertWithMetadata(owner, 'main', { env: 'prod' });

    // The stranger's transaction cannot see the row, so 0 rows are updated.
    await expect(
      withTenant(db, stranger, (trx) =>
        repository.updateMetadata(trx, saved.withMetadata({ env: 'hacked' })),
      ),
    ).rejects.toThrow('Expected to update 1 ledger row, but updated 0');

    const found = await withTenant(db, owner, (trx) => repository.findByName(trx, 'main'));
    expect(found?.metadata.entries).toEqual({ env: 'prod' });
  });

  it('throws for a ledger that was never saved', async () => {
    const organizationId = ids.next();

    await expect(
      withTenant(db, organizationId, (trx) =>
        repository.updateMetadata(trx, makeLedger(organizationId, 'main')),
      ),
    ).rejects.toThrow('Expected to update 1 ledger row, but updated 0');
  });
});

describe('KyselyLedgerRepository.findPage', () => {
  /** Saves one ledger per name, in this order. */
  const saveAll = (organizationId: string, names: string[]) =>
    withTenant(db, organizationId, async (trx) => {
      for (const name of names) {
        await repository.insert(trx, makeLedger(organizationId, name));
      }
    });

  const readPage = (organizationId: string, query: ILedgerPageQuery) =>
    withTenant(db, organizationId, (trx) => repository.findPage(trx, query));

  const namesOf = (page: ILedgerPage) => page.ledgers.map((ledger) => ledger.name);

  it('loads the ledgers with all their fields', async () => {
    const organizationId = ids.next();
    const saved = Ledger.create({
      id: ids.next(),
      organizationId,
      name: 'main',
      metadata: Metadata.of({ env: 'prod', team: 'payments' }),
      createdAt: new Date('2026-11-04T10:00:00.123Z'),
    });
    await withTenant(db, organizationId, (trx) => repository.insert(trx, saved));

    const page = await readPage(organizationId, { limit: 10 });

    expect(page.ledgers).toHaveLength(1);
    const [found] = page.ledgers;
    expect(found).toBeInstanceOf(Ledger);
    expect(found?.id).toBe(saved.id);
    expect(found?.organizationId).toBe(organizationId);
    expect(found?.name).toBe('main');
    expect(found?.metadata.entries).toEqual({ env: 'prod', team: 'payments' });
    expect(found?.createdAt).toEqual(saved.createdAt);
  });

  it('sorts by name, whatever the order the ledgers were saved in', async () => {
    const organizationId = ids.next();
    await saveAll(organizationId, ['gamma', 'alpha', 'beta']);

    const page = await readPage(organizationId, { limit: 10 });

    expect(namesOf(page)).toEqual(['alpha', 'beta', 'gamma']);
    expect(page.hasMore).toBe(false);
  });

  it('returns an empty page when the organization has no ledgers', async () => {
    const page = await readPage(ids.next(), { limit: 10 });

    expect(page).toEqual({ ledgers: [], hasMore: false });
  });

  it('returns at most `limit` ledgers and says there are more', async () => {
    const organizationId = ids.next();
    await saveAll(organizationId, ['alpha', 'beta', 'gamma']);

    const page = await readPage(organizationId, { limit: 2 });

    expect(namesOf(page)).toEqual(['alpha', 'beta']);
    expect(page.hasMore).toBe(true);
  });

  it('says there is nothing more when the page holds exactly the rest', async () => {
    const organizationId = ids.next();
    await saveAll(organizationId, ['alpha', 'beta', 'gamma']);

    const exact = await readPage(organizationId, { limit: 3 });
    const roomToSpare = await readPage(organizationId, { limit: 5 });

    expect(namesOf(exact)).toEqual(['alpha', 'beta', 'gamma']);
    expect(exact.hasMore).toBe(false);
    expect(roomToSpare.hasMore).toBe(false);
  });

  it('starts after the given name and does not include it', async () => {
    const organizationId = ids.next();
    await saveAll(organizationId, ['alpha', 'beta', 'gamma']);

    const page = await readPage(organizationId, { limit: 10, afterName: 'alpha' });

    expect(namesOf(page)).toEqual(['beta', 'gamma']);
  });

  it('accepts a position that no ledger has', async () => {
    const organizationId = ids.next();
    await saveAll(organizationId, ['alpha', 'beta', 'gamma']);

    // "b" comes before "beta", and no ledger is called "b".
    const page = await readPage(organizationId, { limit: 10, afterName: 'b' });

    expect(namesOf(page)).toEqual(['beta', 'gamma']);
  });

  it('returns an empty page after the last name', async () => {
    const organizationId = ids.next();
    await saveAll(organizationId, ['alpha', 'beta']);

    const page = await readPage(organizationId, { limit: 10, afterName: 'beta' });

    expect(page).toEqual({ ledgers: [], hasMore: false });
  });

  it('does not return the ledgers of other organizations', async () => {
    const owner = ids.next();
    const other = ids.next();
    await saveAll(owner, ['alpha', 'beta']);
    await saveAll(other, ['gamma']);

    const page = await readPage(other, { limit: 10 });

    expect(namesOf(page)).toEqual(['gamma']);
  });

  it('reads every ledger once when the pages are followed one by one', async () => {
    const organizationId = ids.next();
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    await saveAll(organizationId, names);

    const pages: string[][] = [];
    let afterName: string | undefined;
    for (;;) {
      const page = await readPage(organizationId, { limit: 2, afterName });
      pages.push(namesOf(page));
      if (!page.hasMore) break;
      afterName = page.ledgers.at(-1)?.name;
    }

    expect(pages).toEqual([['alpha', 'beta'], ['delta', 'epsilon'], ['gamma']]);
  });

  it('does not repeat a ledger when others are added between two pages', async () => {
    const organizationId = ids.next();
    await saveAll(organizationId, ['b', 'd', 'f']);

    const first = await readPage(organizationId, { limit: 2 });
    // One ledger before the position, and one after it.
    await saveAll(organizationId, ['a', 'e']);
    const second = await readPage(organizationId, { limit: 2, afterName: 'd' });

    expect(namesOf(first)).toEqual(['b', 'd']);
    expect(namesOf(second)).toEqual(['e', 'f']);
  });
});

describe('KyselyLedgerRepository.markDeleted', () => {
  const insertMain = async (organizationId: string, name = 'main') => {
    const ledger = makeLedger(organizationId, name);
    await withTenant(db, organizationId, (trx) => repository.insert(trx, ledger));
    return ledger;
  };

  const readDeletedAt = (organizationId: string, id: string) =>
    withTenant(db, organizationId, (trx) =>
      unwrapTenantTransaction(trx)
        .selectFrom('ledgers')
        .select(['deleted_at', 'metadata', 'name'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );

  it('saves the time of the delete and changes nothing else', async () => {
    const organizationId = ids.next();
    const ledger = await insertMain(organizationId);
    const deletedAt = new Date('2026-11-22T10:00:00.123Z');

    await withTenant(db, organizationId, (trx) => repository.markDeleted(trx, ledger, deletedAt));

    const row = await readDeletedAt(organizationId, ledger.id);
    expect(row.deleted_at).toEqual(deletedAt);
    expect(row.name).toBe('main');
    expect(row.metadata).toEqual({});
  });

  it('does not change another ledger of the same organization', async () => {
    const organizationId = ids.next();
    const gone = await insertMain(organizationId, 'gone');
    const kept = await insertMain(organizationId, 'kept');

    await withTenant(db, organizationId, (trx) => repository.markDeleted(trx, gone, new Date()));

    expect((await readDeletedAt(organizationId, kept.id)).deleted_at).toBeNull();
  });

  it('throws, and changes nothing, for a ledger of another organization', async () => {
    const owner = ids.next();
    const other = ids.next();
    const ledger = await insertMain(owner);

    await expect(
      withTenant(db, other, (trx) => repository.markDeleted(trx, ledger, new Date())),
    ).rejects.toThrow('Expected to delete 1 ledger row, but updated 0');

    expect((await readDeletedAt(owner, ledger.id)).deleted_at).toBeNull();
  });

  it('throws for a ledger that was never saved', async () => {
    const organizationId = ids.next();

    await expect(
      withTenant(db, organizationId, (trx) =>
        repository.markDeleted(trx, makeLedger(organizationId, 'ghost'), new Date()),
      ),
    ).rejects.toThrow('Expected to delete 1 ledger row, but updated 0');
  });

  it('throws when the ledger is already deleted, and keeps the first time', async () => {
    const organizationId = ids.next();
    const ledger = await insertMain(organizationId);
    const first = new Date('2026-11-22T10:00:00.000Z');
    await withTenant(db, organizationId, (trx) => repository.markDeleted(trx, ledger, first));

    await expect(
      withTenant(db, organizationId, (trx) =>
        repository.markDeleted(trx, ledger, new Date('2026-11-23T10:00:00.000Z')),
      ),
    ).rejects.toThrow('Expected to delete 1 ledger row, but updated 0');

    expect((await readDeletedAt(organizationId, ledger.id)).deleted_at).toEqual(first);
  });

  it('rolls back with the transaction, so the ledger stays live', async () => {
    const organizationId = ids.next();
    const ledger = await insertMain(organizationId);

    await expect(
      withTenant(db, organizationId, async (trx) => {
        await repository.markDeleted(trx, ledger, new Date());
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');

    expect((await readDeletedAt(organizationId, ledger.id)).deleted_at).toBeNull();
    const found = await withTenant(db, organizationId, (trx) => repository.findByName(trx, 'main'));
    expect(found?.id).toBe(ledger.id);
  });
});

describe('KyselyLedgerRepository with a deleted ledger', () => {
  /** Saves a ledger and deletes it, in two steps like the app. */
  const insertDeleted = async (organizationId: string, name: string) => {
    const ledger = makeLedger(organizationId, name);
    await withTenant(db, organizationId, (trx) => repository.insert(trx, ledger));
    await withTenant(db, organizationId, (trx) => repository.markDeleted(trx, ledger, new Date()));
    return ledger;
  };

  it('findByName returns null', async () => {
    const organizationId = ids.next();
    await insertDeleted(organizationId, 'main');

    const found = await withTenant(db, organizationId, (trx) => repository.findByName(trx, 'main'));

    expect(found).toBeNull();
  });

  it('findByNameForUpdate returns null', async () => {
    const organizationId = ids.next();
    await insertDeleted(organizationId, 'main');

    const found = await withTenant(db, organizationId, (trx) =>
      repository.findByNameForUpdate(trx, 'main'),
    );

    expect(found).toBeNull();
  });

  it('findPage leaves it out and still finds the others', async () => {
    const organizationId = ids.next();
    await insertDeleted(organizationId, 'b-gone');
    await withTenant(db, organizationId, async (trx) => {
      await repository.insert(trx, makeLedger(organizationId, 'a-live'));
      await repository.insert(trx, makeLedger(organizationId, 'c-live'));
    });

    const page = await withTenant(db, organizationId, (trx) =>
      repository.findPage(trx, { limit: 10 }),
    );

    expect(page.ledgers.map((ledger) => ledger.name)).toEqual(['a-live', 'c-live']);
    expect(page.hasMore).toBe(false);
  });

  it('findPage counts only live ledgers for hasMore and for the page size', async () => {
    const organizationId = ids.next();
    await withTenant(db, organizationId, (trx) =>
      repository.insert(trx, makeLedger(organizationId, 'a-live')),
    );
    await insertDeleted(organizationId, 'b-gone');

    const page = await withTenant(db, organizationId, (trx) =>
      repository.findPage(trx, { limit: 1 }),
    );

    expect(page.ledgers.map((ledger) => ledger.name)).toEqual(['a-live']);
    expect(page.hasMore).toBe(false); // the deleted one must not make a next page
  });

  it('findPage accepts the name of a deleted ledger as the position', async () => {
    const organizationId = ids.next();
    await withTenant(db, organizationId, (trx) =>
      repository.insert(trx, makeLedger(organizationId, 'a-live')),
    );
    await insertDeleted(organizationId, 'b-gone');
    await withTenant(db, organizationId, (trx) =>
      repository.insert(trx, makeLedger(organizationId, 'c-live')),
    );

    const page = await withTenant(db, organizationId, (trx) =>
      repository.findPage(trx, { limit: 10, afterName: 'b-gone' }),
    );

    expect(page.ledgers.map((ledger) => ledger.name)).toEqual(['c-live']);
  });

  it('insert still says the name exists, so it can never be used again', async () => {
    const organizationId = ids.next();
    await insertDeleted(organizationId, 'main');

    await expect(
      withTenant(db, organizationId, (trx) =>
        repository.insert(trx, makeLedger(organizationId, 'main')),
      ),
    ).rejects.toBeInstanceOf(LedgerAlreadyExistsError);
  });

  it('insert lets another organization use the name of a deleted ledger', async () => {
    const owner = ids.next();
    const other = ids.next();
    await insertDeleted(owner, 'main');

    await withTenant(db, other, (trx) => repository.insert(trx, makeLedger(other, 'main')));

    const found = await withTenant(db, other, (trx) => repository.findByName(trx, 'main'));
    expect(found?.name).toBe('main');
  });

  it('a locking read that waits for a delete returns null when the delete commits', async () => {
    const organizationId = ids.next();
    const ledger = makeLedger(organizationId, 'main');
    await withTenant(db, organizationId, (trx) => repository.insert(trx, ledger));

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const deleting = withTenant(db, organizationId, async (trx) => {
      await repository.findByNameForUpdate(trx, 'main');
      await repository.markDeleted(trx, ledger, new Date());
      locked();
      await released; // the delete is not committed yet, and it holds the lock
    });
    await Promise.race([lockTaken, deleting]);

    const waiting = withTenant(db, organizationId, (trx) =>
      repository.findByNameForUpdate(trx, 'main'),
    );
    await new Promise((resolve) => setTimeout(resolve, 150)); // let it reach the lock
    release();
    await deleting;

    // Row-level re-check: the row it waited for no longer matches, so it is "not found".
    await expect(waiting).resolves.toBeNull();
  });
});
