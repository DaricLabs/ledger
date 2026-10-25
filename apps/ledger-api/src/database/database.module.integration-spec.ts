import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { LedgerDatabase } from '@ledger/database/storage';
import { KYSELY_DB } from './database.tokens.js';
import { DatabaseModule } from './database.module.js';

const superuserUrl =
  process.env.TEST_LEDGER_SUPERUSER_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5433/ledger';

// A plain ConfigModule (no env schema), so a wrong role can reach the role check.
const configFor = (url: string) =>
  ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    load: [() => ({ LEDGER_RUNTIME_DATABASE_URL: url })],
  });

describe('DatabaseModule', () => {
  it('destroys the pool when the app closes', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [configFor(process.env.LEDGER_RUNTIME_DATABASE_URL!), DatabaseModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const db = app.get<LedgerDatabase>(KYSELY_DB);
    // Without a tenant, row-level security returns no rows, but the query must work.
    await expect(db.selectFrom('ledgers').select('id').limit(1).execute()).resolves.toEqual([]);

    await app.close();
    await expect(db.selectFrom('ledgers').select('id').limit(1).execute()).rejects.toThrow();
  });

  it('refuses to start when connected as a superuser', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [configFor(superuserUrl), DatabaseModule],
    }).compile();
    const app = moduleRef.createNestApplication();

    await expect(app.init()).rejects.toThrow('must not be a superuser');
  });
});
