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

  const listTransactions = (organizationId: string, query = '', ledger = 'main') =>
    request(app.getHttpServer())
      .get(`/ledgers/${ledger}/transactions${query}`)
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

  describe('list', () => {
    /** Creates one transaction per amount, one after the other. Returns the created bodies. */
    const createAll = async (organizationId: string, amounts: string[], ledger = 'main') => {
      const created: { id: string }[] = [];
      for (const amount of amounts) {
        const res = await createTransaction(
          organizationId,
          { postings: [posting('world', 'users:1', amount)] },
          ledger,
        ).expect(201);
        created.push(res.body);
      }
      return created;
    };

    const idsOf = (body: { data: { id: string }[] }) => body.data.map((t) => t.id);

    it('returns an empty page for a ledger with no transactions', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);

      const res = await listTransactions(organizationId).expect(200);

      expect(res.body).toEqual({ data: [], hasMore: false });
    });

    it('lists the transactions newest first, with the same fields as get', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      const [older, newer] = await createAll(organizationId, ['1', '2']);

      const res = await listTransactions(organizationId).expect(200);
      const got = await getTransaction(organizationId, older!.id).expect(200);

      expect(idsOf(res.body)).toEqual([newer!.id, older!.id]);
      expect(res.body.data[1]).toEqual(got.body);
      expect(res.body.hasMore).toBe(false);
      expect(res.body).not.toHaveProperty('next');
    });

    it('reads every transaction once when the "next" cursors are followed', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      const created = await createAll(organizationId, ['1', '2', '3', '4', '5']);

      const pages: string[][] = [];
      let query = '?pageSize=2';
      for (;;) {
        const res = await listTransactions(organizationId, query).expect(200);
        pages.push(idsOf(res.body));
        if (!res.body.hasMore) break;
        query = `?pageSize=2&cursor=${res.body.next}`;
      }

      const newestFirst = created.map((t) => t.id).toReversed();
      expect(pages).toEqual([
        newestFirst.slice(0, 2),
        newestFirst.slice(2, 4),
        newestFirst.slice(4),
      ]);
    });

    it('does not move the next page when a new transaction is created in between', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      const created = await createAll(organizationId, ['1', '2', '3']);

      const first = await listTransactions(organizationId, '?pageSize=2').expect(200);
      await createAll(organizationId, ['4']);
      const second = await listTransactions(
        organizationId,
        `?pageSize=2&cursor=${first.body.next}`,
      ).expect(200);

      expect(idsOf(second.body)).toEqual([created[0]!.id]);
    });

    it('lists only the transactions of the ledger in the URL', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId, 'one');
      await createLedger(organizationId, 'two');
      const [inOne] = await createAll(organizationId, ['1'], 'one');
      await createAll(organizationId, ['2'], 'two');

      const res = await listTransactions(organizationId, '', 'one').expect(200);

      expect(idsOf(res.body)).toEqual([inOne!.id]);
    });

    it('does not list the transactions of another organization', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId);
      await createAll(organizationId, ['1']);
      const otherOrganizationId = randomUUIDv7();
      await createLedger(otherOrganizationId);

      const res = await listTransactions(otherOrganizationId).expect(200);

      expect(res.body).toEqual({ data: [], hasMore: false });
    });

    it('returns 404 LEDGER_NOT_FOUND for a ledger that does not exist', async () => {
      const res = await listTransactions(randomUUIDv7(), '', 'missing').expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
    });

    it('returns 400 VALIDATION for a pageSize that is out of range', async () => {
      const res = await listTransactions(randomUUIDv7(), '?pageSize=101').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });

    it('returns 400 VALIDATION for a cursor that we did not give', async () => {
      const res = await listTransactions(randomUUIDv7(), '?cursor=hello').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });
  });
});
