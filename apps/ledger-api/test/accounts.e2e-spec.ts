import { randomUUIDv7 } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { ORGANIZATION_ID_HEADER } from '../src/core/tenant/tenant.guard.js';

describe('accounts (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // Every test uses a new organization id, so tests never see each other's
  // ledgers and nothing has to be cleaned up (the log tables are append-only).
  const createLedger = (organizationId: string, name = 'main') =>
    request(app.getHttpServer())
      .post('/ledgers')
      .set(ORGANIZATION_ID_HEADER, organizationId)
      .send({ name })
      .expect(201);

  const move = (
    organizationId: string,
    source: string,
    destination: string,
    amount: string,
    { asset = 'USD', ledger = 'main' } = {},
  ) =>
    request(app.getHttpServer())
      .post(`/ledgers/${ledger}/transactions`)
      .set(ORGANIZATION_ID_HEADER, organizationId)
      .send({ postings: [{ source, destination, asset, amount }] });

  const getAccount = (organizationId: string, address: string, ledger = 'main') =>
    request(app.getHttpServer())
      .get(`/ledgers/${ledger}/accounts/${address}`)
      .set(ORGANIZATION_ID_HEADER, organizationId);

  const listAccounts = (organizationId: string, query = '', ledger = 'main') =>
    request(app.getHttpServer())
      .get(`/ledgers/${ledger}/accounts${query}`)
      .set(ORGANIZATION_ID_HEADER, organizationId);

  it('gets an account with what it holds', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    await move(organizationId, 'world', 'users:1', '1050').expect(201);

    const res = await getAccount(organizationId, 'users:1').expect(200);

    expect(res.body).toEqual({
      address: 'users:1',
      allowOverdraft: false,
      balances: [{ asset: 'USD', amount: '1050' }],
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });
  });

  it('shows world below zero, and that only world may go below zero', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    await move(organizationId, 'world', 'users:1', '1050').expect(201);

    const res = await getAccount(organizationId, 'world').expect(200);

    expect(res.body).toMatchObject({
      address: 'world',
      allowOverdraft: true,
      balances: [{ asset: 'USD', amount: '-1050' }],
    });
  });

  it('follows the transactions: money in, money out', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    await move(organizationId, 'world', 'users:1', '1000').expect(201);
    await move(organizationId, 'users:1', 'users:2', '300').expect(201);

    const first = await getAccount(organizationId, 'users:1').expect(200);
    const second = await getAccount(organizationId, 'users:2').expect(200);

    expect(first.body.balances).toEqual([{ asset: 'USD', amount: '700' }]);
    expect(second.body.balances).toEqual([{ asset: 'USD', amount: '300' }]);
  });

  it('lists every asset the account holds, in the order of the asset codes', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    await move(organizationId, 'world', 'users:1', '5', { asset: 'USD' }).expect(201);
    await move(organizationId, 'world', 'users:1', '7', { asset: 'EUR' }).expect(201);

    const res = await getAccount(organizationId, 'users:1').expect(200);

    expect(res.body.balances).toEqual([
      { asset: 'EUR', amount: '7' },
      { asset: 'USD', amount: '5' },
    ]);
  });

  it('shows an account that gave away all its money, with a zero balance', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    await move(organizationId, 'world', 'users:1', '100').expect(201);
    await move(organizationId, 'users:1', 'users:2', '100').expect(201);

    const res = await getAccount(organizationId, 'users:1').expect(200);

    expect(res.body.balances).toEqual([{ asset: 'USD', amount: '0' }]);
  });

  it('reads an address whose colon is written as %3A', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    await move(organizationId, 'world', 'platform:fees:eu', '1').expect(201);

    const res = await getAccount(organizationId, 'platform%3Afees%3Aeu').expect(200);

    expect(res.body.address).toBe('platform:fees:eu');
  });

  it('returns 404 ACCOUNT_NOT_FOUND for an address no transaction has used', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);

    const res = await getAccount(organizationId, 'users:1').expect(404);

    expect(res.body).toEqual({
      errorCode: 'ACCOUNT_NOT_FOUND',
      errorMessage: 'Account not found in the ledger',
    });
  });

  it('does not make the accounts of a transaction that failed', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    await move(organizationId, 'users:1', 'users:2', '1').expect(422);

    await getAccount(organizationId, 'users:1').expect(404);
    await getAccount(organizationId, 'users:2').expect(404);
  });

  it('returns 404 LEDGER_NOT_FOUND for a ledger that does not exist', async () => {
    const res = await getAccount(randomUUIDv7(), 'users:1', 'missing').expect(404);

    expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
  });

  it('does not show the account of another ledger', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId, 'one');
    await createLedger(organizationId, 'two');
    await move(organizationId, 'world', 'users:1', '5', { ledger: 'one' }).expect(201);

    await getAccount(organizationId, 'users:1', 'one').expect(200);
    const res = await getAccount(organizationId, 'users:1', 'two').expect(404);

    expect(res.body.errorCode).toBe('ACCOUNT_NOT_FOUND');
  });

  it('does not show the account of another organization', async () => {
    const organizationId = randomUUIDv7();
    const otherOrganizationId = randomUUIDv7();
    await createLedger(organizationId);
    await createLedger(otherOrganizationId);
    await move(organizationId, 'world', 'users:1', '5').expect(201);

    const res = await getAccount(otherOrganizationId, 'users:1').expect(404);

    expect(res.body.errorCode).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns 400 VALIDATION for an address with a wrong shape', async () => {
    const res = await getAccount(randomUUIDv7(), 'Users:1').expect(400);

    expect(res.body.errorCode).toBe('VALIDATION');
  });

  it('returns 400 without the organization header', async () => {
    await request(app.getHttpServer()).get('/ledgers/main/accounts/users:1').expect(400);
  });

  describe('list', () => {
    it('lists the accounts sorted by address, each with what it holds', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      await move(organizationId, 'world', 'users:2', '7').expect(201);
      await move(organizationId, 'world', 'users:1', '5', { asset: 'EUR' }).expect(201);

      const res = await listAccounts(organizationId).expect(200);

      expect(res.body).toEqual({
        data: [
          {
            address: 'users:1',
            allowOverdraft: false,
            balances: [{ asset: 'EUR', amount: '5' }],
            createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
          },
          {
            address: 'users:2',
            allowOverdraft: false,
            balances: [{ asset: 'USD', amount: '7' }],
            createdAt: expect.any(String),
          },
          {
            address: 'world',
            allowOverdraft: true,
            balances: [
              { asset: 'EUR', amount: '-5' },
              { asset: 'USD', amount: '-7' },
            ],
            createdAt: expect.any(String),
          },
        ],
        hasMore: false,
      });
    });

    it('returns an empty page for a ledger with no accounts', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);

      const res = await listAccounts(organizationId).expect(200);

      expect(res.body).toEqual({ data: [], hasMore: false });
    });

    it('reads every account once when it follows "next" until hasMore is false', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      for (const address of ['users:1', 'users:2', 'users:3', 'users:4']) {
        await move(organizationId, 'world', address, '1').expect(201);
      }

      const addresses: string[] = [];
      let query = '?pageSize=2';
      let pages = 0;
      for (;;) {
        const res = await listAccounts(organizationId, query).expect(200);
        pages += 1;
        addresses.push(...res.body.data.map((account: { address: string }) => account.address));
        if (!res.body.hasMore) {
          expect(res.body).not.toHaveProperty('next');
          break;
        }
        query = `?pageSize=2&cursor=${res.body.next}`;
      }

      // `world` is made too, so there are 5 accounts: pages of 2, 2 and 1.
      expect(pages).toBe(3);
      expect(addresses).toEqual(['users:1', 'users:2', 'users:3', 'users:4', 'world']);
    });

    it('can go past an account with the longest address', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      const longest = 'a'.repeat(256);
      await move(organizationId, 'world', longest, '1').expect(201);
      await move(organizationId, 'world', 'z', '1').expect(201);

      const first = await listAccounts(organizationId, '?pageSize=1').expect(200);
      const second = await listAccounts(organizationId, `?cursor=${first.body.next}`).expect(200);

      expect(first.body.data[0].address).toBe(longest);
      expect(second.body.data.map((account: { address: string }) => account.address)).toEqual([
        'world',
        'z',
      ]);
    });

    it('returns 404 LEDGER_NOT_FOUND for a ledger that does not exist', async () => {
      const res = await listAccounts(randomUUIDv7(), '', 'missing').expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
    });

    it('does not list the accounts of another ledger or of another organization', async () => {
      const organizationId = randomUUIDv7();
      const otherOrganizationId = randomUUIDv7();
      await createLedger(organizationId, 'one');
      await createLedger(organizationId, 'two');
      await createLedger(otherOrganizationId, 'one');
      await move(organizationId, 'world', 'users:1', '5', { ledger: 'one' }).expect(201);

      const sameOrganization = await listAccounts(organizationId, '', 'two').expect(200);
      const otherOrganization = await listAccounts(otherOrganizationId, '', 'one').expect(200);

      expect(sameOrganization.body.data).toEqual([]);
      expect(otherOrganization.body.data).toEqual([]);
    });

    it.each([
      ['a pageSize of 0', '?pageSize=0'],
      ['a pageSize above 100', '?pageSize=101'],
      ['a cursor we did not give', '?cursor=hello'],
      ['an unknown parameter', '?pagesize=5'],
    ])('returns 400 VALIDATION for %s', async (_title, query) => {
      const res = await listAccounts(randomUUIDv7(), query).expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });

    it('returns 400 without the organization header', async () => {
      await request(app.getHttpServer()).get('/ledgers/main/accounts').expect(400);
    });
  });
});
