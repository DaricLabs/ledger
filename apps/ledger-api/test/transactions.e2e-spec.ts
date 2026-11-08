import { randomUUIDv7 } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { ORGANIZATION_ID_HEADER } from '../src/core/tenant/tenant.guard.js';

describe('transactions (e2e)', () => {
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

  const createTransaction = (organizationId: string, body: object, ledger = 'main') =>
    request(app.getHttpServer())
      .post(`/ledgers/${ledger}/transactions`)
      .set(ORGANIZATION_ID_HEADER, organizationId)
      .send(body);

  const getTransaction = (organizationId: string, id: string, ledger = 'main') =>
    request(app.getHttpServer())
      .get(`/ledgers/${ledger}/transactions/${id}`)
      .set(ORGANIZATION_ID_HEADER, organizationId);

  const posting = (source: string, destination: string, amount: string) => ({
    source,
    destination,
    asset: 'USD',
    amount,
  });

  it('creates a transaction', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);

    const res = await createTransaction(organizationId, {
      reference: 'order-1',
      postings: [posting('world', 'users:1', '1050')],
    }).expect(201);

    expect(res.body).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      reference: 'order-1',
      postings: [{ source: 'world', destination: 'users:1', asset: 'USD', amount: '1050' }],
      postedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });
  });

  it('returns 404 LEDGER_NOT_FOUND for a ledger that does not exist', async () => {
    const res = await createTransaction(
      randomUUIDv7(),
      { postings: [posting('world', 'users:1', '1')] },
      'missing',
    ).expect(404);

    expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
  });

  it('returns 404 for the ledger of another organization', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);

    const res = await createTransaction(randomUUIDv7(), {
      postings: [posting('world', 'users:1', '1')],
    }).expect(404);

    expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
  });

  it('returns 422 INSUFFICIENT_FUNDS when an account spends more than it has', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    await createTransaction(organizationId, {
      postings: [posting('world', 'users:1', '100')],
    }).expect(201);

    const res = await createTransaction(organizationId, {
      postings: [posting('users:1', 'users:2', '101')],
    }).expect(422);

    expect(res.body).toEqual({
      errorCode: 'INSUFFICIENT_FUNDS',
      errorMessage: 'Account "users:1" has not enough USD: balance is 100, but 101 is needed',
    });
  });

  it('returns 409 TRANSACTION_REFERENCE_ALREADY_EXISTS for a repeated reference', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);
    const body = { reference: 'order-1', postings: [posting('world', 'users:1', '5')] };
    await createTransaction(organizationId, body).expect(201);

    const res = await createTransaction(organizationId, body).expect(409);

    expect(res.body.errorCode).toBe('TRANSACTION_REFERENCE_ALREADY_EXISTS');
  });

  it('allows the same reference in another ledger', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId, 'one');
    await createLedger(organizationId, 'two');
    const body = { reference: 'order-1', postings: [posting('world', 'users:1', '5')] };

    await createTransaction(organizationId, body, 'one').expect(201);
    await createTransaction(organizationId, body, 'two').expect(201);
  });

  it('returns 400 INVALID_POSTING when source and destination are the same', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);

    const res = await createTransaction(organizationId, {
      postings: [posting('users:1', 'users:1', '5')],
    }).expect(400);

    expect(res.body.errorCode).toBe('INVALID_POSTING');
  });

  it('returns 400 VALIDATION for a JSON number as amount', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);

    const res = await createTransaction(organizationId, {
      postings: [{ source: 'world', destination: 'users:1', asset: 'USD', amount: 5 }],
    }).expect(400);

    expect(res.body.errorCode).toBe('VALIDATION');
  });

  it('sends the URL of the new transaction in the Location header', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId);

    const res = await createTransaction(organizationId, {
      postings: [posting('world', 'users:1', '5')],
    }).expect(201);

    expect(res.headers.location).toBe(`/ledgers/main/transactions/${res.body.id}`);
  });

  describe('get', () => {
    it('gets a transaction, the same as the create response', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      const created = await createTransaction(organizationId, {
        reference: 'order-1',
        postings: [posting('world', 'users:1', '1050'), posting('users:1', 'fees', '50')],
      }).expect(201);

      const res = await getTransaction(organizationId, created.body.id).expect(200);

      expect(res.body).toEqual(created.body);
    });

    it('follows the Location header of create', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      const created = await createTransaction(organizationId, {
        postings: [posting('world', 'users:1', '5')],
      }).expect(201);

      const res = await request(app.getHttpServer())
        .get(created.headers.location as string)
        .set(ORGANIZATION_ID_HEADER, organizationId)
        .expect(200);

      expect(res.body.id).toBe(created.body.id);
    });

    it('returns 404 TRANSACTION_NOT_FOUND for an id that does not exist', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);

      const res = await getTransaction(organizationId, randomUUIDv7()).expect(404);

      expect(res.body.errorCode).toBe('TRANSACTION_NOT_FOUND');
    });

    it('returns 404 LEDGER_NOT_FOUND for a ledger that does not exist', async () => {
      const res = await getTransaction(randomUUIDv7(), randomUUIDv7(), 'missing').expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
    });

    it('returns 404 for the transaction of another organization', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      const created = await createTransaction(organizationId, {
        postings: [posting('world', 'users:1', '5')],
      }).expect(201);
      const otherOrganizationId = randomUUIDv7();
      await createLedger(otherOrganizationId);

      const res = await getTransaction(otherOrganizationId, created.body.id).expect(404);

      expect(res.body.errorCode).toBe('TRANSACTION_NOT_FOUND');
    });

    it('returns 404 for the transaction of another ledger', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId, 'one');
      await createLedger(organizationId, 'two');
      const created = await createTransaction(
        organizationId,
        { postings: [posting('world', 'users:1', '5')] },
        'one',
      ).expect(201);

      const res = await getTransaction(organizationId, created.body.id, 'two').expect(404);

      expect(res.body.errorCode).toBe('TRANSACTION_NOT_FOUND');
    });

    it('returns 400 VALIDATION for an id that is not a UUIDv7', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);

      const res = await getTransaction(organizationId, 'abc').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });
  });
});
