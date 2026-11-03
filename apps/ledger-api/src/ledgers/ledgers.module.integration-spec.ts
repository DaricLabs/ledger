import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import type { INestApplication } from '@nestjs/common';
import { unwrapTenantTransaction, withTenant, type LedgerDatabase } from '@ledger/database/storage';
import { KYSELY_DB } from '../core/database/database.tokens.js';
import { LEDGER_LOG_WRITER } from './application/ports/ledger-log-writer.port.js';
import { CreateLedgerUseCase } from './application/use-cases/create-ledger.use-case.js';
import { LedgerAlreadyExistsError } from './domain/ledger-already-exists.error.js';
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

  beforeAll(async () => {
    app = await buildApp();
    db = app.get<LedgerDatabase>(KYSELY_DB);
    createLedger = app.get(CreateLedgerUseCase);
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
