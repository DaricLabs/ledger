import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import type { INestApplication } from '@nestjs/common';
import { unwrapTenantTransaction, withTenant, type LedgerDatabase } from '@ledger/database/storage';
import { KYSELY_DB } from '../core/database/database.tokens.js';
import { LEDGER_LOG_WRITER } from './application/ports/ledger-log-writer.port.js';
import { CreateLedgerUseCase } from './application/use-cases/create-ledger.use-case.js';
import { GetLedgerUseCase } from './application/use-cases/get-ledger.use-case.js';
import { ListLedgersUseCase } from './application/use-cases/list-ledgers.use-case.js';
import { LedgerAlreadyExistsError } from './domain/ledger-already-exists.error.js';
import { LedgerNotFoundError } from './domain/ledger-not-found.error.js';
import { Uuidv7IdGenerator } from './infrastructure/uuidv7-id-generator.js';
import { LedgersModule } from './ledgers.module.js';

// Every test uses new organization ids, so tests never see each other's rows
// and nothing has to be cleaned up (the append-only tables cannot be cleaned anyway).
const newOrganizationId = () => new Uuidv7IdGenerator().next();

async function buildApp(
  customize?: (builder: ReturnType<typeof Test.createTestingModule>) => void,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ LEDGER_RUNTIME_DATABASE_URL: process.env.LEDGER_RUNTIME_DATABASE_URL })],
      }),
      // The controller uses TenantGuard, and the guard needs PinoLogger.
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      LedgersModule,
    ],
  });
  customize?.(builder);
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return app;
}

describe('LedgersModule (real database)', () => {
  let app: INestApplication;
  let db: LedgerDatabase;
  let createLedger: CreateLedgerUseCase;
  let getLedger: GetLedgerUseCase;
  let listLedgers: ListLedgersUseCase;

  beforeAll(async () => {
    app = await buildApp();
    db = app.get<LedgerDatabase>(KYSELY_DB);
    createLedger = app.get(CreateLedgerUseCase);
    getLedger = app.get(GetLedgerUseCase);
    listLedgers = app.get(ListLedgersUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Reads the three tables the way the API would: as one tenant, with row-level security on. */
  const readState = (organizationId: string) =>
    withTenant(db, organizationId, async (trx) => {
      const k = unwrapTenantTransaction(trx);
      return {
        ledgers: await k.selectFrom('ledgers').selectAll().execute(),
        logs: await k.selectFrom('ledger_logs').selectAll().orderBy('seq').execute(),
        events: await k.selectFrom('outbox_events').selectAll().execute(),
      };
    });

  it('saves the ledger, its first log and its outbox event together', async () => {
    const organizationId = newOrganizationId();

    const ledger = await createLedger.execute({
      organizationId,
      name: 'main',
      metadata: { env: 'prod' },
    });
    const { ledgers, logs, events } = await readState(organizationId);

    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]).toMatchObject({
      id: ledger.id,
      organization_id: organizationId,
      name: 'main',
      metadata: { env: 'prod' },
      last_log_seq: '1', // one log was written
    });
    expect(ledgers[0]?.created_at).toEqual(ledger.createdAt);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organization_id: organizationId,
      ledger_id: ledger.id,
      seq: '1', // the trigger assigned it
      type: 'LEDGER_CREATED',
      payload: { name: 'main', metadata: { env: 'prod' } },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organization_id: organizationId,
      ledger_id: ledger.id,
      aggregate_type: 'ledger',
      aggregate_id: ledger.id,
      event_type: 'ledger.created',
      event_version: 1,
      published_at: null, // the relay worker has not published it yet
      payload: {
        ledgerId: ledger.id,
        organizationId,
        name: 'main',
        metadata: { env: 'prod' },
        createdAt: ledger.createdAt.toISOString(),
      },
    });
  });

  it('rejects a second ledger with the same name in the same organization', async () => {
    const organizationId = newOrganizationId();
    await createLedger.execute({ organizationId, name: 'main', metadata: {} });

    await expect(
      createLedger.execute({ organizationId, name: 'main', metadata: {} }),
    ).rejects.toBeInstanceOf(LedgerAlreadyExistsError);

    // The failed attempt left nothing behind.
    const { ledgers, logs, events } = await readState(organizationId);
    expect([ledgers.length, logs.length, events.length]).toEqual([1, 1, 1]);
  });

  it('allows the same ledger name in another organization', async () => {
    const first = newOrganizationId();
    const second = newOrganizationId();

    await createLedger.execute({ organizationId: first, name: 'main', metadata: {} });

    await expect(
      createLedger.execute({ organizationId: second, name: 'main', metadata: {} }),
    ).resolves.toBeDefined();
  });

  it('does not show one organization the rows of another', async () => {
    const owner = newOrganizationId();
    const other = newOrganizationId();
    await createLedger.execute({ organizationId: owner, name: 'main', metadata: {} });

    const state = await readState(other);

    expect([state.ledgers.length, state.logs.length, state.events.length]).toEqual([0, 0, 0]);
  });

  describe('getting a ledger', () => {
    it('returns the ledger that was created', async () => {
      const organizationId = newOrganizationId();
      const created = await createLedger.execute({
        organizationId,
        name: 'main',
        metadata: { env: 'prod' },
      });

      const found = await getLedger.execute({ organizationId, name: 'main' });

      expect(found.id).toBe(created.id);
      expect(found.metadata).toEqual({ env: 'prod' });
      expect(found.createdAt).toEqual(created.createdAt);
    });

    it('throws LedgerNotFoundError for a name the organization does not have', async () => {
      await expect(
        getLedger.execute({ organizationId: newOrganizationId(), name: 'main' }),
      ).rejects.toBeInstanceOf(LedgerNotFoundError);
    });

    it('throws LedgerNotFoundError for the ledger of another organization', async () => {
      const owner = newOrganizationId();
      await createLedger.execute({ organizationId: owner, name: 'main', metadata: {} });

      await expect(
        getLedger.execute({ organizationId: newOrganizationId(), name: 'main' }),
      ).rejects.toBeInstanceOf(LedgerNotFoundError);
    });

    it('does not write any log or outbox event', async () => {
      const organizationId = newOrganizationId();
      await createLedger.execute({ organizationId, name: 'main', metadata: {} });

      await getLedger.execute({ organizationId, name: 'main' });
      const { logs, events } = await readState(organizationId);

      expect([logs.length, events.length]).toEqual([1, 1]); // only the ones from create
    });
  });

  describe('listing ledgers', () => {
    const createAll = async (organizationId: string, names: string[]) => {
      for (const name of names) {
        await createLedger.execute({ organizationId, name, metadata: {} });
      }
    };

    it('returns the ledgers that were created, sorted by name', async () => {
      const organizationId = newOrganizationId();
      await createAll(organizationId, ['gamma', 'alpha', 'beta']);

      const page = await listLedgers.execute({ organizationId, pageSize: 10 });

      expect(page.ledgers.map((ledger) => ledger.name)).toEqual(['alpha', 'beta', 'gamma']);
      expect(page.hasMore).toBe(false);
    });

    it('gives the next page when the last name of the page is used as the position', async () => {
      const organizationId = newOrganizationId();
      await createAll(organizationId, ['alpha', 'beta', 'gamma']);

      const first = await listLedgers.execute({ organizationId, pageSize: 2 });
      const second = await listLedgers.execute({
        organizationId,
        pageSize: 2,
        afterName: first.ledgers.at(-1)?.name,
      });

      expect(first.hasMore).toBe(true);
      expect(second.ledgers.map((ledger) => ledger.name)).toEqual(['gamma']);
      expect(second.hasMore).toBe(false);
    });

    it('returns an empty page for an organization with no ledgers, even when others have some', async () => {
      await createAll(newOrganizationId(), ['main']);

      const page = await listLedgers.execute({ organizationId: newOrganizationId(), pageSize: 10 });

      expect(page).toEqual({ ledgers: [], hasMore: false });
    });

    it('does not write any log or outbox event', async () => {
      const organizationId = newOrganizationId();
      await createAll(organizationId, ['alpha', 'beta']);

      await listLedgers.execute({ organizationId, pageSize: 10 });
      const { logs, events } = await readState(organizationId);

      expect([logs.length, events.length]).toEqual([2, 2]); // only the ones from the two creates
    });
  });

  describe('when a step fails after the ledger row was written', () => {
    let failingApp: INestApplication;

    beforeAll(async () => {
      failingApp = await buildApp((builder) => {
        builder
          .overrideProvider(LEDGER_LOG_WRITER)
          .useValue({ append: () => Promise.reject(new Error('log write failed')) });
      });
    });

    afterAll(async () => {
      await failingApp.close();
    });

    it('rolls everything back, so no ledger row stays', async () => {
      const organizationId = newOrganizationId();

      await expect(
        failingApp.get(CreateLedgerUseCase).execute({ organizationId, name: 'main', metadata: {} }),
      ).rejects.toThrow('log write failed');

      // Read with the healthy app. The pools are separate, so this also proves it was never committed.
      const { ledgers, logs, events } = await readState(organizationId);
      expect([ledgers.length, logs.length, events.length]).toEqual([0, 0, 0]);
    });
  });
});
