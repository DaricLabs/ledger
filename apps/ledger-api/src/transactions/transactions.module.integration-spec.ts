import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import type { INestApplication } from '@nestjs/common';
import { MetadataLimitExceededError } from '@ledger/domain';
import { unwrapTenantTransaction, withTenant, type LedgerDatabase } from '@ledger/database/storage';
import { KYSELY_DB } from '../core/database/database.constant.js';
import { Uuidv7IdGenerator } from '../ids/infrastructure/adapters/uuidv7-id-generator.adapter.js';
import { CreateLedgerUseCase } from '../ledgers/application/use-cases/create-ledger.use-case.js';
import { IdempotencyKeyReusedError } from '../idempotency/domain/errors/idempotency-key-reused.error.js';
import { LedgerNotFoundError } from '../ledgers/domain/errors/ledger-not-found.error.js';
import {
  CreateTransactionUseCase,
  type ICreateTransactionInput,
} from './application/use-cases/create-transaction.use-case.js';
import { DeleteTransactionMetadataUseCase } from './application/use-cases/delete-transaction-metadata.use-case.js';
import { GetTransactionUseCase } from './application/use-cases/get-transaction.use-case.js';
import { ListTransactionsUseCase } from './application/use-cases/list-transactions.use-case.js';
import { RevertTransactionUseCase } from './application/use-cases/revert-transaction.use-case.js';
import { SaveTransactionMetadataUseCase } from './application/use-cases/save-transaction-metadata.use-case.js';
import { InsufficientFundsError } from '../accounts/domain/errors/insufficient-funds.error.js';
import { TransactionAlreadyRevertedError } from './domain/errors/transaction-already-reverted.error.js';
import { TransactionNotFoundError } from './domain/errors/transaction-not-found.error.js';
import { TransactionReferenceAlreadyExistsError } from './domain/errors/transaction-reference-already-exists.error.js';
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
  let revertTransaction: RevertTransactionUseCase;
  let saveMetadata: SaveTransactionMetadataUseCase;
  let deleteMetadata: DeleteTransactionMetadataUseCase;

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
    revertTransaction = app.get(RevertTransactionUseCase);
    saveMetadata = app.get(SaveTransactionMetadataUseCase);
    deleteMetadata = app.get(DeleteTransactionMetadataUseCase);
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

  const move = async (
    organizationId: string,
    postings: ICreateTransactionInput['postings'],
    reference?: string,
  ) => {
    const { transaction } = await createTransaction.execute({
      organizationId,
      ledgerName: 'main',
      postings,
      reference,
    });
    return transaction;
  };

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

  describe('idempotency key', () => {
    const keyed = (
      organizationId: string,
      idempotencyKey: string,
      postings: ICreateTransactionInput['postings'],
      reference?: string,
    ) =>
      createTransaction.execute({
        organizationId,
        ledgerName: 'main',
        postings,
        reference,
        idempotencyKey,
      });

    it('creates the transaction once and replays it for the same request', async () => {
      const { organizationId } = await setup();
      const postings = [posting('world', 'users:1', 1000n)];

      const first = await keyed(organizationId, 'key-1', postings, 'order-1');
      const second = await keyed(organizationId, 'key-1', postings, 'order-1');
      const state = await readState(organizationId);

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.transaction).toEqual(first.transaction);
      expect(state.transactions).toHaveLength(1);
      expect(state.postings).toHaveLength(1);
      expect(state.logs).toHaveLength(2); // ledger created + one transaction
      expect(state.events).toHaveLength(2);
      expect(balancesOf(state)).toEqual({ 'users:1 USD': '1000', 'world USD': '-1000' });
    });

    it('stores one key that points to the transaction', async () => {
      const { organizationId, ledgerId } = await setup();

      const { transaction } = await keyed(organizationId, 'key-1', [posting('world', 'a', 1n)]);
      const keys = await withTenant(db, organizationId, (trx) =>
        unwrapTenantTransaction(trx).selectFrom('idempotency_keys').selectAll().execute(),
      );

      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({
        ledger_id: ledgerId,
        operation: 'transactions.create',
        key: 'key-1',
        transaction_id: transaction.id,
      });
      expect(keys[0]!.request_hash).toHaveLength(32);
    });

    it('replays a request even when the postings would fail now', async () => {
      const { organizationId } = await setup();
      await move(organizationId, [posting('world', 'users:1', 10n)]);
      // This empties users:1. Without a replay, the same request would now fail
      // with InsufficientFundsError (users:1 may not go below zero).
      const first = await keyed(organizationId, 'key-1', [posting('users:1', 'users:2', 10n)]);

      const again = await keyed(organizationId, 'key-1', [posting('users:1', 'users:2', 10n)]);

      expect(again.replayed).toBe(true);
      expect(again.transaction.id).toBe(first.transaction.id);
    });

    it('refuses the same key for another request, and changes nothing', async () => {
      const { organizationId } = await setup();
      await keyed(organizationId, 'key-1', [posting('world', 'a', 5n)]);

      await expect(
        keyed(organizationId, 'key-1', [posting('world', 'a', 6n)]),
      ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
      await expect(
        keyed(organizationId, 'key-1', [posting('world', 'a', 5n)], 'other-reference'),
      ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

      const state = await readState(organizationId);
      expect(state.transactions).toHaveLength(1);
      expect(balancesOf(state)['a USD']).toBe('5');
    });

    it('keeps different keys, and requests without a key, apart', async () => {
      const { organizationId } = await setup();

      await keyed(organizationId, 'key-1', [posting('world', 'a', 5n)]);
      await keyed(organizationId, 'key-2', [posting('world', 'a', 5n)]);
      await move(organizationId, [posting('world', 'a', 5n)]);

      expect(balancesOf(await readState(organizationId))['a USD']).toBe('15');
    });

    it('leaves no key when the request fails, so the same key can be used again', async () => {
      const { organizationId } = await setup();
      await expect(
        keyed(organizationId, 'key-1', [posting('users:1', 'users:2', 1n)]),
      ).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(
        await withTenant(db, organizationId, (trx) =>
          unwrapTenantTransaction(trx).selectFrom('idempotency_keys').selectAll().execute(),
        ),
      ).toHaveLength(0);

      await move(organizationId, [posting('world', 'users:1', 5n)]);
      const retry = await keyed(organizationId, 'key-1', [posting('users:1', 'users:2', 1n)]);

      expect(retry.replayed).toBe(false);
      expect(balancesOf(await readState(organizationId))['users:2 USD']).toBe('1');
    });

    it('leaves no key when the reference is already used', async () => {
      const { organizationId } = await setup();
      await move(organizationId, [posting('world', 'a', 1n)], 'order-1');

      await expect(
        keyed(organizationId, 'key-1', [posting('world', 'a', 1n)], 'order-1'),
      ).rejects.toBeInstanceOf(TransactionReferenceAlreadyExistsError);

      expect(
        await withTenant(db, organizationId, (trx) =>
          unwrapTenantTransaction(trx).selectFrom('idempotency_keys').selectAll().execute(),
        ),
      ).toHaveLength(0);
    });

    it('does not share a key between ledgers', async () => {
      const { organizationId } = await setup();
      await createLedger.execute({ organizationId, name: 'second', metadata: {} });

      const a = await keyed(organizationId, 'key-1', [posting('world', 'a', 5n)]);
      const b = await createTransaction.execute({
        organizationId,
        ledgerName: 'second',
        postings: [posting('world', 'a', 5n)],
        idempotencyKey: 'key-1',
      });

      expect(b.replayed).toBe(false);
      expect(b.transaction.id).not.toBe(a.transaction.id);
    });

    it('does not share a key between organizations', async () => {
      const one = await setup();
      const two = await setup();

      await keyed(one.organizationId, 'key-1', [posting('world', 'a', 5n)]);
      const other = await keyed(two.organizationId, 'key-1', [posting('world', 'a', 5n)]);

      expect(other.replayed).toBe(false);
    });

    it('creates one transaction when the same request is sent many times at once', async () => {
      const { organizationId } = await setup();

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          keyed(organizationId, 'key-1', [posting('world', 'a', 5n)], 'order-1'),
        ),
      );
      const state = await readState(organizationId);

      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
      expect(state.transactions).toHaveLength(1);
      expect(balancesOf(state)['a USD']).toBe('5');
    });

    it('runs again when the key has expired', async () => {
      const { organizationId } = await setup();
      const first = await keyed(organizationId, 'key-1', [posting('world', 'a', 5n)]);
      await withTenant(db, organizationId, (trx) =>
        unwrapTenantTransaction(trx)
          .updateTable('idempotency_keys')
          .set({
            created_at: new Date(Date.now() - 48 * 3_600_000),
            expires_at: new Date(Date.now() - 24 * 3_600_000),
          })
          .execute(),
      );

      const second = await keyed(organizationId, 'key-1', [posting('world', 'a', 5n)]);

      expect(second.replayed).toBe(false);
      expect(second.transaction.id).not.toBe(first.transaction.id);
      expect(balancesOf(await readState(organizationId))['a USD']).toBe('10');
    });
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

  describe('metadata', () => {
    const create = (
      organizationId: string,
      metadata?: Record<string, string>,
      idempotencyKey?: string,
    ) =>
      createTransaction.execute({
        organizationId,
        ledgerName: 'main',
        postings: [posting('world', 'users:1', 1000n)],
        metadata,
        idempotencyKey,
      });

    const save = (
      organizationId: string,
      transactionId: string,
      metadata: Record<string, string>,
    ) => saveMetadata.execute({ organizationId, ledgerName: 'main', transactionId, metadata });

    const remove = (organizationId: string, transactionId: string, key: string) =>
      deleteMetadata.execute({ organizationId, ledgerName: 'main', transactionId, key });

    const read = (organizationId: string, transactionId: string) =>
      getTransaction.execute({ organizationId, ledgerName: 'main', transactionId });

    it('saves the metadata of a new transaction, and puts it in the journal entry and the event', async () => {
      const { organizationId } = await setup();

      const { transaction } = await create(organizationId, { orderId: '42', channel: 'web' });
      const state = await readState(organizationId);

      expect(state.transactions[0]!.metadata).toEqual({ orderId: '42', channel: 'web' });
      expect(state.logs[1]!.payload).toMatchObject({ metadata: { orderId: '42', channel: 'web' } });
      expect(state.events[1]!.payload).toMatchObject({
        metadata: { orderId: '42', channel: 'web' },
      });
      expect((await read(organizationId, transaction.id)).metadata.entries).toEqual({
        orderId: '42',
        channel: 'web',
      });
    });

    it('shows the metadata in the list', async () => {
      const { organizationId } = await setup();
      await create(organizationId, { orderId: '42' });

      const page = await listTransactions.execute({
        organizationId,
        ledgerName: 'main',
        pageSize: 10,
      });

      expect(page.transactions.map((t) => t.metadata.entries)).toEqual([{ orderId: '42' }]);
    });

    it('adds keys and replaces a key that is there, and keeps the others', async () => {
      const { organizationId } = await setup();
      const { transaction } = await create(organizationId, { a: '1', b: '2' });

      await save(organizationId, transaction.id, { b: '3', c: '4' });

      expect((await read(organizationId, transaction.id)).metadata.entries).toEqual({
        a: '1',
        b: '3',
        c: '4',
      });
    });

    it('writes a journal entry and an outbox event about the transaction, with only the keys that changed', async () => {
      const { organizationId, ledgerId } = await setup();
      const { transaction } = await create(organizationId, { a: '1' });

      await save(organizationId, transaction.id, { a: '1', b: '2' });
      const state = await readState(organizationId);

      // ledger created, transaction created, metadata saved
      expect(state.logs).toHaveLength(3);
      expect(state.logs[2]).toMatchObject({
        seq: '3',
        type: 'TRANSACTION_METADATA_SAVED',
        transaction_id: transaction.id,
        payload: { transactionId: transaction.id, metadata: { b: '2' } },
      });
      expect(state.events).toHaveLength(3);
      expect(state.events[2]).toMatchObject({
        ledger_id: ledgerId,
        aggregate_type: 'transaction',
        aggregate_id: transaction.id,
        event_type: 'ledger.transaction.metadata.saved',
        published_at: null,
        payload: {
          transactionId: transaction.id,
          ledgerId,
          organizationId,
          metadata: { b: '2' },
        },
      });
    });

    it('removes a key, and writes a journal entry and an outbox event', async () => {
      const { organizationId } = await setup();
      const { transaction } = await create(organizationId, { a: '1', b: '2' });

      await remove(organizationId, transaction.id, 'a');
      const state = await readState(organizationId);

      expect((await read(organizationId, transaction.id)).metadata.entries).toEqual({ b: '2' });
      expect(state.logs[2]).toMatchObject({
        type: 'TRANSACTION_METADATA_DELETED',
        transaction_id: transaction.id,
        payload: { transactionId: transaction.id, key: 'a' },
      });
      expect(state.events[2]).toMatchObject({
        aggregate_id: transaction.id,
        event_type: 'ledger.transaction.metadata.deleted',
        payload: { transactionId: transaction.id, key: 'a' },
      });
    });

    it('saves, logs and publishes nothing when nothing changes', async () => {
      const { organizationId } = await setup();
      const { transaction } = await create(organizationId, { a: '1' });

      await save(organizationId, transaction.id, { a: '1' });
      await remove(organizationId, transaction.id, 'missing');
      const state = await readState(organizationId);

      expect(state.logs).toHaveLength(2);
      expect(state.events).toHaveLength(2);
      expect((await read(organizationId, transaction.id)).metadata.entries).toEqual({ a: '1' });
    });

    it('never changes the postings, the balances or the number of transactions', async () => {
      const { organizationId } = await setup();
      const { transaction } = await create(organizationId);
      const before = await readState(organizationId);

      await save(organizationId, transaction.id, { note: 'late' });
      const after = await readState(organizationId);

      expect(after.postings).toEqual(before.postings);
      expect(after.balances).toEqual(before.balances);
      expect(after.transactions).toHaveLength(1);
      expect(after.transactions[0]).toMatchObject({
        id: transaction.id,
        posted_at: transaction.postedAt,
        reverted_at: null,
        metadata: { note: 'late' },
      });
    });

    it('works on a reverted transaction, and keeps the revert mark', async () => {
      const { organizationId } = await setup();
      const { transaction } = await create(organizationId, { a: '1' });
      const { transaction: reversal } = await revertTransaction.execute({
        organizationId,
        ledgerName: 'main',
        transactionId: transaction.id,
      });

      await save(organizationId, transaction.id, { reason: 'customer asked' });
      const read1 = await read(organizationId, transaction.id);

      expect(read1.metadata.entries).toEqual({ a: '1', reason: 'customer asked' });
      expect(read1.revertedByTransactionId).toBe(reversal.id);
      expect(reversal.metadata.size).toBe(0); // a revert does not copy the metadata
    });

    it('can edit the metadata of a reversing transaction too', async () => {
      const { organizationId } = await setup();
      const { transaction } = await create(organizationId, { a: '1' });
      const { transaction: reversal } = await revertTransaction.execute({
        organizationId,
        ledgerName: 'main',
        transactionId: transaction.id,
      });

      await save(organizationId, reversal.id, { reason: 'duplicate' });

      expect((await read(organizationId, reversal.id)).metadata.entries).toEqual({
        reason: 'duplicate',
      });
    });

    describe('idempotency', () => {
      it('answers a replay with the metadata of the first call, even after an edit', async () => {
        const { organizationId } = await setup();
        const first = await create(organizationId, { orderId: '42' }, 'key-1');
        await save(organizationId, first.transaction.id, { note: 'added later' });
        await remove(organizationId, first.transaction.id, 'orderId');

        const replay = await create(organizationId, { orderId: '42' }, 'key-1');

        expect(replay.replayed).toBe(true);
        expect(replay.transaction.metadata.entries).toEqual({ orderId: '42' });
        // Reading it normally shows the edits.
        expect((await read(organizationId, first.transaction.id)).metadata.entries).toEqual({
          note: 'added later',
        });
      });

      it('treats the same metadata in another key order as the same request', async () => {
        const { organizationId } = await setup();
        const first = await create(organizationId, { a: '1', b: '2' }, 'key-1');

        const replay = await create(organizationId, { b: '2', a: '1' }, 'key-1');

        expect(replay.replayed).toBe(true);
        expect(replay.transaction.id).toBe(first.transaction.id);
      });

      it('refuses the same key with other metadata, and changes nothing', async () => {
        const { organizationId } = await setup();
        await create(organizationId, { orderId: '42' }, 'key-1');
        const before = await readState(organizationId);

        await expect(create(organizationId, { orderId: '43' }, 'key-1')).rejects.toBeInstanceOf(
          IdempotencyKeyReusedError,
        );
        await expect(create(organizationId, undefined, 'key-1')).rejects.toBeInstanceOf(
          IdempotencyKeyReusedError,
        );

        expect(await readState(organizationId)).toEqual(before);
      });

      it('treats no metadata and empty metadata as the same request', async () => {
        const { organizationId } = await setup();
        const first = await create(organizationId, undefined, 'key-1');

        const replay = await create(organizationId, {}, 'key-1');

        expect(replay.replayed).toBe(true);
        expect(replay.transaction.id).toBe(first.transaction.id);
      });

      it('answers a revert replay with a transaction that has no metadata, even after an edit', async () => {
        const { organizationId } = await setup();
        const { transaction } = await create(organizationId);
        const first = await revertTransaction.execute({
          organizationId,
          ledgerName: 'main',
          transactionId: transaction.id,
          idempotencyKey: 'revert-key',
        });
        await save(organizationId, first.transaction.id, { reason: 'added later' });

        const replay = await revertTransaction.execute({
          organizationId,
          ledgerName: 'main',
          transactionId: transaction.id,
          idempotencyKey: 'revert-key',
        });

        expect(replay.replayed).toBe(true);
        expect(replay.transaction.id).toBe(first.transaction.id);
        expect(replay.transaction.metadata.size).toBe(0);
      });
    });

    describe('limits', () => {
      it('refuses a transaction with too much metadata, and saves nothing', async () => {
        const { organizationId } = await setup();
        const tooMany = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, 'v']));
        const before = await readState(organizationId);

        await expect(create(organizationId, tooMany)).rejects.toBeInstanceOf(
          MetadataLimitExceededError,
        );

        expect(await readState(organizationId)).toEqual(before);
      });

      it('checks the stored metadata, so many small saves cannot pass the limit', async () => {
        const { organizationId } = await setup();
        const full = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, 'v']));
        const { transaction } = await create(organizationId, full);
        const before = await readState(organizationId);

        await expect(save(organizationId, transaction.id, { oneMore: 'x' })).rejects.toBeInstanceOf(
          MetadataLimitExceededError,
        );

        expect(await readState(organizationId)).toEqual(before);
      });

      it('lets a transaction with a full metadata get smaller, and then bigger again', async () => {
        const { organizationId } = await setup();
        const full = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, 'v']));
        const { transaction } = await create(organizationId, full);

        await remove(organizationId, transaction.id, 'k0');
        await save(organizationId, transaction.id, { oneMore: 'x' });

        expect((await read(organizationId, transaction.id)).metadata.size).toBe(128);
      });
    });

    describe('not found', () => {
      it('throws LedgerNotFoundError for a ledger that does not exist', async () => {
        const { organizationId } = await setup();
        const { transaction } = await create(organizationId);

        await expect(
          saveMetadata.execute({
            organizationId,
            ledgerName: 'nope',
            transactionId: transaction.id,
            metadata: { a: '1' },
          }),
        ).rejects.toBeInstanceOf(LedgerNotFoundError);
        await expect(
          deleteMetadata.execute({
            organizationId,
            ledgerName: 'nope',
            transactionId: transaction.id,
            key: 'a',
          }),
        ).rejects.toBeInstanceOf(LedgerNotFoundError);
      });

      it('throws TransactionNotFoundError for an id that does not exist', async () => {
        const { organizationId } = await setup();
        const missing = newOrganizationId();

        await expect(save(organizationId, missing, { a: '1' })).rejects.toBeInstanceOf(
          TransactionNotFoundError,
        );
        await expect(remove(organizationId, missing, 'a')).rejects.toBeInstanceOf(
          TransactionNotFoundError,
        );
      });

      it('does not edit a transaction of another ledger of the same organization', async () => {
        const { organizationId } = await setup();
        await createLedger.execute({ organizationId, name: 'other', metadata: {} });
        const { transaction } = await create(organizationId, { a: '1' });

        await expect(
          saveMetadata.execute({
            organizationId,
            ledgerName: 'other',
            transactionId: transaction.id,
            metadata: { a: 'changed' },
          }),
        ).rejects.toBeInstanceOf(TransactionNotFoundError);

        expect((await read(organizationId, transaction.id)).metadata.entries).toEqual({ a: '1' });
      });

      it('does not edit a transaction of another organization', async () => {
        const { organizationId } = await setup();
        const { organizationId: stranger } = await setup();
        const { transaction } = await create(organizationId, { a: '1' });

        await expect(save(stranger, transaction.id, { a: 'changed' })).rejects.toBeInstanceOf(
          TransactionNotFoundError,
        );
        await expect(remove(stranger, transaction.id, 'a')).rejects.toBeInstanceOf(
          TransactionNotFoundError,
        );

        expect((await read(organizationId, transaction.id)).metadata.entries).toEqual({ a: '1' });
      });
    });

    describe('at the same time', () => {
      it('keeps every key when many edits of different keys run together', async () => {
        const { organizationId } = await setup();
        const { transaction } = await create(organizationId);
        const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);

        await Promise.all(keys.map((key) => save(organizationId, transaction.id, { [key]: 'v' })));
        const state = await readState(organizationId);

        expect(
          Object.keys((await read(organizationId, transaction.id)).metadata.entries).sort(),
        ).toEqual([...keys].sort());
        // ledger created, transaction created, and one entry per edit, with no gap in seq
        expect(state.logs.map((log) => log.seq)).toEqual(
          Array.from({ length: 22 }, (_, i) => String(i + 1)),
        );
      });

      it('does not deadlock with a revert of the same transaction', async () => {
        const { organizationId } = await setup();
        const { transaction } = await create(organizationId, { a: '1' });

        await Promise.all([
          ...Array.from({ length: 5 }, (_, i) =>
            save(organizationId, transaction.id, { [`k${i}`]: 'v' }),
          ),
          revertTransaction.execute({
            organizationId,
            ledgerName: 'main',
            transactionId: transaction.id,
          }),
        ]);

        const final = await read(organizationId, transaction.id);
        expect(final.isReverted).toBe(true);
        expect(final.metadata.size).toBe(6);
      });
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

  describe('revert', () => {
    const revert = (organizationId: string, transactionId: string, idempotencyKey?: string) =>
      revertTransaction.execute({
        organizationId,
        ledgerName: 'main',
        transactionId,
        idempotencyKey,
      });

    /** The original transaction of most tests: 1000 comes in, and 25 of it goes to the fees. */
    const original = (organizationId: string) =>
      move(
        organizationId,
        [posting('world', 'users:1', 1000n), posting('users:1', 'platform:fees', 25n)],
        'order-1',
      );

    it('moves the money back with a new transaction and marks the old one', async () => {
      const { organizationId, ledgerId } = await setup();
      const first = await original(organizationId);

      const { transaction, replayed } = await revert(organizationId, first.id);
      const state = await readState(organizationId);

      expect(replayed).toBe(false);
      expect(balancesOf(state)).toEqual({
        'platform:fees USD': '0',
        'users:1 USD': '0',
        'world USD': '0',
      });
      expect(state.transactions).toHaveLength(2);
      const stored = Object.fromEntries(state.transactions.map((t) => [t.id, t]));
      expect(stored[first.id]).toMatchObject({
        reference: 'order-1',
        reverted_at: transaction.createdAt,
        reverted_by_transaction_id: transaction.id,
      });
      expect(stored[transaction.id]).toMatchObject({
        ledger_id: ledgerId,
        reference: null,
        posted_at: transaction.postedAt,
        reverted_at: null,
        reverted_by_transaction_id: null,
      });
      expect(
        state.postings
          .filter((p) => p.transaction_id === transaction.id)
          .map((p) => [p.seq, p.source_account, p.destination_account, p.amount]),
      ).toEqual([
        [1, 'platform:fees', 'users:1', '25'],
        [2, 'users:1', 'world', '1000'],
      ]);
    });

    it('does not change the postings or the first transaction', async () => {
      const { organizationId } = await setup();
      const first = await original(organizationId);
      const before = await readState(organizationId);

      await revert(organizationId, first.id);
      const after = await readState(organizationId);

      expect(after.postings.filter((p) => p.transaction_id === first.id)).toEqual(before.postings);
      const firstRow = after.transactions.find((t) => t.id === first.id);
      expect(firstRow).toMatchObject({
        posted_at: first.postedAt,
        created_at: first.createdAt,
        reference: 'order-1',
      });
    });

    it('writes one journal entry and one outbox event, about the new transaction', async () => {
      const { organizationId, ledgerId } = await setup();
      const first = await original(organizationId);

      const { transaction } = await revert(organizationId, first.id);
      const state = await readState(organizationId);

      // ledger created, transaction created, transaction reverted
      expect(state.logs.map((log) => [log.seq, log.type])).toEqual([
        ['1', 'LEDGER_CREATED'],
        ['2', 'TRANSACTION_CREATED'],
        ['3', 'TRANSACTION_REVERTED'],
      ]);
      expect(state.logs[2]).toMatchObject({
        ledger_id: ledgerId,
        transaction_id: transaction.id,
        payload: {
          revertedTransactionId: first.id,
          postedAt: transaction.postedAt.toISOString(),
          postings: [
            { source: 'platform:fees', destination: 'users:1', asset: 'USD', amount: '25' },
            { source: 'users:1', destination: 'world', asset: 'USD', amount: '1000' },
          ],
        },
      });
      expect(state.events).toHaveLength(3);
      expect(state.events[2]).toMatchObject({
        aggregate_type: 'transaction',
        aggregate_id: transaction.id,
        event_type: 'ledger.transaction.reverted',
        payload: { transactionId: transaction.id, revertedTransactionId: first.id },
      });
    });

    it('shows the revert state when the transaction is read again', async () => {
      const { organizationId } = await setup();
      const first = await original(organizationId);

      const { transaction } = await revert(organizationId, first.id);
      const read = await getTransaction.execute({
        organizationId,
        ledgerName: 'main',
        transactionId: first.id,
      });
      const page = await listTransactions.execute({
        organizationId,
        ledgerName: 'main',
        pageSize: 10,
      });

      expect(read.isReverted).toBe(true);
      expect(read.revertedAt).toEqual(transaction.createdAt);
      expect(read.revertedByTransactionId).toBe(transaction.id);
      expect(page.transactions.map((t) => [t.id, t.isReverted])).toEqual([
        [transaction.id, false],
        [first.id, true],
      ]);
    });

    it('refuses a second revert of the same transaction, and changes nothing', async () => {
      const { organizationId } = await setup();
      const first = await original(organizationId);
      await revert(organizationId, first.id);
      const before = await readState(organizationId);

      await expect(revert(organizationId, first.id)).rejects.toBeInstanceOf(
        TransactionAlreadyRevertedError,
      );

      const after = await readState(organizationId);
      expect(after.transactions).toEqual(before.transactions);
      expect(after.logs).toHaveLength(before.logs.length);
      expect(after.events).toHaveLength(before.events.length);
      expect(balancesOf(after)).toEqual(balancesOf(before));
    });

    it('can revert the revert: the money goes where it first went', async () => {
      const { organizationId } = await setup();
      const first = await original(organizationId);
      const { transaction: reversal } = await revert(organizationId, first.id);

      await revert(organizationId, reversal.id);

      expect(balancesOf(await readState(organizationId))).toEqual({
        'platform:fees USD': '25',
        'users:1 USD': '975',
        'world USD': '-1000',
      });
    });

    it('reverts only the money of that transaction, when others touched the same accounts', async () => {
      const { organizationId } = await setup();
      await move(organizationId, [posting('world', 'a', 500n)]);
      const second = await move(organizationId, [posting('world', 'a', 100n)]);
      await move(organizationId, [posting('a', 'b', 50n)]);

      await revert(organizationId, second.id);

      expect(balancesOf(await readState(organizationId))).toEqual({
        'a USD': '450',
        'b USD': '50',
        'world USD': '-500',
      });
    });

    it('keeps assets apart', async () => {
      const { organizationId } = await setup();
      const first = await move(organizationId, [
        posting('world', 'a', 100n),
        posting('world', 'a', 7n, 'EUR'),
      ]);

      await revert(organizationId, first.id);

      expect(balancesOf(await readState(organizationId))).toEqual({
        'a EUR': '0',
        'a USD': '0',
        'world EUR': '0',
        'world USD': '0',
      });
    });

    it('fails with InsufficientFundsError when the money was spent, and changes nothing', async () => {
      const { organizationId } = await setup();
      const first = await original(organizationId);
      await move(organizationId, [posting('users:1', 'users:2', 900n)]); // users:1 has 75 left
      const before = await readState(organizationId);

      await expect(revert(organizationId, first.id)).rejects.toBeInstanceOf(InsufficientFundsError);

      const after = await readState(organizationId);
      expect(after.transactions).toEqual(before.transactions);
      expect(after.transactions.every((t) => t.reverted_at === null)).toBe(true);
      expect(after.logs).toHaveLength(before.logs.length);
      expect(after.events).toHaveLength(before.events.length);
      expect(balancesOf(after)).toEqual(balancesOf(before));
    });

    it('throws LedgerNotFoundError for a ledger that does not exist', async () => {
      const { organizationId } = await setup();
      const first = await original(organizationId);

      await expect(
        revertTransaction.execute({
          organizationId,
          ledgerName: 'nope',
          transactionId: first.id,
        }),
      ).rejects.toBeInstanceOf(LedgerNotFoundError);
    });

    it('throws TransactionNotFoundError for an id that does not exist', async () => {
      const { organizationId } = await setup();

      await expect(revert(organizationId, newOrganizationId())).rejects.toBeInstanceOf(
        TransactionNotFoundError,
      );
    });

    it('does not revert a transaction of another ledger of the same organization', async () => {
      const { organizationId } = await setup();
      await createLedger.execute({ organizationId, name: 'other', metadata: {} });
      const first = await original(organizationId);

      await expect(
        revertTransaction.execute({
          organizationId,
          ledgerName: 'other',
          transactionId: first.id,
        }),
      ).rejects.toBeInstanceOf(TransactionNotFoundError);
      expect(balancesOf(await readState(organizationId))['users:1 USD']).toBe('975');
    });

    it('does not revert a transaction of another organization', async () => {
      const { organizationId } = await setup();
      const first = await original(organizationId);
      const other = await setup();

      await expect(revert(other.organizationId, first.id)).rejects.toBeInstanceOf(
        TransactionNotFoundError,
      );
      expect(balancesOf(await readState(organizationId))['users:1 USD']).toBe('975');
    });

    describe('idempotency key', () => {
      it('reverts once and replays the first result for the same key', async () => {
        const { organizationId } = await setup();
        const first = await original(organizationId);

        const one = await revert(organizationId, first.id, 'key-1');
        const two = await revert(organizationId, first.id, 'key-1');
        const state = await readState(organizationId);

        expect(one.replayed).toBe(false);
        expect(two.replayed).toBe(true);
        expect(two.transaction.id).toBe(one.transaction.id);
        expect(state.transactions).toHaveLength(2);
        expect(state.logs).toHaveLength(3);
        expect(state.events).toHaveLength(3);
        expect(balancesOf(state)['users:1 USD']).toBe('0');
      });

      it('stores the key for the revert operation, pointing to the new transaction', async () => {
        const { organizationId, ledgerId } = await setup();
        const first = await original(organizationId);

        const { transaction } = await revert(organizationId, first.id, 'key-1');
        const keys = await withTenant(db, organizationId, (trx) =>
          unwrapTenantTransaction(trx).selectFrom('idempotency_keys').selectAll().execute(),
        );

        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatchObject({
          ledger_id: ledgerId,
          operation: 'transactions.revert',
          key: 'key-1',
          transaction_id: transaction.id,
        });
      });

      it('refuses the same key for another transaction, and changes nothing', async () => {
        const { organizationId } = await setup();
        const first = await original(organizationId);
        const second = await move(organizationId, [posting('world', 'c', 5n)]);
        await revert(organizationId, first.id, 'key-1');
        const before = await readState(organizationId);

        await expect(revert(organizationId, second.id, 'key-1')).rejects.toBeInstanceOf(
          IdempotencyKeyReusedError,
        );

        const after = await readState(organizationId);
        expect(after.transactions).toEqual(before.transactions);
        expect(balancesOf(after)).toEqual(balancesOf(before));
      });

      it('replays the first result even after the transaction was reverted', async () => {
        const { organizationId } = await setup();
        const first = await original(organizationId);
        const one = await revert(organizationId, first.id, 'key-1');

        // Without the key, the same request is refused. With it, it is a replay.
        await expect(revert(organizationId, first.id)).rejects.toBeInstanceOf(
          TransactionAlreadyRevertedError,
        );
        const two = await revert(organizationId, first.id, 'key-1');

        expect(two).toMatchObject({ replayed: true });
        expect(two.transaction.id).toBe(one.transaction.id);
      });

      it('answers a replay like the first call, even after the new transaction was reverted', async () => {
        const { organizationId } = await setup();
        const first = await original(organizationId);
        const one = await revert(organizationId, first.id, 'key-1');
        await revert(organizationId, one.transaction.id); // reverts the revert

        const two = await revert(organizationId, first.id, 'key-1');

        expect(two.replayed).toBe(true);
        expect(two.transaction.id).toBe(one.transaction.id);
        expect(two.transaction.isReverted).toBe(false);
        expect(two.transaction.revertedAt).toBeNull();
      });

      it('answers a create replay like the first call, even after the transaction was reverted', async () => {
        const { organizationId } = await setup();
        const created = await createTransaction.execute({
          organizationId,
          ledgerName: 'main',
          postings: [posting('world', 'a', 5n)],
          idempotencyKey: 'create-key',
        });
        await revert(organizationId, created.transaction.id);

        const replay = await createTransaction.execute({
          organizationId,
          ledgerName: 'main',
          postings: [posting('world', 'a', 5n)],
          idempotencyKey: 'create-key',
        });

        expect(replay.replayed).toBe(true);
        expect(replay.transaction.id).toBe(created.transaction.id);
        expect(replay.transaction.isReverted).toBe(false);
        // Reading it normally still shows the revert.
        const read = await getTransaction.execute({
          organizationId,
          ledgerName: 'main',
          transactionId: created.transaction.id,
        });
        expect(read.isReverted).toBe(true);
      });

      it('does not share a key with create: the key is scoped by operation', async () => {
        const { organizationId } = await setup();
        const { transaction: created } = await createTransaction.execute({
          organizationId,
          ledgerName: 'main',
          postings: [posting('world', 'a', 5n)],
          idempotencyKey: 'same-key',
        });

        const { transaction, replayed } = await revert(organizationId, created.id, 'same-key');

        expect(replayed).toBe(false);
        expect(transaction.id).not.toBe(created.id);
        expect(balancesOf(await readState(organizationId))['a USD']).toBe('0');
      });

      it('leaves no key when the revert fails, so the same key can be used again', async () => {
        const { organizationId } = await setup();
        const first = await original(organizationId);
        const spent = await move(organizationId, [posting('users:1', 'users:2', 900n)]);

        await expect(revert(organizationId, first.id, 'key-1')).rejects.toBeInstanceOf(
          InsufficientFundsError,
        );
        const keysAfterFailure = await withTenant(db, organizationId, (trx) =>
          unwrapTenantTransaction(trx).selectFrom('idempotency_keys').selectAll().execute(),
        );
        // The spent money comes back, so the revert can work now.
        await revert(organizationId, spent.id);
        const retry = await revert(organizationId, first.id, 'key-1');

        expect(keysAfterFailure).toHaveLength(0);
        expect(retry.replayed).toBe(false);
      });

      it('reverts once when the same request is sent many times at once', async () => {
        const { organizationId } = await setup();
        const first = await original(organizationId);

        const results = await Promise.all(
          Array.from({ length: 8 }, () => revert(organizationId, first.id, 'key-1')),
        );
        const state = await readState(organizationId);

        expect(results.filter((r) => !r.replayed)).toHaveLength(1);
        expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
        expect(state.transactions).toHaveLength(2);
        expect(balancesOf(state)['users:1 USD']).toBe('0');
      });
    });

    describe('at the same time', () => {
      it('reverts a transaction only once when it is sent many times at once', async () => {
        const { organizationId } = await setup();
        const first = await original(organizationId);

        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => revert(organizationId, first.id)),
        );
        const state = await readState(organizationId);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(TransactionAlreadyRevertedError);
          }
        }
        expect(state.transactions).toHaveLength(2);
        expect(balancesOf(state)).toEqual({
          'platform:fees USD': '0',
          'users:1 USD': '0',
          'world USD': '0',
        });
      });

      it('lets only one win when a revert and a spend want the same money', async () => {
        for (let round = 0; round < 5; round++) {
          const { organizationId } = await setup();
          const first = await move(organizationId, [posting('world', 'a', 100n)]);

          const [reverted, spent] = await Promise.allSettled([
            revert(organizationId, first.id),
            move(organizationId, [posting('a', 'b', 100n)]),
          ]);
          const balances = balancesOf(await readState(organizationId));

          // Either the revert took the money back, or the spend moved it first.
          expect([reverted.status, spent.status].sort()).toEqual(['fulfilled', 'rejected']);
          const failure = reverted.status === 'rejected' ? reverted : spent;
          expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
          expect(balances['a USD']).toBe('0');
        }
      });

      it('reverts many transactions of the same accounts, with creates, without a deadlock', async () => {
        const { organizationId } = await setup();
        await move(organizationId, [posting('world', 'a', 1000n), posting('world', 'b', 1000n)]);
        const transfers = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            move(organizationId, [
              i % 2 === 0 ? posting('a', 'b', 10n) : posting('b', 'a', 10n),
              i % 2 === 0 ? posting('b', 'a', 1n) : posting('a', 'b', 1n),
            ]),
          ),
        );

        // Reverts of the transfers, and new transfers, all at once.
        await Promise.all([
          ...transfers.map((transfer) => revert(organizationId, transfer.id)),
          ...Array.from({ length: 10 }, (_, i) =>
            move(organizationId, [i % 2 === 0 ? posting('b', 'a', 5n) : posting('a', 'b', 5n)]),
          ),
        ]);
        const state = await readState(organizationId);

        expect(balancesOf(state)).toMatchObject({ 'a USD': '1000', 'b USD': '1000' });
        expect(state.transactions.filter((t) => t.reverted_at !== null)).toHaveLength(10);
        // The journal has no gap and no repeat, whatever the order of the commits.
        expect(state.logs.map((log) => log.seq)).toEqual(
          Array.from({ length: state.logs.length }, (_, i) => String(i + 1)),
        );
      });
    });
  });
});
