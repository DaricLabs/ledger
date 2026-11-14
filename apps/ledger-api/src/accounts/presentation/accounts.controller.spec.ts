import { randomUUIDv7 } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { ErrorsModule } from '../../core/errors/errors.module.js';
import { ORGANIZATION_ID_HEADER } from '../../core/tenant/tenant.guard.js';
import { ValidationModule } from '../../core/validation/validation.module.js';
import { LedgerNotFoundError } from '../../ledgers/domain/errors/ledger-not-found.error.js';
import { GetAccountUseCase } from '../application/use-cases/get-account.use-case.js';
import { ListAccountsUseCase } from '../application/use-cases/list-accounts.use-case.js';
import { AccountDomainError } from '../domain/account-domain.error.js';
import { AccountNotFoundError } from '../domain/account-not-found.error.js';
import { Account } from '../domain/account.entity.js';
import { encodeAccountCursor } from './dto/account-page-cursor.dto.js';
import { AccountsController } from './accounts.controller.js';

// These tests start a real Nest app with the real guard, validation pipe and
// error filters. Only the use case is fake, so no database is needed.
describe('AccountsController', () => {
  const executeGet = vi.fn<GetAccountUseCase['execute']>();
  const executeList = vi.fn<ListAccountsUseCase['execute']>();
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
  });

  const usd = AssetCode.of('USD');
  const eur = AssetCode.of('EUR');

  const stored = (overrides: Partial<Parameters<typeof Account.reconstitute>[0]> = {}) =>
    Account.reconstitute({
      address: AccountAddress.of('users:1'),
      allowOverdraft: false,
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
        createdAt: '2026-11-09T10:00:00.000Z',
      });
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
});
