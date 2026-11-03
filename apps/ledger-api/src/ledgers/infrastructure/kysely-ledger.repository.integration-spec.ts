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
