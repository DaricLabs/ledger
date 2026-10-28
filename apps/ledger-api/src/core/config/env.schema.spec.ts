import { LOG_LEVELS } from '../logging/log-levels.js';
import { envSchema } from './env.schema.js';

const databaseUrl = 'postgres://ledger_runtime:secret-pass@localhost:5432/ledger';

describe('envSchema', () => {
  it('accepts a valid environment and uses the defaults', () => {
    const env = envSchema.parse({ LEDGER_RUNTIME_DATABASE_URL: databaseUrl });

    expect(env).toEqual({
      PORT: 3000,
      LEDGER_RUNTIME_DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
    });
  });

  it('accepts the postgresql:// scheme', () => {
    const url = 'postgresql://ledger_runtime:secret-pass@localhost:5432/ledger';

    expect(envSchema.safeParse({ LEDGER_RUNTIME_DATABASE_URL: url }).success).toBe(true);
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
    const url = 'http://ledger_runtime:secret-pass@localhost:5432/ledger';

    expect(envSchema.safeParse({ LEDGER_RUNTIME_DATABASE_URL: url }).success).toBe(false);
  });

  it('rejects a text that is not a URL, with one issue only', () => {
    const result = envSchema.safeParse({ LEDGER_RUNTIME_DATABASE_URL: 'not a url' });

    expect(result.error?.issues).toHaveLength(1);
  });

  it.each([
    ['ledger_migrator', 'postgres://ledger_migrator:secret-pass@localhost:5432/ledger'],
    ['postgres', 'postgres://postgres:secret-pass@localhost:5432/ledger'],
    ['no user', 'postgres://localhost:5432/ledger'],
  ])('rejects a URL with the wrong role (%s)', (_name, url) => {
    const result = envSchema.safeParse({ LEDGER_RUNTIME_DATABASE_URL: url });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('must connect as the ledger_runtime role');
  });

  it('never puts the password in the error message', () => {
    const url = 'postgres://ledger_migrator:secret-pass@localhost:5432/ledger';
    const result = envSchema.safeParse({ LEDGER_RUNTIME_DATABASE_URL: url });

    expect(JSON.stringify(result.error?.issues)).not.toContain('secret-pass');
  });

  it.each(['0', '65536', '3000.5', 'abc', ''])('rejects PORT=%j', (port) => {
    const result = envSchema.safeParse({ LEDGER_RUNTIME_DATABASE_URL: databaseUrl, PORT: port });

    expect(result.success).toBe(false);
  });

  describe('LOG_LEVEL', () => {
    // runs once per allowed level
    it.each(LOG_LEVELS)('accepts %s', (level) => {
      const env = envSchema.parse({ LEDGER_RUNTIME_DATABASE_URL: databaseUrl, LOG_LEVEL: level });

      expect(env.LOG_LEVEL).toBe(level);
    });

    // wrong case and empty text must fail, like your PORT='' test
    it.each(['verbose', 'INFO', ''])('rejects %j', (level) => {
      const result = envSchema.safeParse({
        LEDGER_RUNTIME_DATABASE_URL: databaseUrl,
        LOG_LEVEL: level,
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['LOG_LEVEL']);
    });
  });

  describe('LOG_PRETTY', () => {
    it.each([
      ['true', true],
      ['false', false],
    ])('turns %j into %s', (text, expected) => {
      const env = envSchema.parse({ LEDGER_RUNTIME_DATABASE_URL: databaseUrl, LOG_PRETTY: text });

      expect(env.LOG_PRETTY).toBe(expected);
    });

    // only the exact words "true" and "false" are allowed
    it.each(['1', 'yes', 'TRUE', ''])('rejects %j', (text) => {
      const result = envSchema.safeParse({
        LEDGER_RUNTIME_DATABASE_URL: databaseUrl,
        LOG_PRETTY: text,
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['LOG_PRETTY']);
    });
  });
});
