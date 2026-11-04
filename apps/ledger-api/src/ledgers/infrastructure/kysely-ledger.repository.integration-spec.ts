import { createDb, SqlState, withTenant, type LedgerDatabase } from '@ledger/database/storage';
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
