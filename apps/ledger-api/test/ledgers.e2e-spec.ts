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
});
