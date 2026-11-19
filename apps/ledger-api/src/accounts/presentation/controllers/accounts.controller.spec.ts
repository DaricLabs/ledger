import { randomUUIDv7 } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AccountAddress,
  AssetCode,
  InvalidMetadataError,
  Metadata,
  MetadataLimitExceededError,
  Money,
} from '@ledger/domain';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { ErrorsModule } from '../../../core/errors/errors.module.js';
import { ORGANIZATION_ID_HEADER } from '../../../core/tenant/tenant.guard.js';
import { ValidationModule } from '../../../core/validation/validation.module.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { DeleteAccountMetadataUseCase } from '../../application/use-cases/delete-account-metadata.use-case.js';
import { GetAccountUseCase } from '../../application/use-cases/get-account.use-case.js';
import { ListAccountsUseCase } from '../../application/use-cases/list-accounts.use-case.js';
import { SaveAccountMetadataUseCase } from '../../application/use-cases/save-account-metadata.use-case.js';
import { AccountDomainError } from '../../domain/errors/account-domain.error.js';
import { AccountNotFoundError } from '../../domain/errors/account-not-found.error.js';
import { Account } from '../../domain/entities/account.entity.js';
import { encodeAccountCursor } from '../dto/account-page-cursor.dto.js';
import { AccountsController } from './accounts.controller.js';

// These tests start a real Nest app with the real guard, validation pipe and
// error filters. Only the use case is fake, so no database is needed.
describe('AccountsController', () => {
  const executeGet = vi.fn<GetAccountUseCase['execute']>();
  const executeList = vi.fn<ListAccountsUseCase['execute']>();
  const executeSave = vi.fn<SaveAccountMetadataUseCase['execute']>();
  const executeDelete = vi.fn<DeleteAccountMetadataUseCase['execute']>();
  const organizationId = randomUUIDv7();
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ErrorsModule,
        ValidationModule,
      ],
      controllers: [AccountsController],
      providers: [
        { provide: GetAccountUseCase, useValue: { execute: executeGet } },
        { provide: ListAccountsUseCase, useValue: { execute: executeList } },
        { provide: SaveAccountMetadataUseCase, useValue: { execute: executeSave } },
        { provide: DeleteAccountMetadataUseCase, useValue: { execute: executeDelete } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    executeGet.mockReset();
    executeList.mockReset();
    executeSave.mockReset();
    executeDelete.mockReset();
  });

  const usd = AssetCode.of('USD');
  const eur = AssetCode.of('EUR');

  const stored = (overrides: Partial<Parameters<typeof Account.reconstitute>[0]> = {}) =>
    Account.reconstitute({
      address: AccountAddress.of('users:1'),
      allowOverdraft: false,
      metadata: Metadata.empty(),
      createdAt: new Date('2026-11-09T10:00:00.000Z'),
      balances: [Money.of(eur, 5n), Money.of(usd, 1050n)],
      ...overrides,
    });

  /** `org` is the header value. Pass `null` to send no header at all. */
  const get = (address = 'users:1', ledger = 'main', org: string | null = organizationId) => {
    const req = request(app.getHttpServer()).get(`/ledgers/${ledger}/accounts/${address}`);
    return org === null ? req : req.set(ORGANIZATION_ID_HEADER, org);
  };

  describe('success', () => {
    it('returns 200 with the account, and amounts as strings', async () => {
      executeGet.mockResolvedValue(stored());

      const res = await get().expect(200);

      expect(res.body).toEqual({
        address: 'users:1',
        allowOverdraft: false,
        balances: [
          { asset: 'EUR', amount: '5' },
          { asset: 'USD', amount: '1050' },
        ],
        metadata: {},
        createdAt: '2026-11-09T10:00:00.000Z',
      });
    });

    it('sends the metadata of the account', async () => {
      executeGet.mockResolvedValue(
        stored({ metadata: Metadata.of({ customerId: 'c_42', tier: 'gold' }) }),
      );

      const res = await get().expect(200);

      expect(res.body.metadata).toEqual({ customerId: 'c_42', tier: 'gold' });
    });

    it('shows a negative balance of an account that may go below zero', async () => {
      executeGet.mockResolvedValue(
        stored({
          address: AccountAddress.WORLD,
          allowOverdraft: true,
          balances: [Money.of(usd, -1050n)],
        }),
      );

      const res = await get('world').expect(200);

      expect(res.body).toMatchObject({
        address: 'world',
        allowOverdraft: true,
        balances: [{ asset: 'USD', amount: '-1050' }],
      });
    });

    it('sends an empty list for an account that holds nothing', async () => {
      executeGet.mockResolvedValue(stored({ balances: [] }));

      const res = await get().expect(200);

      expect(res.body.balances).toEqual([]);
    });

    it('keeps every digit of a very big amount', async () => {
      const big = 10n ** 77n + 1n;
      executeGet.mockResolvedValue(stored({ balances: [Money.of(usd, big)] }));

      const res = await get().expect(200);

      expect(res.body.balances).toEqual([{ asset: 'USD', amount: big.toString() }]);
    });

    it('gives the use case the organization, the ledger name and the address', async () => {
      executeGet.mockResolvedValue(stored());

      await get('platform:fees:eu', 'my-ledger').expect(200);

      expect(executeGet).toHaveBeenCalledExactlyOnceWith({
        organizationId,
        ledgerName: 'my-ledger',
        address: 'platform:fees:eu',
      });
    });
  });

  describe('errors', () => {
    it('returns 404 ACCOUNT_NOT_FOUND when the ledger has no such account', async () => {
      executeGet.mockRejectedValue(new AccountNotFoundError('users:1'));

      const res = await get().expect(404);

      expect(res.body).toEqual({
        errorCode: 'ACCOUNT_NOT_FOUND',
        errorMessage: 'Account not found in the ledger',
      });
    });

    it('returns 404 LEDGER_NOT_FOUND when there is no such ledger', async () => {
      executeGet.mockRejectedValue(new LedgerNotFoundError('main'));

      const res = await get().expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
    });

    it('answers 500 and hides the details for an account error that has no status yet', async () => {
      class UnmappedAccountError extends AccountDomainError {
        readonly code = 'UNMAPPED';
      }
      executeGet.mockRejectedValue(new UnmappedAccountError('secret detail'));

      const res = await get().expect(500);

      expect(JSON.stringify(res.body)).not.toContain('secret detail');
      expect(JSON.stringify(res.body)).not.toContain('UNMAPPED');
    });

    it('answers 500 for an error that is not a domain error', async () => {
      executeGet.mockRejectedValue(new Error('database is down'));

      const res = await get().expect(500);

      expect(JSON.stringify(res.body)).not.toContain('database is down');
    });
  });

  describe('validation (400 VALIDATION)', () => {
    it.each([
      ['has an uppercase letter', 'Users:1'],
      ['has an empty part', 'users::1'],
      ['ends with a colon', 'users:'],
      ['starts with an underscore', '_users'],
      ['has a space', 'users%201'],
      ['is too long', `a${'b'.repeat(256)}`],
    ])('refuses an address that %s', async (_label, address) => {
      const res = await get(address).expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
      expect(executeGet).not.toHaveBeenCalled();
    });

    it('refuses a ledger name with a wrong shape', async () => {
      const res = await get('users:1', 'Bad_Name').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
      expect(executeGet).not.toHaveBeenCalled();
    });

    it('reads an address whose colon is written as %3A', async () => {
      executeGet.mockResolvedValue(stored());

      await get('users%3A1').expect(200);

      expect(executeGet).toHaveBeenCalledWith(expect.objectContaining({ address: 'users:1' }));
    });
  });

  describe('tenant guard', () => {
    it('refuses a request without the organization header', async () => {
      await get('users:1', 'main', null).expect(400);

      expect(executeGet).not.toHaveBeenCalled();
    });

    it('checks the header before the address', async () => {
      const res = await get('Bad_Address', 'main', null).expect(400);

      // The guard refused it, so the pipe never looked at the address.
      expect(res.body.errorCode).not.toBe('VALIDATION');
    });
  });

  describe('GET /ledgers/:ledgerName/accounts', () => {
    const first = stored({ address: AccountAddress.of('users:1') });
    const second = stored({
      address: AccountAddress.of('users:2'),
      balances: [Money.of(usd, 7n)],
    });

    beforeEach(() => {
      executeList.mockResolvedValue({ accounts: [first], hasMore: false });
    });

    /** `org` is the header value. Pass `null` to send no header at all. */
    const list = (query = '', ledger = 'main', org: string | null = organizationId) => {
      const req = request(app.getHttpServer()).get(`/ledgers/${ledger}/accounts${query}`);
      return org === null ? req : req.set(ORGANIZATION_ID_HEADER, org);
    };

    describe('success', () => {
      it('returns 200 with the accounts in "data", in the same shape as get', async () => {
        const res = await list().expect(200);

        expect(res.body).toEqual({
          data: [
            {
              address: 'users:1',
              allowOverdraft: false,
              balances: [
                { asset: 'EUR', amount: '5' },
                { asset: 'USD', amount: '1050' },
              ],
              metadata: {},
              createdAt: '2026-11-09T10:00:00.000Z',
            },
          ],
          hasMore: false,
        });
      });

      it('keeps the order the use case gives', async () => {
        executeList.mockResolvedValue({ accounts: [first, second], hasMore: false });

        const res = await list().expect(200);

        expect(res.body.data.map((a: { address: string }) => a.address)).toEqual([
          'users:1',
          'users:2',
        ]);
      });

      it('returns an empty page when the ledger has no accounts', async () => {
        executeList.mockResolvedValue({ accounts: [], hasMore: false });

        const res = await list().expect(200);

        expect(res.body).toEqual({ data: [], hasMore: false });
      });

      it('gives the use case the organization, the ledger name, the default page size and no position', async () => {
        await list('', 'my-ledger').expect(200);

        expect(executeList).toHaveBeenCalledExactlyOnceWith({
          organizationId,
          ledgerName: 'my-ledger',
          pageSize: 15,
          afterAddress: undefined,
        });
      });

      it('gives the use case the page size of the query', async () => {
        await list('?pageSize=3').expect(200);

        expect(executeList).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 3 }));
      });

      it('gives the use case the address that the cursor holds', async () => {
        await list(`?cursor=${encodeAccountCursor('users:1')}`).expect(200);

        expect(executeList).toHaveBeenCalledWith(
          expect.objectContaining({ afterAddress: 'users:1' }),
        );
      });
    });

    describe('next page', () => {
      it('sends "next" and hasMore when there are more accounts', async () => {
        executeList.mockResolvedValue({ accounts: [first, second], hasMore: true });

        const res = await list('?pageSize=2').expect(200);

        expect(res.body.hasMore).toBe(true);
        // The cursor of the last account of the page.
        expect(res.body.next).toBe(encodeAccountCursor('users:2'));
      });

      it('sends no "next" on the last page', async () => {
        const res = await list().expect(200);

        expect(res.body).not.toHaveProperty('next');
      });

      it('makes a "next" that the same route accepts', async () => {
        executeList.mockResolvedValue({ accounts: [first, second], hasMore: true });
        const page = await list('?pageSize=2').expect(200);

        await list(`?cursor=${page.body.next}`).expect(200);

        expect(executeList).toHaveBeenLastCalledWith(
          expect.objectContaining({ afterAddress: 'users:2' }),
        );
      });
    });

    describe('errors', () => {
      it('returns 404 LEDGER_NOT_FOUND when there is no such ledger', async () => {
        executeList.mockRejectedValue(new LedgerNotFoundError('main'));

        const res = await list().expect(404);

        expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
      });

      it('returns 400 VALIDATION for a ledger name with a wrong shape', async () => {
        const res = await list('', 'Bad_Name').expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(executeList).not.toHaveBeenCalled();
      });

      it('refuses a request without the organization header', async () => {
        await list('', 'main', null).expect(400);

        expect(executeList).not.toHaveBeenCalled();
      });
    });

    describe('query validation', () => {
      const cursorOf = (text: string) => Buffer.from(text).toString('base64url');
      const invalidQueries: [string, string, string][] = [
        ['pageSize is 0', '?pageSize=0', 'pageSize'],
        ['pageSize is above 100', '?pageSize=101', 'pageSize'],
        ['pageSize is negative', '?pageSize=-1', 'pageSize'],
        ['pageSize is not a number', '?pageSize=abc', 'pageSize'],
        ['pageSize is empty', '?pageSize=', 'pageSize'],
        ['pageSize is sent twice', '?pageSize=1&pageSize=2', 'pageSize'],
        ['the cursor is not a cursor', '?cursor=hello', 'cursor'],
        ['the cursor is empty', '?cursor=', 'cursor'],
        ['the cursor is sent twice', '?cursor=a&cursor=b', 'cursor'],
        ['the cursor holds a bad address', `?cursor=${cursorOf('{"key":"Users:1"}')}`, 'cursor'],
        ['a query parameter is unknown', '?pagesize=5', ''],
      ];

      it.each(invalidQueries)('returns 400 VALIDATION when %s', async (_title, query, path) => {
        const res = await list(query).expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
        expect(executeList).not.toHaveBeenCalled();
      });
    });
  });

  describe('metadata', () => {
    const url = (address = 'users:1', ledger = 'main') =>
      `/ledgers/${ledger}/accounts/${address}/metadata`;

    /** `org` is the header value. Pass `null` to send no header at all. */
    const save = (
      body: unknown = { customerId: 'c_42' },
      address = 'users:1',
      ledger = 'main',
      org: string | null = organizationId,
    ) => {
      const req = request(app.getHttpServer())
        .post(url(address, ledger))
        .send(body as object);
      return org === null ? req : req.set(ORGANIZATION_ID_HEADER, org);
    };

    const remove = (
      key = 'customerId',
      address = 'users:1',
      ledger = 'main',
      org: string | null = organizationId,
    ) => {
      const req = request(app.getHttpServer()).delete(`${url(address, ledger)}/${key}`);
      return org === null ? req : req.set(ORGANIZATION_ID_HEADER, org);
    };

    beforeEach(() => {
      executeSave.mockResolvedValue(undefined);
      executeDelete.mockResolvedValue(undefined);
    });

    describe('POST /ledgers/:ledgerName/accounts/:address/metadata', () => {
      it('returns 204 with no body, and gives the use case the organization, ledger, address and entries', async () => {
        const res = await save({ customerId: 'c_42', tier: 'gold' }, 'users:1', 'my-ledger').expect(
          204,
        );

        expect(res.text).toBe('');
        expect(executeSave).toHaveBeenCalledExactlyOnceWith({
          organizationId,
          ledgerName: 'my-ledger',
          address: 'users:1',
          metadata: { customerId: 'c_42', tier: 'gold' },
        });
      });

      it('reads an address whose colon is written as %3A', async () => {
        await save({ a: '1' }, 'platform%3Afees%3Aeu').expect(204);

        expect(executeSave).toHaveBeenCalledWith(
          expect.objectContaining({ address: 'platform:fees:eu' }),
        );
      });

      it('returns 404 ACCOUNT_NOT_FOUND when the ledger has no such account', async () => {
        executeSave.mockRejectedValue(new AccountNotFoundError('users:1'));

        const res = await save().expect(404);

        expect(res.body).toEqual({
          errorCode: 'ACCOUNT_NOT_FOUND',
          errorMessage: 'Account not found in the ledger',
        });
      });

      it('returns 404 LEDGER_NOT_FOUND when there is no such ledger', async () => {
        executeSave.mockRejectedValue(new LedgerNotFoundError('main'));

        const res = await save().expect(404);

        expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
      });

      it('returns 400 INVALID_METADATA when the domain refuses the metadata', async () => {
        executeSave.mockRejectedValue(new InvalidMetadataError('Metadata keys must not be empty'));

        const res = await save().expect(400);

        expect(res.body.errorCode).toBe('INVALID_METADATA');
      });

      it('returns 400 METADATA_LIMIT_EXCEEDED when the metadata is too big', async () => {
        executeSave.mockRejectedValue(new MetadataLimitExceededError('total', 65536));

        const res = await save().expect(400);

        expect(res.body.errorCode).toBe('METADATA_LIMIT_EXCEEDED');
      });

      it('answers 500 and hides the details for an error that is not a domain error', async () => {
        executeSave.mockRejectedValue(new Error('database is down'));

        const res = await save().expect(500);

        expect(JSON.stringify(res.body)).not.toContain('database is down');
      });

      describe('validation (400 VALIDATION)', () => {
        it.each([
          ['an empty object', {}],
          ['an array', [{ a: '1' }]],
          ['a number value', { a: 1 }],
          ['a null value', { a: null }],
          ['an object value', { a: { b: '1' } }],
          ['an empty key', { '': 'x' }],
        ])('refuses %s as the body', async (_name, body) => {
          const res = await save(body).expect(400);

          expect(res.body.errorCode).toBe('VALIDATION');
          expect(executeSave).not.toHaveBeenCalled();
        });

        it('refuses a missing body', async () => {
          const res = await request(app.getHttpServer())
            .post(url())
            .set(ORGANIZATION_ID_HEADER, organizationId)
            .expect(400);

          expect(res.body.errorCode).toBe('VALIDATION');
          expect(executeSave).not.toHaveBeenCalled();
        });

        it('refuses an address with a wrong shape', async () => {
          const res = await save({ a: '1' }, 'Bad_Address').expect(400);

          expect(res.body.errorCode).toBe('VALIDATION');
          expect(executeSave).not.toHaveBeenCalled();
        });

        it('refuses a ledger name with a wrong shape', async () => {
          const res = await save({ a: '1' }, 'users:1', 'Bad Ledger').expect(400);

          expect(res.body.errorCode).toBe('VALIDATION');
          expect(executeSave).not.toHaveBeenCalled();
        });
      });

      describe('tenant guard', () => {
        it('refuses a request without the organization header', async () => {
          await save({ a: '1' }, 'users:1', 'main', null).expect(400);

          expect(executeSave).not.toHaveBeenCalled();
        });
      });
    });

    describe('DELETE /ledgers/:ledgerName/accounts/:address/metadata/:key', () => {
      it('returns 204 with no body, and gives the use case the organization, ledger, address and key', async () => {
        const res = await remove('customerId', 'users:1', 'my-ledger').expect(204);

        expect(res.text).toBe('');
        expect(executeDelete).toHaveBeenCalledExactlyOnceWith({
          organizationId,
          ledgerName: 'my-ledger',
          address: 'users:1',
          key: 'customerId',
        });
      });

      it('reads an address and a key that are written with %3A', async () => {
        await remove('order%3A42', 'platform%3Afees%3Aeu').expect(204);

        expect(executeDelete).toHaveBeenCalledWith(
          expect.objectContaining({ address: 'platform:fees:eu', key: 'order:42' }),
        );
      });

      it('returns 404 ACCOUNT_NOT_FOUND when the ledger has no such account', async () => {
        executeDelete.mockRejectedValue(new AccountNotFoundError('users:1'));

        const res = await remove().expect(404);

        expect(res.body.errorCode).toBe('ACCOUNT_NOT_FOUND');
      });

      it('returns 404 LEDGER_NOT_FOUND when there is no such ledger', async () => {
        executeDelete.mockRejectedValue(new LedgerNotFoundError('main'));

        const res = await remove().expect(404);

        expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
      });

      it('refuses an address with a wrong shape', async () => {
        const res = await remove('a', 'Bad_Address').expect(400);

        expect(res.body.errorCode).toBe('VALIDATION');
        expect(executeDelete).not.toHaveBeenCalled();
      });

      it('refuses a request without the organization header', async () => {
        await remove('a', 'users:1', 'main', null).expect(400);

        expect(executeDelete).not.toHaveBeenCalled();
      });
    });
  });
});
