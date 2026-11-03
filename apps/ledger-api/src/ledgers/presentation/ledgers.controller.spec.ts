import { randomUUIDv7 } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { ErrorsModule } from '../../core/errors/errors.module.js';
import { ORGANIZATION_ID_HEADER } from '../../core/tenant/tenant.guard.js';
import { ValidationModule } from '../../core/validation/validation.module.js';
import { CreateLedgerUseCase } from '../application/use-cases/create-ledger.use-case.js';
import { InvalidLedgerMetadataError } from '../domain/invalid-ledger-metadata.error.js';
import { InvalidLedgerNameError } from '../domain/invalid-ledger-name.error.js';
import { LedgerAlreadyExistsError } from '../domain/ledger-already-exists.error.js';
import { LedgerDomainError } from '../domain/ledger-domain.error.js';
import { Ledger } from '../domain/ledger.entity.js';
import { LedgersController } from './ledgers.controller.js';

// These tests start a real Nest app with the real guard, validation pipe and
// error filters. Only the use case is fake, so no database is needed.
describe('LedgersController (POST /ledgers)', () => {
  const execute = vi.fn<CreateLedgerUseCase['execute']>();
  const organizationId = randomUUIDv7();
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ErrorsModule,
        ValidationModule,
      ],
      controllers: [LedgersController],
      providers: [{ provide: CreateLedgerUseCase, useValue: { execute } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    execute.mockReset();
    execute.mockImplementation(async (input) =>
      Ledger.create({
        id: randomUUIDv7(),
        organizationId: input.organizationId,
        name: input.name,
        metadata: input.metadata,
        createdAt: new Date('2026-11-03T10:00:00.000Z'),
      }),
    );
  });

  /** `org` is the header value. Pass `null` to send no header at all. */
  const post = (body?: unknown, org: string | null = organizationId) => {
    const req = request(app.getHttpServer()).post('/ledgers');
    if (org !== null) req.set(ORGANIZATION_ID_HEADER, org);
    return body === undefined ? req : req.send(body as object);
  };

  describe('success', () => {
    it('returns 201 with the ledger', async () => {
      const res = await post({ name: 'main', metadata: { env: 'prod' } }).expect(201);

      expect(res.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: 'main',
        metadata: { env: 'prod' },
        createdAt: '2026-11-03T10:00:00.000Z',
      });
    });

    it('does not return the organization id', async () => {
      const res = await post({ name: 'main' }).expect(201);

      expect(res.body).not.toHaveProperty('organizationId');
    });

    it('gives the use case the organization of the header and the body fields', async () => {
      await post({ name: 'main', metadata: { env: 'prod' } }).expect(201);

      expect(execute).toHaveBeenCalledExactlyOnceWith({
        organizationId,
        name: 'main',
        metadata: { env: 'prod' },
      });
    });

    it('uses empty metadata when the body has none', async () => {
      const res = await post({ name: 'main' }).expect(201);

      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }));
      expect(res.body.metadata).toEqual({});
    });

    it('drops a "__proto__" metadata key and does not pollute the object', async () => {
      // Raw text on purpose: an object literal with `__proto__` would not make an own key.
      await request(app.getHttpServer())
        .post('/ledgers')
        .set(ORGANIZATION_ID_HEADER, organizationId)
        .set('Content-Type', 'application/json')
        .send('{"name":"main","metadata":{"__proto__":"x","env":"prod"}}')
        .expect(201);

      const { metadata } = execute.mock.calls[0]![0];
      expect(Object.keys(metadata)).toEqual(['env']);
      expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    });

    it('gives the use case a lowercase organization id', async () => {
      await post({ name: 'main' }, organizationId.toUpperCase()).expect(201);

      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ organizationId }));
    });
  });

  describe('tenant header', () => {
    it('returns 400 INVALID_REQUEST when the header is missing', async () => {
      const res = await post({ name: 'main' }, null).expect(400);

      expect(res.body.errorCode).toBe('INVALID_REQUEST');
      expect(execute).not.toHaveBeenCalled();
    });

    it('returns 400 INVALID_REQUEST when the header is not a UUIDv7', async () => {
      const res = await post({ name: 'main' }, 'not-an-id').expect(400);

      expect(res.body.errorCode).toBe('INVALID_REQUEST');
      expect(execute).not.toHaveBeenCalled();
    });

    it('checks the header before the body', async () => {
      const res = await post({ name: 'NOT VALID' }, 'not-an-id').expect(400);

      expect(res.body.errorCode).toBe('INVALID_REQUEST');
    });
  });

  describe('body validation', () => {
    const invalidBodies: [string, unknown, string][] = [
      ['name is missing', {}, 'name'],
      ['name is not a string', { name: 5 }, 'name'],
      ['name has uppercase letters', { name: 'Main' }, 'name'],
      ['name has a space', { name: 'my ledger' }, 'name'],
      ['name starts with "-"', { name: '-main' }, 'name'],
      ['name is empty', { name: '' }, 'name'],
      ['name is longer than 63 characters', { name: 'a'.repeat(64) }, 'name'],
      ['metadata is an array', { name: 'main', metadata: ['a'] }, 'metadata'],
      ['metadata is null', { name: 'main', metadata: null }, 'metadata'],
      ['a metadata value is a number', { name: 'main', metadata: { n: 1 } }, 'metadata.n'],
      ['a metadata value is an object', { name: 'main', metadata: { o: {} } }, 'metadata.o'],
      ['a metadata value is null', { name: 'main', metadata: { n: null } }, 'metadata.n'],
      ['the body has an unknown field', { name: 'main', metdata: {} }, ''],
    ];

    it.each(invalidBodies)('returns 400 VALIDATION when %s', async (_title, body, path) => {
      const res = await post(body).expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
      expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
      expect(execute).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION when there is no body', async () => {
      const res = await post().expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
      expect(execute).not.toHaveBeenCalled();
    });

    it('does not echo metadata values in the error', async () => {
      const res = await post({ name: 'main', metadata: { token: 12345678 } }).expect(400);

      expect(JSON.stringify(res.body)).not.toContain('12345678');
    });
  });

  describe('domain errors', () => {
    it('returns 400 INVALID_LEDGER_NAME for a name the domain refuses', async () => {
      execute.mockRejectedValue(new InvalidLedgerNameError('Ledger name "default" is reserved'));

      const res = await post({ name: 'default' }).expect(400);

      expect(res.body).toEqual({
        errorCode: 'INVALID_LEDGER_NAME',
        errorMessage: 'Ledger name "default" is reserved',
      });
    });

    it('returns 400 INVALID_LEDGER_METADATA for metadata the domain refuses', async () => {
      execute.mockRejectedValue(new InvalidLedgerMetadataError('Metadata must be an object'));

      const res = await post({ name: 'main' }).expect(400);

      expect(res.body).toEqual({
        errorCode: 'INVALID_LEDGER_METADATA',
        errorMessage: 'Metadata must be an object',
      });
    });

    it('returns 409 LEDGER_ALREADY_EXISTS when the name is taken', async () => {
      execute.mockRejectedValue(new LedgerAlreadyExistsError('main'));

      const res = await post({ name: 'main' }).expect(409);

      expect(res.body).toEqual({
        errorCode: 'LEDGER_ALREADY_EXISTS',
        errorMessage: 'Ledger "main" already exists',
      });
    });

    it('returns 500 INTERNAL, hiding the code and message, for a ledger error with no status yet', async () => {
      class NotMappedYetError extends LedgerDomainError {
        readonly code = 'NOT_MAPPED_YET';
      }
      execute.mockRejectedValue(new NotMappedYetError('internal detail'));

      const res = await post({ name: 'main' }).expect(500);

      expect(res.body).toEqual({ errorCode: 'INTERNAL', errorMessage: 'Internal server error' });
    });

    it('returns 500 INTERNAL, with no details, for an unknown error', async () => {
      execute.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

      const res = await post({ name: 'main' }).expect(500);

      expect(res.body).toEqual({ errorCode: 'INTERNAL', errorMessage: 'Internal server error' });
    });
  });
});
