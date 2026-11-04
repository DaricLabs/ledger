import { createDb, SqlState, withTenant, type LedgerDatabase } from '@ledger/database/storage';
import type { ILedgerPage, ILedgerPageQuery } from '../application/ports/ledger-repository.port.js';
import { LedgerAlreadyExistsError } from '../domain/ledger-already-exists.error.js';
import { Ledger } from '../domain/ledger.entity.js';
import { KyselyLedgerRepository } from './kysely-ledger.repository.js';
import { Uuidv7IdGenerator } from './uuidv7-id-generator.js';

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
  Ledger.create({ id, organizationId, name, metadata: {}, createdAt: new Date() });

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
      metadata: { env: 'prod', team: 'payments' },
      createdAt: new Date('2026-11-04T10:00:00.123Z'),
    });
    await withTenant(db, organizationId, (trx) => repository.insert(trx, saved));

    const found = await withTenant(db, organizationId, (trx) => repository.findByName(trx, 'main'));

    expect(found).toBeInstanceOf(Ledger);
    expect(found?.id).toBe(saved.id);
    expect(found?.organizationId).toBe(organizationId);
    expect(found?.name).toBe('main');
    expect(found?.metadata).toEqual({ env: 'prod', team: 'payments' });
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
      metadata: { env: 'prod', team: 'payments' },
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
    expect(found?.metadata).toEqual({ env: 'prod', team: 'payments' });
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
