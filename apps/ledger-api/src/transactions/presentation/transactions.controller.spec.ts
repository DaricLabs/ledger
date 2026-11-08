import { randomUUIDv7 } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountAddress, AssetCode, InvalidAccountAddressError, Money } from '@ledger/domain';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { ErrorsModule } from '../../core/errors/errors.module.js';
import { ORGANIZATION_ID_HEADER } from '../../core/tenant/tenant.guard.js';
import { ValidationModule } from '../../core/validation/validation.module.js';
import { LedgerNotFoundError } from '../../ledgers/domain/ledger-not-found.error.js';
import { CreateTransactionUseCase } from '../application/use-cases/create-transaction.use-case.js';
import { GetTransactionUseCase } from '../application/use-cases/get-transaction.use-case.js';
import { InsufficientFundsError } from '../domain/insufficient-funds.error.js';
import { InvalidPostingError } from '../domain/invalid-posting.error.js';
import { InvalidTransactionError } from '../domain/invalid-transaction.error.js';
import { Posting } from '../domain/posting.js';
import { TransactionDomainError } from '../domain/transaction-domain.error.js';
import { TransactionNotFoundError } from '../domain/transaction-not-found.error.js';
import { TransactionReferenceAlreadyExistsError } from '../domain/transaction-reference-already-exists.error.js';
import { Transaction } from '../domain/transaction.entity.js';
import { TransactionsController } from './transactions.controller.js';

// These tests start a real Nest app with the real guard, validation pipe and
// error filters. Only the use case is fake, so no database is needed.
describe('TransactionsController', () => {
  const execute = vi.fn<CreateTransactionUseCase['execute']>();
  const executeGet = vi.fn<GetTransactionUseCase['execute']>();
  const organizationId = randomUUIDv7();
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ErrorsModule,
        ValidationModule,
      ],
      controllers: [TransactionsController],
      providers: [
        { provide: CreateTransactionUseCase, useValue: { execute } },
        { provide: GetTransactionUseCase, useValue: { execute: executeGet } },
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
    // Builds a transaction from the input, like the real use case does.
    execute.mockImplementation(async (input) =>
      Transaction.create({
        id: '0190a5d4-7b3c-7abc-8def-0123456789ab',
        organizationId: input.organizationId,
        ledgerId: '0190a5d4-7b3c-7abc-8def-0123456789ac',
        reference: input.reference ?? null,
        postings: input.postings.map((p) =>
          Posting.of(
            AccountAddress.of(p.source),
            AccountAddress.of(p.destination),
            Money.of(AssetCode.of(p.asset), p.amount),
          ),
        ),
        postedAt: new Date('2026-11-07T10:00:00.000Z'),
        createdAt: new Date('2026-11-07T10:00:01.000Z'),
      }),
    );
  });

  const validBody = {
    reference: 'order-1',
    postings: [{ source: 'world', destination: 'users:1', asset: 'USD', amount: '1050' }],
  };

  /** `org` is the header value. Pass `null` to send no header at all. */
  const post = (body?: unknown, ledger = 'main', org: string | null = organizationId) => {
    const req = request(app.getHttpServer()).post(`/ledgers/${ledger}/transactions`);
    if (org !== null) req.set(ORGANIZATION_ID_HEADER, org);
    return body === undefined ? req : req.send(body as object);
  };

  describe('success', () => {
    it('returns 201 with the transaction, and amounts as strings', async () => {
      const res = await post(validBody).expect(201);

      expect(res.body).toEqual({
        id: '0190a5d4-7b3c-7abc-8def-0123456789ab',
        reference: 'order-1',
        postings: [{ source: 'world', destination: 'users:1', asset: 'USD', amount: '1050' }],
        postedAt: '2026-11-07T10:00:00.000Z',
        createdAt: '2026-11-07T10:00:01.000Z',
      });
    });

    it('sends the URL of the new transaction in the Location header', async () => {
      const res = await post(validBody, 'my-ledger').expect(201);

      expect(res.headers.location).toBe(
        '/ledgers/my-ledger/transactions/0190a5d4-7b3c-7abc-8def-0123456789ab',
      );
    });

    it('returns a null reference when none was sent', async () => {
      const res = await post({ postings: validBody.postings }).expect(201);

      expect(res.body.reference).toBeNull();
    });

    it('gives the use case the organization, the ledger name and the parsed body', async () => {
      await post(validBody, 'my-ledger').expect(201);

      expect(execute).toHaveBeenCalledExactlyOnceWith({
        organizationId,
        ledgerName: 'my-ledger',
        reference: 'order-1',
        postings: [{ source: 'world', destination: 'users:1', asset: 'USD', amount: 1050n }],
      });
    });

    it('keeps every digit of a very big amount', async () => {
      const amount = '9'.repeat(78);
      const body = { postings: [{ ...validBody.postings[0], amount }] };

      const res = await post(body).expect(201);

      expect(res.body.postings[0].amount).toBe(amount);
      expect(execute.mock.calls[0]?.[0].postings[0]?.amount).toBe(10n ** 78n - 1n);
    });
  });

  describe('validation (400 VALIDATION)', () => {
    const expectValidation = async (body: unknown, path: string) => {
      const res = await post(body).expect(400);
      expect(res.body.errorCode).toBe('VALIDATION');
      expect(res.body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
      expect(execute).not.toHaveBeenCalled();
    };

    it('needs postings', () => expectValidation({}, 'postings'));
    it('needs at least one posting', () => expectValidation({ postings: [] }, 'postings'));

    it('allows at most 100 postings', () =>
      expectValidation(
        { postings: Array.from({ length: 101 }, () => validBody.postings[0]) },
        'postings',
      ));

    it('refuses an unknown field of the body', () =>
      expectValidation({ ...validBody, refrence: 'typo' }, ''));

    it('refuses an unknown field of a posting', () =>
      expectValidation({ postings: [{ ...validBody.postings[0], note: 'x' }] }, 'postings.0'));

    it.each(['source', 'destination', 'asset', 'amount'])('needs the posting field %s', (field) => {
      const posting = { ...validBody.postings[0] } as Record<string, unknown>;
      delete posting[field];
      return expectValidation({ postings: [posting] }, `postings.0.${field}`);
    });

    it.each(['Users:1', 'users::1', ':users', '', 'a b', 'a'.repeat(257)])(
      'refuses the account address %j',
      (address) =>
        expectValidation(
          { postings: [{ ...validBody.postings[0], source: address }] },
          'postings.0.source',
        ),
    );

    it.each(['usd', 'US', '1USD', 'USD$', 'A'.repeat(17)])('refuses the asset %j', (asset) =>
      expectValidation({ postings: [{ ...validBody.postings[0], asset }] }, 'postings.0.asset'),
    );

    it.each([
      ['a JSON number', 1050],
      ['zero', '0'],
      ['a negative number', '-5'],
      ['a decimal', '10.5'],
      ['a leading zero', '01'],
      ['an exponent', '1e3'],
      ['text', 'ten'],
      ['an empty string', ''],
      ['more than 78 digits', '1'.repeat(79)],
    ])('refuses an amount that is %s', (_name, amount) =>
      expectValidation({ postings: [{ ...validBody.postings[0], amount }] }, 'postings.0.amount'),
    );

    it.each(['', 'r'.repeat(129)])('refuses the reference %j', (reference) =>
      expectValidation({ ...validBody, reference }, 'reference'),
    );

    it('refuses a ledger name with a wrong shape', async () => {
      const res = await post(validBody, 'Not_Valid').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('tenant guard', () => {
    it('refuses a request without the organization header', async () => {
      await post(validBody, 'main', null).expect(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('domain errors', () => {
    it.each([
      ['LedgerNotFoundError', new LedgerNotFoundError('main'), 404, 'LEDGER_NOT_FOUND'],
      [
        'TransactionReferenceAlreadyExistsError',
        new TransactionReferenceAlreadyExistsError('order-1'),
        409,
        'TRANSACTION_REFERENCE_ALREADY_EXISTS',
      ],
      [
        'InsufficientFundsError',
        new InsufficientFundsError('users:1', 'USD', '10', '11'),
        422,
        'INSUFFICIENT_FUNDS',
      ],
      ['InvalidPostingError', new InvalidPostingError('bad posting'), 400, 'INVALID_POSTING'],
      [
        'InvalidTransactionError',
        new InvalidTransactionError('bad transaction'),
        400,
        'INVALID_TRANSACTION',
      ],
      ['a value object error', new InvalidAccountAddressError(), 400, 'INVALID_ACCOUNT_ADDRESS'],
    ])('turns %s into %i %s', async (_name, error, status, code) => {
      execute.mockRejectedValueOnce(error);

      const res = await post(validBody).expect(status as number);

      expect(res.body).toEqual({ errorCode: code, errorMessage: error.message });
    });

    it('tells the client what is missing when funds are not enough', async () => {
      execute.mockRejectedValueOnce(new InsufficientFundsError('users:1', 'USD', '10', '11'));

      const res = await post(validBody).expect(422);

      expect(res.body.errorMessage).toBe(
        'Account "users:1" has not enough USD: balance is 10, but 11 is needed',
      );
    });

    it('answers 500 and hides the details for a transaction error that has no status yet', async () => {
      class NewError extends TransactionDomainError {
        readonly code = 'NEW_ERROR';
      }
      execute.mockRejectedValueOnce(new NewError('secret detail'));

      const res = await post(validBody).expect(500);

      expect(res.body).toEqual({ errorCode: 'INTERNAL', errorMessage: 'Internal server error' });
    });

    it('answers 500 for an error that is not a domain error', async () => {
      execute.mockRejectedValueOnce(new Error('connection lost'));

      const res = await post(validBody).expect(500);

      expect(res.body.errorMessage).toBe('Internal server error');
    });
  });

  describe('GET /ledgers/:ledgerName/transactions/:transactionId', () => {
    const transactionId = '0190a5d4-7b3c-7abc-8def-0123456789ab';

    const stored = () =>
      Transaction.reconstitute({
        id: transactionId,
        organizationId,
        ledgerId: '0190a5d4-7b3c-7abc-8def-0123456789ac',
        reference: 'order-1',
        postings: [
          Posting.of(
            AccountAddress.of('world'),
            AccountAddress.of('users:1'),
            Money.of(AssetCode.of('USD'), 1050n),
          ),
        ],
        postedAt: new Date('2026-11-07T10:00:00.000Z'),
        createdAt: new Date('2026-11-07T10:00:01.000Z'),
      });

    /** `org` is the header value. Pass `null` to send no header at all. */
    const get = (
      id: string = transactionId,
      ledger = 'main',
      org: string | null = organizationId,
    ) => {
      const req = request(app.getHttpServer()).get(`/ledgers/${ledger}/transactions/${id}`);
      return org === null ? req : req.set(ORGANIZATION_ID_HEADER, org);
    };

    it('returns 200 with the transaction, in the same shape as create', async () => {
      executeGet.mockResolvedValue(stored());

      const res = await get().expect(200);

      expect(res.body).toEqual({
        id: transactionId,
        reference: 'order-1',
        postings: [{ source: 'world', destination: 'users:1', asset: 'USD', amount: '1050' }],
        postedAt: '2026-11-07T10:00:00.000Z',
        createdAt: '2026-11-07T10:00:01.000Z',
      });
    });

    it('gives the use case the organization, the ledger name and the id', async () => {
      executeGet.mockResolvedValue(stored());

      await get(transactionId, 'my-ledger').expect(200);

      expect(executeGet).toHaveBeenCalledExactlyOnceWith({
        organizationId,
        ledgerName: 'my-ledger',
        transactionId,
      });
    });

    it('returns 404 TRANSACTION_NOT_FOUND when the ledger has no such transaction', async () => {
      executeGet.mockRejectedValue(new TransactionNotFoundError(transactionId));

      const res = await get().expect(404);

      expect(res.body).toEqual({
        errorCode: 'TRANSACTION_NOT_FOUND',
        errorMessage: 'Transaction not found in the ledger',
      });
    });

    it('returns 404 LEDGER_NOT_FOUND when there is no such ledger', async () => {
      executeGet.mockRejectedValue(new LedgerNotFoundError('main'));

      const res = await get().expect(404);

      expect(res.body.errorCode).toBe('LEDGER_NOT_FOUND');
    });

    it.each([
      ['not a uuid', 'abc'],
      ['a UUIDv4', '3b241101-e2bb-4255-8caf-4136c566a962'],
      ['a number', '12345'],
    ])('returns 400 VALIDATION when the id is %s', async (_label, id) => {
      const res = await get(id).expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
      expect(executeGet).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION for a ledger name with a wrong shape', async () => {
      const res = await get(transactionId, 'Bad_Name').expect(400);

      expect(res.body.errorCode).toBe('VALIDATION');
      expect(executeGet).not.toHaveBeenCalled();
    });

    it('refuses a request without the organization header', async () => {
      await get(transactionId, 'main', null).expect(400);

      expect(executeGet).not.toHaveBeenCalled();
    });
  });
});
