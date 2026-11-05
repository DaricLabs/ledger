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
import { DeleteLedgerMetadataUseCase } from '../application/use-cases/delete-ledger-metadata.use-case.js';
import { GetLedgerUseCase } from '../application/use-cases/get-ledger.use-case.js';
import { ListLedgersUseCase } from '../application/use-cases/list-ledgers.use-case.js';
import { SaveLedgerMetadataUseCase } from '../application/use-cases/save-ledger-metadata.use-case.js';
import { InvalidLedgerMetadataError } from '../domain/invalid-ledger-metadata.error.js';
import { InvalidLedgerNameError } from '../domain/invalid-ledger-name.error.js';
import { LedgerAlreadyExistsError } from '../domain/ledger-already-exists.error.js';
import { LedgerDomainError } from '../domain/ledger-domain.error.js';
import { LedgerNotFoundError } from '../domain/ledger-not-found.error.js';
import { Ledger } from '../domain/ledger.entity.js';
import { encodeLedgerCursor } from './dto/ledger-page-cursor.dto.js';
import { LedgersController } from './ledgers.controller.js';

// These tests start a real Nest app with the real guard, validation pipe and
// error filters. Only the use cases are fake, so no database is needed.
describe('LedgersController', () => {
  const execute = vi.fn<CreateLedgerUseCase['execute']>();
  const executeGet = vi.fn<GetLedgerUseCase['execute']>();
  const executeList = vi.fn<ListLedgersUseCase['execute']>();
  const executeSave = vi.fn<SaveLedgerMetadataUseCase['execute']>();
  const executeDelete = vi.fn<DeleteLedgerMetadataUseCase['execute']>();
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
      providers: [
        { provide: CreateLedgerUseCase, useValue: { execute } },
        { provide: GetLedgerUseCase, useValue: { execute: executeGet } },
        { provide: ListLedgersUseCase, useValue: { execute: executeList } },
        { provide: SaveLedgerMetadataUseCase, useValue: { execute: executeSave } },
        { provide: DeleteLedgerMetadataUseCase, useValue: { execute: executeDelete } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    execute.mockReset();
    executeGet.mockReset();
    executeList.mockReset();
    executeSave.mockReset();
    executeDelete.mockReset();
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

  describe('POST /ledgers', () => {
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

      it('sends the URL of the new ledger in the Location header', async () => {
        const res = await post({ name: 'main' }).expect(201);

        expect(res.headers.location).toBe('/ledgers/main');
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
        // The path ends with a dot: it is the empty key after "metadata".
        ['a metadata key is empty', { name: 'main', metadata: { '': 'x' } }, 'metadata.'],
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
  describe('GET /ledgers/:name', () => {
    const storedLedger = Ledger.reconstitute({
      id: randomUUIDv7(),
      organizationId,
      name: 'main',
      metadata: { env: 'prod' },
      createdAt: new Date('2026-11-03T10:00:00.000Z'),
    });

    beforeEach(() => {
      executeGet.mockResolvedValue(storedLedger);
    });

    /** `org` is the header value. Pass `null` to send no header at all. */
    const get = (name: string, org: string | null = organizationId) => {
      const req = request(app.getHttpServer()).get(`/ledgers/${name}`);
      if (org !== null) req.set(ORGANIZATION_ID_HEADER, org);
      return req;
    };

    it('returns 200 with the ledger and no organization id', async () => {
      const res = await get('main').expect(200);

      expect(res.body).toEqual({
        id: storedLedger.id,
        name: 'main',
        metadata: { env: 'prod' },
        createdAt: '2026-11-03T10:00:00.000Z',
      });
    });

    it('gives the use case the organization of the header and the name of the URL', async () => {
      await get('main').expect(200);

      expect(executeGet).toHaveBeenCalledExactlyOnceWith({ organizationId, name: 'main' });
    });

    it('returns 400 INVALID_REQUEST when the header is missing', async () => {
      const res = await get('main', null).expect(400);

      expect(res.body.errorCode).toBe('INVALID_REQUEST');
      expect(executeGet).not.toHaveBeenCalled();
    });

    it('checks the header before the name', async () => {
      const res = await get('Not-Valid', 'not-an-id').expect(400);

      expect(res.body.errorCode).toBe('INVALID_REQUEST');
    });

    it.each([
      ['has uppercase letters', 'Main'],
      ['starts with "-"', '-main'],
      ['has a dot', 'my.ledger'],
      ['is longer than 63 characters', 'a'.repeat(64)],
    ])('returns 400 VALIDATION when the name %s', async (_title, name) => {
      const res = await get(name).expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
      expect(executeGet).not.toHaveBeenCalled();
    });

    it('returns 404 LEDGER_NOT_FOUND when there is no such ledger', async () => {
      executeGet.mockRejectedValue(new LedgerNotFoundError('main'));

      const res = await get('main').expect(404);

      expect(res.body).toEqual({
        errorCode: 'LEDGER_NOT_FOUND',
        errorMessage: 'Ledger "main" not found',
      });
    });

    it('returns 500 INTERNAL, with no details, for an unknown error', async () => {
      executeGet.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

      const res = await get('main').expect(500);

      expect(res.body).toEqual({ errorCode: 'INTERNAL', errorMessage: 'Internal server error' });
    });
  });

  describe('GET /ledgers', () => {
    const makeLedger = (name: string) =>
      Ledger.reconstitute({
        id: randomUUIDv7(),
        organizationId,
        name,
        metadata: { env: 'prod' },
        createdAt: new Date('2026-11-03T10:00:00.000Z'),
      });

    beforeEach(() => {
      executeList.mockResolvedValue({ ledgers: [makeLedger('alpha')], hasMore: false });
    });

    /** `org` is the header value. Pass `null` to send no header at all. */
    const list = (query = '', org: string | null = organizationId) => {
      const req = request(app.getHttpServer()).get(`/ledgers${query}`);
      if (org !== null) req.set(ORGANIZATION_ID_HEADER, org);
      return req;
    };

    describe('success', () => {
      it('returns 200 with the ledgers in "data" and no organization id', async () => {
        const stored = makeLedger('alpha');
        executeList.mockResolvedValue({ ledgers: [stored], hasMore: false });

        const res = await list().expect(200);

        expect(res.body).toEqual({
          data: [
            {
              id: stored.id,
              name: 'alpha',
              metadata: { env: 'prod' },
              createdAt: '2026-11-03T10:00:00.000Z',
            },
          ],
          hasMore: false,
        });
      });

      it('returns an empty page when there are no ledgers', async () => {
        executeList.mockResolvedValue({ ledgers: [], hasMore: false });

        const res = await list().expect(200);

        expect(res.body).toEqual({ data: [], hasMore: false });
      });

      it('gives the use case the organization of the header, the default page size and no position', async () => {
        await list().expect(200);

        expect(executeList).toHaveBeenCalledExactlyOnceWith({
          organizationId,
          pageSize: 15,
          afterName: undefined,
        });
      });

      it('gives the use case the page size of the query', async () => {
        await list('?pageSize=3').expect(200);

        expect(executeList).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 3 }));
      });

      it.each([['1'], ['100']])('accepts the page size %s', async (pageSize) => {
        await list(`?pageSize=${pageSize}`).expect(200);
      });

      it('gives the use case the ledger name that the cursor holds', async () => {
        await list(`?cursor=${encodeLedgerCursor('alpha')}`).expect(200);

        expect(executeList).toHaveBeenCalledWith(expect.objectContaining({ afterName: 'alpha' }));
      });

      it('gives a lowercase organization id to the use case', async () => {
        await list('', organizationId.toUpperCase()).expect(200);

        expect(executeList).toHaveBeenCalledWith(expect.objectContaining({ organizationId }));
      });
    });

    describe('next page', () => {
      it('sends "next" and hasMore when there are more ledgers', async () => {
        executeList.mockResolvedValue({
          ledgers: [makeLedger('alpha'), makeLedger('beta')],
          hasMore: true,
        });

        const res = await list('?pageSize=2').expect(200);

        expect(res.body.hasMore).toBe(true);
        expect(res.body.next).toBe(encodeLedgerCursor('beta')); // the last ledger of the page
      });

      it('sends no "next" on the last page', async () => {
        const res = await list().expect(200);

        expect(res.body.hasMore).toBe(false);
        expect(res.body).not.toHaveProperty('next');
      });

      it('makes a "next" that the same route accepts', async () => {
        executeList.mockResolvedValueOnce({ ledgers: [makeLedger('alpha')], hasMore: true });

        const first = await list('?pageSize=1').expect(200);
        await list(`?pageSize=1&cursor=${first.body.next}`).expect(200);

        expect(executeList).toHaveBeenLastCalledWith(
          expect.objectContaining({ afterName: 'alpha' }),
        );
      });
    });

    describe('tenant header', () => {
      it('returns 400 INVALID_REQUEST when the header is missing', async () => {
        const res = await list('', null).expect(400);

        expect(res.body.errorCode).toBe('INVALID_REQUEST');
        expect(executeList).not.toHaveBeenCalled();
      });

      it('checks the header before the query', async () => {
        const res = await list('?pageSize=0', 'not-an-id').expect(400);

        expect(res.body.errorCode).toBe('INVALID_REQUEST');
      });
    });

    describe('query validation', () => {
      const invalidQueries: [string, string, string][] = [
        ['pageSize is 0', '?pageSize=0', 'pageSize'],
        ['pageSize is above 100', '?pageSize=101', 'pageSize'],
        ['pageSize is huge', `?pageSize=${'9'.repeat(400)}`, 'pageSize'],
        ['pageSize is negative', '?pageSize=-1', 'pageSize'],
        ['pageSize has decimals', '?pageSize=1.5', 'pageSize'],
        ['pageSize is not a number', '?pageSize=abc', 'pageSize'],
        ['pageSize is in hex', '?pageSize=0x10', 'pageSize'],
        ['pageSize is in exponent form', '?pageSize=1e1', 'pageSize'],
        ['pageSize is empty', '?pageSize=', 'pageSize'],
        ['pageSize is sent twice', '?pageSize=1&pageSize=2', 'pageSize'],
        ['the cursor is not a cursor', '?cursor=hello', 'cursor'],
        ['the cursor is empty', '?cursor=', 'cursor'],
        ['the cursor is sent twice', '?cursor=a&cursor=b', 'cursor'],
        [
          'the cursor holds a bad ledger name',
          `?cursor=${Buffer.from('{"key":"Not Valid"}').toString('base64url')}`,
          'cursor',
        ],
        ['a query parameter is unknown', '?pagesize=5', ''],
      ];

      it.each(invalidQueries)('returns 400 VALIDATION when %s', async (_title, query, path) => {
        const res = await list(query).expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
        expect(executeList).not.toHaveBeenCalled();
      });

      it('gives one error for a pageSize that is not a number', async () => {
        const res = await list('?pageSize=abc').expect(400);

        expect(res.body.details).toHaveLength(1);
      });

      it('does not echo the cursor in the error', async () => {
        const res = await list('?cursor=secret-looking-text').expect(400);

        expect(JSON.stringify(res.body)).not.toContain('secret-looking-text');
      });
    });

    describe('errors', () => {
      it('returns 500 INTERNAL, with no details, for an unknown error', async () => {
        executeList.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

        const res = await list().expect(500);

        expect(res.body).toEqual({ errorCode: 'INTERNAL', errorMessage: 'Internal server error' });
      });
    });
  });
  describe('POST /ledgers/:name/metadata', () => {
    /** `org` is the header value. Pass `null` to send no header at all. */
    const save = (name: string, body?: unknown, org: string | null = organizationId) => {
      const req = request(app.getHttpServer()).post(`/ledgers/${name}/metadata`);
      if (org !== null) req.set(ORGANIZATION_ID_HEADER, org);
      return body === undefined ? req : req.send(body as object);
    };

    describe('success', () => {
      beforeEach(() => {
        executeSave.mockResolvedValue(undefined);
      });

      it('returns 204 with no body', async () => {
        const res = await save('main', { env: 'prod' }).expect(204);

        expect(res.body).toEqual({});
        expect(res.text).toBe('');
      });

      it('gives the use case the organization of the header, the name of the URL and the body as metadata', async () => {
        await save('main', { env: 'prod', team: 'payments' }).expect(204);

        expect(executeSave).toHaveBeenCalledExactlyOnceWith({
          organizationId,
          name: 'main',
          metadata: { env: 'prod', team: 'payments' },
        });
      });

      it('accepts an empty string as a value', async () => {
        await save('main', { env: '' }).expect(204);

        expect(executeSave).toHaveBeenCalledWith(
          expect.objectContaining({ metadata: { env: '' } }),
        );
      });

      it('drops a "__proto__" key and does not pollute the object', async () => {
        // Raw text on purpose: an object literal with `__proto__` would not make an own key.
        await request(app.getHttpServer())
          .post('/ledgers/main/metadata')
          .set(ORGANIZATION_ID_HEADER, organizationId)
          .set('Content-Type', 'application/json')
          .send('{"__proto__":"x","env":"prod"}')
          .expect(204);

        const { metadata } = executeSave.mock.calls[0]![0];
        expect(Object.keys(metadata)).toEqual(['env']);
        expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
      });

      it('gives the use case a lowercase organization id', async () => {
        await save('main', { env: 'prod' }, organizationId.toUpperCase()).expect(204);

        expect(executeSave).toHaveBeenCalledWith(expect.objectContaining({ organizationId }));
      });
    });

    describe('tenant header', () => {
      it('returns 400 INVALID_REQUEST when the header is missing', async () => {
        const res = await save('main', { env: 'prod' }, null).expect(400);

        expect(res.body.errorCode).toBe('INVALID_REQUEST');
        expect(executeSave).not.toHaveBeenCalled();
      });

      it('checks the header before the name and the body', async () => {
        const res = await save('Not-Valid', [], 'not-an-id').expect(400);

        expect(res.body.errorCode).toBe('INVALID_REQUEST');
      });
    });

    describe('validation', () => {
      it.each([
        ['has uppercase letters', 'Main'],
        ['starts with "-"', '-main'],
        ['is longer than 63 characters', 'a'.repeat(64)],
      ])('returns 400 VALIDATION when the name %s', async (_title, name) => {
        const res = await save(name, { env: 'prod' }).expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(executeSave).not.toHaveBeenCalled();
      });

      const invalidBodies: [string, unknown][] = [
        ['the body is an empty object', {}],
        ['the body is an array', ['a']],
        ['a value is a number', { n: 1 }],
        ['a value is a boolean', { b: true }],
        ['a value is null', { n: null }],
        ['a value is an object', { o: {} }],
        ['a key is empty', { '': 'x' }],
      ];

      it.each(invalidBodies)('returns 400 VALIDATION when %s', async (_title, body) => {
        const res = await save('main', body).expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(executeSave).not.toHaveBeenCalled();
      });

      it('returns 400 VALIDATION when the only key is "__proto__", because nothing is left', async () => {
        const res = await request(app.getHttpServer())
          .post('/ledgers/main/metadata')
          .set(ORGANIZATION_ID_HEADER, organizationId)
          .set('Content-Type', 'application/json')
          .send('{"__proto__":"x"}')
          .expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(executeSave).not.toHaveBeenCalled();
      });

      it('returns 400 VALIDATION when there is no body', async () => {
        const res = await save('main').expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(executeSave).not.toHaveBeenCalled();
      });

      it('names the bad key in the details', async () => {
        const res = await save('main', { ok: 'yes', n: 1 }).expect(400);

        expect(res.body.details.map((d: { path: string }) => d.path)).toContain('n');
      });

      it('does not echo metadata values in the error', async () => {
        const res = await save('main', { token: 12345678 }).expect(400);

        expect(JSON.stringify(res.body)).not.toContain('12345678');
      });
    });

    describe('errors', () => {
      it('returns 404 LEDGER_NOT_FOUND when there is no such ledger', async () => {
        executeSave.mockRejectedValue(new LedgerNotFoundError('main'));

        const res = await save('main', { env: 'prod' }).expect(404);

        expect(res.body).toEqual({
          errorCode: 'LEDGER_NOT_FOUND',
          errorMessage: 'Ledger "main" not found',
        });
      });

      it('returns 400 INVALID_LEDGER_METADATA for metadata the domain refuses', async () => {
        executeSave.mockRejectedValue(
          new InvalidLedgerMetadataError('Metadata value for key "bad" must be a string'),
        );

        const res = await save('main', { env: 'prod' }).expect(400);

        expect(res.body).toEqual({
          errorCode: 'INVALID_LEDGER_METADATA',
          errorMessage: 'Metadata value for key "bad" must be a string',
        });
      });

      it('returns 500 INTERNAL, with no details, for an unknown error', async () => {
        executeSave.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

        const res = await save('main', { env: 'prod' }).expect(500);

        expect(res.body).toEqual({ errorCode: 'INTERNAL', errorMessage: 'Internal server error' });
      });
    });
  });

  describe('DELETE /ledgers/:name/metadata/:key', () => {
    /** `org` is the header value. Pass `null` to send no header at all. */
    const remove = (name: string, key: string, org: string | null = organizationId) => {
      const req = request(app.getHttpServer()).delete(`/ledgers/${name}/metadata/${key}`);
      if (org !== null) req.set(ORGANIZATION_ID_HEADER, org);
      return req;
    };

    describe('success', () => {
      beforeEach(() => {
        executeDelete.mockResolvedValue(undefined);
      });

      it('returns 204 with no body', async () => {
        const res = await remove('main', 'env').expect(204);

        expect(res.body).toEqual({});
        expect(res.text).toBe('');
      });

      it('gives the use case the organization of the header, the name and the key of the URL', async () => {
        await remove('main', 'env').expect(204);

        expect(executeDelete).toHaveBeenCalledExactlyOnceWith({
          organizationId,
          name: 'main',
          key: 'env',
        });
      });

      it('decodes the key: spaces, slashes and non-ASCII letters work', async () => {
        const key = 'team name/größe';

        await remove('main', encodeURIComponent(key)).expect(204);

        expect(executeDelete).toHaveBeenCalledWith(expect.objectContaining({ key }));
      });

      it('gives the use case a lowercase organization id', async () => {
        await remove('main', 'env', organizationId.toUpperCase()).expect(204);

        expect(executeDelete).toHaveBeenCalledWith(expect.objectContaining({ organizationId }));
      });
    });

    describe('tenant header', () => {
      it('returns 400 INVALID_REQUEST when the header is missing', async () => {
        const res = await remove('main', 'env', null).expect(400);

        expect(res.body.errorCode).toBe('INVALID_REQUEST');
        expect(executeDelete).not.toHaveBeenCalled();
      });

      it('checks the header before the name', async () => {
        const res = await remove('Not-Valid', 'env', 'not-an-id').expect(400);

        expect(res.body.errorCode).toBe('INVALID_REQUEST');
      });
    });

    describe('validation', () => {
      it.each([
        ['has uppercase letters', 'Main'],
        ['starts with "-"', '-main'],
        ['is longer than 63 characters', 'a'.repeat(64)],
      ])('returns 400 VALIDATION when the name %s', async (_title, name) => {
        const res = await remove(name, 'env').expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(executeDelete).not.toHaveBeenCalled();
      });
    });

    describe('errors', () => {
      it('returns 404 LEDGER_NOT_FOUND when there is no such ledger', async () => {
        executeDelete.mockRejectedValue(new LedgerNotFoundError('main'));

        const res = await remove('main', 'env').expect(404);

        expect(res.body).toEqual({
          errorCode: 'LEDGER_NOT_FOUND',
          errorMessage: 'Ledger "main" not found',
        });
      });

      it('returns 500 INTERNAL, with no details, for an unknown error', async () => {
        executeDelete.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

        const res = await remove('main', 'env').expect(500);

        expect(res.body).toEqual({ errorCode: 'INTERNAL', errorMessage: 'Internal server error' });
      });
    });
  });
});
