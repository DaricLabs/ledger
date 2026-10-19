import { sql, type Kysely } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb } from '../support/db.js';
import { uuidv7 } from '../support/uuidv7.js';

// Values are cast to each domain directly (`$1::domain`), so these tests check
// the domain rules alone, with no table or tenant needed.

const UINT256_MAX = (2n ** 256n - 1n).toString(); // 78 digits
const CHECK_VIOLATION = '23514';
const NUMERIC_OVERFLOW = '22003';

interface DomainCase {
  domain: string;
  valid: unknown[];
  invalid: unknown[];
}

const CASES: DomainCase[] = [
  {
    domain: 'uuidv7',
    valid: [uuidv7(), '0190a5d4-7b3c-7abc-8def-0123456789ab'],
    invalid: [
      '5f1c2e0e-3f55-4a3c-9d6b-3f2d6c2d8a11', // version 4
      '00000000-0000-0000-0000-000000000000', // nil UUID
      '0190a5d4-7b3c-7abc-cdef-0123456789ab', // wrong variant bits
    ],
  },
  {
    domain: 'ledger_name',
    valid: ['main', 'a', 'my-ledger_2', 'a'.repeat(63)],
    invalid: ['', 'Main', '-main', '_main', 'my ledger', 'my.ledger', 'a'.repeat(64)],
  },
  {
    domain: 'account_address',
    valid: ['world', 'users:1', 'platform:fees', 'a:b:c', 'a'.repeat(256)],
    invalid: [
      '',
      'Users:1',
      ':users',
      'users:',
      'users::1',
      'users:-1',
      'users 1',
      'a'.repeat(257),
    ],
  },
  {
    domain: 'asset_code',
    valid: ['USD', 'EUR', 'USDC', 'BTC', 'A1B', 'A'.repeat(16)],
    invalid: ['', 'US', 'usd', 'U$D', '1USD', 'A'.repeat(17)],
  },
  {
    domain: 'event_type',
    valid: ['ledger.transaction.created', 'a.b', 'ledger_v2.account.updated'],
    invalid: [
      '',
      'ledger',
      'Ledger.created',
      'ledger..created',
      '.created',
      'ledger.',
      `a.${'b'.repeat(127)}`,
    ],
  },
  {
    domain: 'operation_name',
    valid: ['transactions.create', 'a.b', 'ledgers.metadata.update'],
    invalid: [
      '',
      'transactions',
      'Transactions.create',
      'transactions-create',
      `a.${'b'.repeat(127)}`,
    ],
  },
  {
    domain: 'json_obj',
    valid: ['{}', '{"a":1}', '{"nested":{"a":[1,2]}}'],
    invalid: ['[]', '[{"a":1}]', '"text"', '1', 'true', 'null'],
  },
  {
    domain: 'money_amount_positive',
    valid: ['1', '100', UINT256_MAX],
    invalid: ['0', '-1', '-100'],
  },
  {
    domain: 'sha256_digest',
    valid: [Buffer.alloc(32, 1)],
    invalid: [Buffer.alloc(0), Buffer.alloc(31, 1), Buffer.alloc(33, 1)],
  },
];

describe('domains', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb(2);
  });

  afterAll(async () => {
    await db.destroy();
  });

  function castTo(domain: string, value: unknown) {
    return sql`select ${value}::${sql.id(domain)} as value`.execute(db);
  }

  describe.each(CASES)('$domain', ({ domain, valid, invalid }) => {
    it.each(valid.map((v) => [describeValue(v), v]))('accepts %s', async (_label, value) => {
      await expect(castTo(domain, value)).resolves.toBeDefined();
    });

    it.each(invalid.map((v) => [describeValue(v), v]))('rejects %s', async (_label, value) => {
      await expect(castTo(domain, value)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  describe('money_amount_positive and money_balance', () => {
    it('does not fit a number with more than 78 digits', async () => {
      const tooBig = (10n ** 78n).toString(); // 79 digits

      await expect(castTo('money_amount_positive', tooBig)).rejects.toMatchObject({
        code: NUMERIC_OVERFLOW,
      });
      await expect(castTo('money_balance', tooBig)).rejects.toMatchObject({
        code: NUMERIC_OVERFLOW,
      });
    });

    it('allows negative values for money_balance (overdraft)', async () => {
      const { rows } = await sql<{ value: string }>`
        select ${'-100'}::money_balance as value
      `.execute(db);

      expect(rows[0].value).toBe('-100');
    });

    it('rounds fractions BEFORE the check, so the DB cannot reject them (API must)', async () => {
      // Documented in 0001_init.sql. These tests pin the behavior so nobody
      // relies on the database to reject fractional amounts.
      const { rows } = await sql<{ value: string }>`
        select ${'1.5'}::money_amount_positive as value
      `.execute(db);

      expect(rows[0].value).toBe('2');
      await expect(castTo('money_amount_positive', '0.4')).rejects.toMatchObject({
        code: CHECK_VIOLATION, // rounds to 0, which fails "> 0"
      });
    });
  });
});

function describeValue(value: unknown): string {
  if (Buffer.isBuffer(value)) return `${value.length} bytes`;
  const text = String(value);
  return text.length > 40
    ? `${JSON.stringify(text.slice(0, 20))}… (${text.length} chars)`
    : JSON.stringify(text);
}
