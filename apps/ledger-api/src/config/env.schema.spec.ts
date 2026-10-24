import { envSchema } from './env.schema.js';

const databaseUrl = 'postgres://ledger_runtime:password@localhost:5432/ledger';

describe('envSchema', () => {
  it('accepts a valid environment and uses port 3000 by default', () => {
    const env = envSchema.parse({ LEDGER_RUNTIME_DATABASE_URL: databaseUrl });

    expect(env).toEqual({ PORT: 3000, LEDGER_RUNTIME_DATABASE_URL: databaseUrl });
  });

  it('turns the PORT string into a number', () => {
    const env = envSchema.parse({ LEDGER_RUNTIME_DATABASE_URL: databaseUrl, PORT: '8080' });

    expect(env.PORT).toBe(8080);
  });

  it('rejects a missing LEDGER_RUNTIME_DATABASE_URL', () => {
    const result = envSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['LEDGER_RUNTIME_DATABASE_URL']);
  });

  it('rejects a URL that is not a Postgres URL', () => {
    const result = envSchema.safeParse({
      LEDGER_RUNTIME_DATABASE_URL: 'http://localhost:5432/ledger',
    });

    expect(result.success).toBe(false);
  });

  it.each(['0', '65536', '3000.5', 'abc', ''])('rejects PORT=%j', (port) => {
    const result = envSchema.safeParse({ LEDGER_RUNTIME_DATABASE_URL: databaseUrl, PORT: port });

    expect(result.success).toBe(false);
  });
});
