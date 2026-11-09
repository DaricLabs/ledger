import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import type { INestApplication } from '@nestjs/common';
import { unwrapTenantTransaction, withTenant, type LedgerDatabase } from '@ledger/database/storage';
import { KYSELY_DB } from '../core/database/database.tokens.js';
import { Uuidv7IdGenerator } from '../ids/infrastructure/uuidv7-id-generator.js';
import { CreateLedgerUseCase } from '../ledgers/application/use-cases/create-ledger.use-case.js';
import { LedgerNotFoundError } from '../ledgers/domain/ledger-not-found.error.js';
import {
  CreateTransactionUseCase,
  type ICreateTransactionInput,
} from './application/use-cases/create-transaction.use-case.js';
import { GetTransactionUseCase } from './application/use-cases/get-transaction.use-case.js';
import { ListTransactionsUseCase } from './application/use-cases/list-transactions.use-case.js';
import { InsufficientFundsError } from './domain/insufficient-funds.error.js';
import { TransactionNotFoundError } from './domain/transaction-not-found.error.js';
import { TransactionReferenceAlreadyExistsError } from './domain/transaction-reference-already-exists.error.js';
import { TransactionsModule } from './transactions.module.js';

// Every test uses new organization ids, so tests never see each other's rows
// and nothing has to be cleaned up (the append-only tables cannot be cleaned anyway).
const newOrganizationId = () => new Uuidv7IdGenerator().next();

describe('TransactionsModule (real database)', () => {
  let app: INestApplication;
  let db: LedgerDatabase;
  let createLedger: CreateLedgerUseCase;
  let createTransaction: CreateTransactionUseCase;
  let getTransaction: GetTransactionUseCase;
  let listTransactions: ListTransactionsUseCase;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ LEDGER_RUNTIME_DATABASE_URL: process.env.LEDGER_RUNTIME_DATABASE_URL })],
        }),
        // The controller uses TenantGuard, and the guard needs PinoLogger.
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        TransactionsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get<LedgerDatabase>(KYSELY_DB);
    createLedger = app.get(CreateLedgerUseCase);
    createTransaction = app.get(CreateTransactionUseCase);
    getTransaction = app.get(GetTransactionUseCase);
    listTransactions = app.get(ListTransactionsUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  /** A new organization with a ledger called `main`. */
  async function setup() {
    const organizationId = newOrganizationId();
    const ledger = await createLedger.execute({ organizationId, name: 'main', metadata: {} });
    return { organizationId, ledgerId: ledger.id };
  }

  const move = (
    organizationId: string,
    postings: ICreateTransactionInput['postings'],
    reference?: string,
  ) => createTransaction.execute({ organizationId, ledgerName: 'main', postings, reference });

  const posting = (source: string, destination: string, amount: bigint, asset = 'USD') => ({
    source,
    destination,
    asset,
    amount,
  });

  /** Reads the tables the way the API would: as one tenant, with row-level security on. */
  const readState = (organizationId: string) =>
    withTenant(db, organizationId, async (trx) => {
      const k = unwrapTenantTransaction(trx);
      return {
        accounts: await k.selectFrom('accounts').selectAll().orderBy('address').execute(),
        balances: await k
          .selectFrom('balances')
          .selectAll()
          .orderBy('account_address')
          .orderBy('asset')
          .execute(),
        transactions: await k.selectFrom('transactions').selectAll().execute(),
        postings: await k.selectFrom('postings').selectAll().orderBy('seq').execute(),
        logs: await k.selectFrom('ledger_logs').selectAll().orderBy('seq').execute(),
        events: await k.selectFrom('outbox_events').selectAll().orderBy('id').execute(),
      };
    });

  const balancesOf = (state: Awaited<ReturnType<typeof readState>>) =>
    Object.fromEntries(
      state.balances.map((b) => [`${b.account_address} ${b.asset}`, b.balance] as const),
    );

  it('saves the transaction, balances, journal entry and outbox event together', async () => {
    const { organizationId, ledgerId } = await setup();

    const transaction = await move(
      organizationId,
      [posting('world', 'users:1', 1000n), posting('users:1', 'platform:fees', 25n)],
      'order-1',
    );
    const state = await readState(organizationId);

    expect(state.accounts.map((a) => [a.address, a.allow_overdraft])).toEqual([
      ['platform:fees', false],
      ['users:1', false],
      ['world', true],
    ]);
    expect(balancesOf(state)).toEqual({
      'platform:fees USD': '25',
      'users:1 USD': '975',
      'world USD': '-1000',
    });
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({
      id: transaction.id,
      ledger_id: ledgerId,
      reference: 'order-1',
      posted_at: transaction.postedAt,
    });
    expect(
      state.postings.map((p) => [p.seq, p.source_account, p.destination_account, p.amount]),
    ).toEqual([
      [1, 'world', 'users:1', '1000'],
      [2, 'users:1', 'platform:fees', '25'],
    ]);

    // The ledger-created log is seq 1, so the transaction log is seq 2.
    expect(state.logs).toHaveLength(2);
    expect(state.logs[1]).toMatchObject({
      seq: '2',
      type: 'TRANSACTION_CREATED',
      transaction_id: transaction.id,
      payload: {
        reference: 'order-1',
        postedAt: transaction.postedAt.toISOString(),
        postings: [
          { source: 'world', destination: 'users:1', asset: 'USD', amount: '1000' },
          { source: 'users:1', destination: 'platform:fees', asset: 'USD', amount: '25' },
        ],
      },
    });
    expect(state.events).toHaveLength(2);
    expect(state.events[1]).toMatchObject({
      ledger_id: ledgerId,
      aggregate_type: 'transaction',
      aggregate_id: transaction.id,
      event_type: 'ledger.transaction.created',
      published_at: null,
      payload: {
        transactionId: transaction.id,
        ledgerId,
        organizationId,
        reference: 'order-1',
        createdAt: transaction.createdAt.toISOString(),
      },
    });
  });

  it('keeps assets apart on the same account', async () => {
    const { organizationId } = await setup();

    await move(organizationId, [
      posting('world', 'users:1', 100n, 'USD'),
      posting('world', 'users:1', 7n, 'EUR'),
    ]);

    expect(balancesOf(await readState(organizationId))).toMatchObject({
      'users:1 USD': '100',
      'users:1 EUR': '7',
    });
  });

  it('refuses an account that spends more than it has, and saves nothing of the transaction', async () => {
    const { organizationId } = await setup();
    await move(organizationId, [posting('world', 'users:1', 100n)]);
    const before = await readState(organizationId);

    const error = await move(organizationId, [
      posting('world', 'users:2', 50n), // would be fine alone
      posting('users:1', 'users:2', 101n),
    ]).catch((thrown: unknown) => thrown);
    const after = await readState(organizationId);

    expect(error).toBeInstanceOf(InsufficientFundsError);
    expect(error).toMatchObject({
      account: 'users:1',
      asset: 'USD',
      balance: '100',
      needed: '101',
    });
    // The new account `users:2` is not there either: everything was rolled back.
    expect(after).toEqual(before);
  });

  it('applies postings in order: money must come in before it goes out', async () => {
    const { organizationId } = await setup();

    await expect(
      move(organizationId, [posting('users:1', 'users:2', 10n), posting('world', 'users:1', 10n)]),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    await move(organizationId, [
      posting('world', 'users:1', 10n),
      posting('users:1', 'users:2', 10n),
    ]);

    expect(balancesOf(await readState(organizationId))).toMatchObject({
      'users:1 USD': '0',
      'users:2 USD': '10',
    });
  });

  it('moves money only once for the same reference', async () => {
    const { organizationId } = await setup();
    await move(organizationId, [posting('world', 'users:1', 100n)], 'order-1');

    await expect(
      move(organizationId, [posting('world', 'users:1', 100n)], 'order-1'),
    ).rejects.toBeInstanceOf(TransactionReferenceAlreadyExistsError);
    const state = await readState(organizationId);

    expect(balancesOf(state)['users:1 USD']).toBe('100');
    expect(state.transactions).toHaveLength(1);
    expect(state.logs).toHaveLength(2); // ledger created + one transaction
  });

  it('accepts the biggest amount the columns can hold and refuses one more', async () => {
    const { organizationId } = await setup();
    const big = 10n ** 78n - 1n;

    await move(organizationId, [posting('world', 'users:1', big)]);
    expect(balancesOf(await readState(organizationId))).toMatchObject({
      'users:1 USD': big.toString(),
      'world USD': (-big).toString(),
    });

    // `users:1` would go above the limit, so the domain refuses it before the database can.
    await expect(move(organizationId, [posting('world', 'users:1', 1n)])).rejects.toMatchObject({
      code: 'MONEY_AMOUNT_OUT_OF_RANGE',
    });
  });

  it('throws LedgerNotFoundError for a ledger that does not exist', async () => {
    const organizationId = newOrganizationId();

    await expect(move(organizationId, [posting('world', 'users:1', 1n)])).rejects.toBeInstanceOf(
      LedgerNotFoundError,
    );
  });

  it('cannot use the ledger of another organization', async () => {
    await setup();

    await expect(
      move(newOrganizationId(), [posting('world', 'users:1', 1n)]),
    ).rejects.toBeInstanceOf(LedgerNotFoundError);
  });

  describe('get', () => {
    const get = (organizationId: string, transactionId: string, ledgerName = 'main') =>
      getTransaction.execute({ organizationId, ledgerName, transactionId });

    it('gives back the transaction that was created, the same way', async () => {
      const { organizationId } = await setup();
      const created = await move(
        organizationId,
        [posting('world', 'users:1', 1000n), posting('users:1', 'platform:fees', 25n)],
        'order-1',
      );

      const found = await get(organizationId, created.id);

      expect(found).toMatchObject({
        id: created.id,
        organizationId,
        ledgerId: created.ledgerId,
        reference: 'order-1',
        postedAt: created.postedAt,
        createdAt: created.createdAt,
      });
      expect(found.postings).toEqual(created.postings);
    });

    it('throws LedgerNotFoundError for a ledger that does not exist', async () => {
      const { organizationId } = await setup();
      const created = await move(organizationId, [posting('world', 'users:1', 1n)]);

      await expect(get(organizationId, created.id, 'missing')).rejects.toBeInstanceOf(
        LedgerNotFoundError,
      );
    });

    it('throws TransactionNotFoundError for an id that does not exist', async () => {
      const { organizationId } = await setup();

      await expect(get(organizationId, newOrganizationId())).rejects.toBeInstanceOf(
        TransactionNotFoundError,
      );
    });

    it('does not find a transaction of another ledger of the same organization', async () => {
      const { organizationId } = await setup();
      await createLedger.execute({ organizationId, name: 'other', metadata: {} });
      const created = await move(organizationId, [posting('world', 'users:1', 1n)]);

      await expect(get(organizationId, created.id, 'other')).rejects.toBeInstanceOf(
        TransactionNotFoundError,
      );
    });

    it('does not find a transaction of another organization', async () => {
      const { organizationId } = await setup();
      const created = await move(organizationId, [posting('world', 'users:1', 1n)]);
      const other = await setup();

      await expect(get(other.organizationId, created.id)).rejects.toBeInstanceOf(
        TransactionNotFoundError,
      );
    });
  });

  describe('list', () => {
    const list = (
      organizationId: string,
      options: Partial<Parameters<ListTransactionsUseCase['execute']>[0]> = {},
    ) => listTransactions.execute({ organizationId, ledgerName: 'main', pageSize: 10, ...options });

    it('lists the transactions that were created, newest first, with their postings', async () => {
      const { organizationId } = await setup();
      const one = await move(organizationId, [posting('world', 'users:1', 100n)], 'order-1');
      const two = await move(organizationId, [
        posting('world', 'users:2', 5n),
        posting('users:2', 'platform:fees', 1n),
      ]);

      const page = await list(organizationId);

      expect(page.hasMore).toBe(false);
      expect(page.transactions.map((t) => t.id)).toEqual([two.id, one.id]);
      expect(page.transactions[0]).toMatchObject({ reference: null, createdAt: two.createdAt });
      expect(page.transactions[0]?.postings).toEqual(two.postings);
      expect(page.transactions[1]?.postings).toEqual(one.postings);
    });

    it('reads every transaction once when the pages are followed', async () => {
      const { organizationId } = await setup();
      const created: string[] = [];
      for (let i = 1; i <= 5; i += 1) {
        created.push((await move(organizationId, [posting('world', 'users:1', BigInt(i))])).id);
      }

      const read: string[] = [];
      let after: Parameters<ListTransactionsUseCase['execute']>[0]['after'];
      for (;;) {
        const page = await list(organizationId, { pageSize: 2, after });
        read.push(...page.transactions.map((t) => t.id));
        if (!page.hasMore) break;
        const last = page.transactions.at(-1)!;
        after = { postedAt: last.postedAt, id: last.id };
      }

      // Newest first, so the opposite of the creation order.
      expect(read).toEqual(created.toReversed());
    });

    it('gives an empty page for a ledger with no transactions', async () => {
      const { organizationId } = await setup();

      await expect(list(organizationId)).resolves.toEqual({ transactions: [], hasMore: false });
    });

    it('throws LedgerNotFoundError for a ledger that does not exist', async () => {
      const { organizationId } = await setup();

      await expect(list(organizationId, { ledgerName: 'missing' })).rejects.toBeInstanceOf(
        LedgerNotFoundError,
      );
    });

    it('does not list the transactions of another ledger of the same organization', async () => {
      const { organizationId } = await setup();
      await createLedger.execute({ organizationId, name: 'other', metadata: {} });
      await move(organizationId, [posting('world', 'users:1', 1n)]);

      const page = await list(organizationId, { ledgerName: 'other' });

      expect(page.transactions).toEqual([]);
    });

    it('does not list the transactions of another organization', async () => {
      const { organizationId } = await setup();
      await move(organizationId, [posting('world', 'users:1', 1n)]);
      const other = await setup();

      const page = await list(other.organizationId);

      expect(page.transactions).toEqual([]);
    });
  });

  describe('at the same time', () => {
    it('moves money between the same accounts in both directions without a deadlock', async () => {
      const { organizationId } = await setup();
      await move(organizationId, [posting('world', 'a', 1000n), posting('world', 'b', 1000n)]);

      // 20 transactions that touch the same two accounts. Half go one way, half the other way.
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          move(organizationId, [
            i % 2 === 0 ? posting('a', 'b', 10n) : posting('b', 'a', 10n),
            i % 2 === 0 ? posting('b', 'a', 1n) : posting('a', 'b', 1n),
          ]),
        ),
      );
      const state = await readState(organizationId);

      // 10 times (a -> b 10, b -> a 1) and 10 times (b -> a 10, a -> b 1): net zero.
      expect(balancesOf(state)).toMatchObject({
        'a USD': '1000',
        'b USD': '1000',
        'world USD': '-2000',
      });
      expect(state.transactions).toHaveLength(21);
      // The journal has no gap and no repeat, whatever the order of the commits.
      expect(state.logs.map((log) => log.seq)).toEqual(
        Array.from({ length: 22 }, (_, i) => String(i + 1)),
      );
    });

    it('never lets an account go below zero when many transactions spend the same money', async () => {
      const { organizationId } = await setup();
      await move(organizationId, [posting('world', 'a', 100n)]);

      // 30 transactions of 10 want to spend 100. Exactly 10 can.
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, () => move(organizationId, [posting('a', 'b', 10n)])),
      );
      const state = await readState(organizationId);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(InsufficientFundsError);
        }
      }
      expect(balancesOf(state)).toMatchObject({ 'a USD': '0', 'b USD': '100' });
    });

    it('creates the same new accounts from many transactions, listed in different orders', async () => {
      const { organizationId } = await setup();

      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          move(
            organizationId,
            i % 2 === 0
              ? [posting('world', 'x', 1n), posting('world', 'y', 1n), posting('world', 'z', 1n)]
              : [posting('world', 'z', 1n), posting('world', 'y', 1n), posting('world', 'x', 1n)],
          ),
        ),
      );

      expect(balancesOf(await readState(organizationId))).toMatchObject({
        'x USD': '12',
        'y USD': '12',
        'z USD': '12',
        'world USD': '-36',
      });
    });

    it('uses the same reference only once when sent many times at once', async () => {
      const { organizationId } = await setup();

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          move(organizationId, [posting('world', 'a', 5n)], 'same-reference'),
        ),
      );
      const state = await readState(organizationId);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(TransactionReferenceAlreadyExistsError);
        }
      }
      expect(balancesOf(state)['a USD']).toBe('5');
    });
  });
});
