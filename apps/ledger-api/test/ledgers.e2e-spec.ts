import { randomUUIDv7 } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { ORGANIZATION_ID_HEADER } from '../src/core/tenant/tenant.guard.js';

describe('ledgers (e2e)', () => {
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
  const createLedger = (organizationId: string, body: object) =>
    request(app.getHttpServer())
      .post('/ledgers')
      .set(ORGANIZATION_ID_HEADER, organizationId)
      .send(body);

  const getLedger = (organizationId: string, name: string) =>
    request(app.getHttpServer())
      .get(`/ledgers/${name}`)
      .set(ORGANIZATION_ID_HEADER, organizationId);

  const listLedgers = (organizationId: string, query = '') =>
    request(app.getHttpServer())
      .get(`/ledgers${query}`)
      .set(ORGANIZATION_ID_HEADER, organizationId);

  const saveMetadata = (organizationId: string, name: string, body: object) =>
    request(app.getHttpServer())
      .post(`/ledgers/${name}/metadata`)
      .set(ORGANIZATION_ID_HEADER, organizationId)
      .send(body);

  const deleteMetadata = (organizationId: string, name: string, key: string) =>
    request(app.getHttpServer())
      .delete(`/ledgers/${name}/metadata/${encodeURIComponent(key)}`)
      .set(ORGANIZATION_ID_HEADER, organizationId);

  it('creates a ledger', async () => {
    const res = await createLedger(randomUUIDv7(), {
      name: 'main',
      metadata: { env: 'test' },
    }).expect(201);

    expect(res.body).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      name: 'main',
      metadata: { env: 'test' },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });
  });

  it('returns 409 LEDGER_ALREADY_EXISTS for the same name in the same organization', async () => {
    const organizationId = randomUUIDv7();
    await createLedger(organizationId, { name: 'main' }).expect(201);

    const res = await createLedger(organizationId, { name: 'main' }).expect(409);

    expect(res.body.errorCode).toBe('LEDGER_ALREADY_EXISTS');
  });

  it('allows the same name in another organization', async () => {
    await createLedger(randomUUIDv7(), { name: 'main' }).expect(201);
    await createLedger(randomUUIDv7(), { name: 'main' }).expect(201);
  });

  it('returns 400 INVALID_LEDGER_NAME for a reserved name', async () => {
    const res = await createLedger(randomUUIDv7(), { name: 'default' }).expect(400);

    expect(res.body.errorCode).toBe('INVALID_LEDGER_NAME');
  });

  it('returns 400 VALIDATION for a bad body', async () => {
    const res = await createLedger(randomUUIDv7(), { name: 'Not Valid' }).expect(400);

    expect(res.body.errorCode).toBe('VALIDATION');
  });

  it('sends the URL of the new ledger, and that URL returns the ledger', async () => {
    const organizationId = randomUUIDv7();

    const created = await createLedger(organizationId, {
      name: 'main',
      metadata: { env: 'test' },
    }).expect(201);
    expect(created.headers.location).toBe('/ledgers/main');

    const fetched = await request(app.getHttpServer())
      .get(created.headers.location as string)
      .set(ORGANIZATION_ID_HEADER, organizationId)
      .expect(200);

    expect(fetched.body).toEqual(created.body);
  });

  it('returns 404 LEDGER_NOT_FOUND for a name the organization does not have', async () => {
    const res = await getLedger(randomUUIDv7(), 'missing').expect(404);

    expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
  });

  it('returns 404 LEDGER_NOT_FOUND for the ledger of another organization', async () => {
    await createLedger(randomUUIDv7(), { name: 'main' }).expect(201);

    const res = await getLedger(randomUUIDv7(), 'main').expect(404);

    expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
  });

  it('returns 400 VALIDATION for a name with a wrong shape', async () => {
    const res = await getLedger(randomUUIDv7(), 'Not-Valid').expect(400);

    expect(res.body.errorCode).toBe('VALIDATION');
  });

  describe('POST /ledgers/:name/metadata', () => {
    it('adds keys, replaces the value of a key that is there, and keeps the other keys', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId, {
        name: 'main',
        metadata: { env: 'prod', team: 'payments' },
      }).expect(201);

      await saveMetadata(organizationId, 'main', { env: 'staging', tier: '1' }).expect(204);
      const res = await getLedger(organizationId, 'main').expect(200);

      expect(res.body.metadata).toEqual({ env: 'staging', team: 'payments', tier: '1' });
    });

    it('can be repeated with the same body', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId, { name: 'main' }).expect(201);

      await saveMetadata(organizationId, 'main', { env: 'prod' }).expect(204);
      await saveMetadata(organizationId, 'main', { env: 'prod' }).expect(204);
      const res = await getLedger(organizationId, 'main').expect(200);

      expect(res.body.metadata).toEqual({ env: 'prod' });
    });

    it('keeps keys with spaces, slashes and non-ASCII letters, and values with any text', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId, { name: 'main' }).expect(201);
      const metadata = { 'team name/größe': 'Zürich ✓ "quoted" \\ 日本語', empty: '' };

      await saveMetadata(organizationId, 'main', metadata).expect(204);
      const res = await getLedger(organizationId, 'main').expect(200);

      expect(res.body.metadata).toEqual(metadata);
    });

    it('returns 404 LEDGER_NOT_FOUND for a name the organization does not have', async () => {
      const res = await saveMetadata(randomUUIDv7(), 'main', { env: 'prod' }).expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
    });

    it('returns 404 LEDGER_NOT_FOUND for the ledger of another organization, and does not change it', async () => {
      const owner = randomUUIDv7();
      await createLedger(owner, { name: 'main', metadata: { env: 'prod' } }).expect(201);

      const res = await saveMetadata(randomUUIDv7(), 'main', { env: 'hacked' }).expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
      const unchanged = await getLedger(owner, 'main').expect(200);
      expect(unchanged.body.metadata).toEqual({ env: 'prod' });
    });

    it.each([
      ['the body is empty', {}],
      ['the body is an array', ['a']],
      ['a value is not a string', { n: 1 }],
      ['a key is empty', { '': 'x' }],
    ])('returns 400 VALIDATION when %s', async (_title, body) => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId, { name: 'main' }).expect(201);

      const res = await saveMetadata(organizationId, 'main', body).expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });

    it('returns 400 VALIDATION for a name with a wrong shape', async () => {
      const res = await saveMetadata(randomUUIDv7(), 'Not-Valid', { env: 'prod' }).expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });

    it('returns 400 INVALID_REQUEST when the organization header is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/ledgers/main/metadata')
        .send({ env: 'prod' })
        .expect(400);

      expect(res.body.errorCode).toBe('INVALID_REQUEST');
    });
  });

  describe('DELETE /ledgers/:name/metadata/:key', () => {
    it('removes the key and keeps the other keys', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId, {
        name: 'main',
        metadata: { env: 'prod', team: 'payments' },
      }).expect(201);

      await deleteMetadata(organizationId, 'main', 'env').expect(204);
      const res = await getLedger(organizationId, 'main').expect(200);

      expect(res.body.metadata).toEqual({ team: 'payments' });
    });

    it('removes a key with spaces, slashes and non-ASCII letters', async () => {
      const organizationId = randomUUIDv7();
      const key = 'team name/größe';
      await createLedger(organizationId, {
        name: 'main',
        metadata: { [key]: 'x', env: 'prod' },
      }).expect(201);

      await deleteMetadata(organizationId, 'main', key).expect(204);
      const res = await getLedger(organizationId, 'main').expect(200);

      expect(res.body.metadata).toEqual({ env: 'prod' });
    });

    it('returns 204 for a key that is not there, so it can be repeated', async () => {
      const organizationId = randomUUIDv7();
      await createLedger(organizationId, { name: 'main', metadata: { env: 'prod' } }).expect(201);

      await deleteMetadata(organizationId, 'main', 'env').expect(204);
      await deleteMetadata(organizationId, 'main', 'env').expect(204);
      await deleteMetadata(organizationId, 'main', 'never-there').expect(204);
      const res = await getLedger(organizationId, 'main').expect(200);

      expect(res.body.metadata).toEqual({});
    });

    it('returns 404 LEDGER_NOT_FOUND for a name the organization does not have', async () => {
      const res = await deleteMetadata(randomUUIDv7(), 'main', 'env').expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
    });

    it('returns 404 LEDGER_NOT_FOUND for the ledger of another organization, and does not change it', async () => {
      const owner = randomUUIDv7();
      await createLedger(owner, { name: 'main', metadata: { env: 'prod' } }).expect(201);

      const res = await deleteMetadata(randomUUIDv7(), 'main', 'env').expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
      const unchanged = await getLedger(owner, 'main').expect(200);
      expect(unchanged.body.metadata).toEqual({ env: 'prod' });
    });

    it('returns 400 VALIDATION for a name with a wrong shape', async () => {
      const res = await deleteMetadata(randomUUIDv7(), 'Not-Valid', 'env').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });
  });

  describe('GET /ledgers', () => {
    const createAll = async (organizationId: string, names: string[]) => {
      for (const name of names) {
        await createLedger(organizationId, { name }).expect(201);
      }
    };

    it('returns an empty page for an organization with no ledgers', async () => {
      const res = await listLedgers(randomUUIDv7()).expect(200);

      expect(res.body).toEqual({ data: [], hasMore: false });
    });

    it('lists the ledgers sorted by name, with the same fields as get', async () => {
      const organizationId = randomUUIDv7();
      await createAll(organizationId, ['beta', 'alpha']);

      const res = await listLedgers(organizationId).expect(200);
      const alpha = await getLedger(organizationId, 'alpha').expect(200);

      expect(res.body.data.map((ledger: { name: string }) => ledger.name)).toEqual([
        'alpha',
        'beta',
      ]);
      expect(res.body.data[0]).toEqual(alpha.body);
      expect(res.body.hasMore).toBe(false);
      expect(res.body).not.toHaveProperty('next');
    });

    it('reads every ledger once when the "next" cursors are followed', async () => {
      const organizationId = randomUUIDv7();
      await createAll(organizationId, ['alpha', 'beta', 'gamma', 'delta', 'epsilon']);

      const pages: string[][] = [];
      let query = '?pageSize=2';
      for (;;) {
        const res = await listLedgers(organizationId, query).expect(200);
        pages.push(res.body.data.map((ledger: { name: string }) => ledger.name));
        if (!res.body.hasMore) break;
        query = `?pageSize=2&cursor=${res.body.next}`;
      }

      expect(pages).toEqual([['alpha', 'beta'], ['delta', 'epsilon'], ['gamma']]);
    });

    it('does not list the ledgers of another organization', async () => {
      await createAll(randomUUIDv7(), ['alpha']);
      const organizationId = randomUUIDv7();
      await createAll(organizationId, ['beta']);

      const res = await listLedgers(organizationId).expect(200);

      expect(res.body.data.map((ledger: { name: string }) => ledger.name)).toEqual(['beta']);
    });

    it('returns 400 VALIDATION for a pageSize that is out of range', async () => {
      const res = await listLedgers(randomUUIDv7(), '?pageSize=101').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });

    it('returns 400 VALIDATION for a cursor that we did not give', async () => {
      const res = await listLedgers(randomUUIDv7(), '?cursor=hello').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
    });
  });
});
