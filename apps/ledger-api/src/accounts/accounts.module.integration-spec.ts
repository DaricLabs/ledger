import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import type { INestApplication } from '@nestjs/common';
import { MetadataLimitExceededError } from '@ledger/domain';
import { unwrapTenantTransaction, withTenant, type LedgerDatabase } from '@ledger/database/storage';
import { KYSELY_DB } from '../core/database/database.constant.js';
import { Uuidv7IdGenerator } from '../ids/infrastructure/adapters/uuidv7-id-generator.adapter.js';
import { CreateLedgerUseCase } from '../ledgers/application/use-cases/create-ledger.use-case.js';
import { LedgerNotFoundError } from '../ledgers/domain/errors/ledger-not-found.error.js';
import { CreateTransactionUseCase } from '../transactions/application/use-cases/create-transaction.use-case.js';
import { RevertTransactionUseCase } from '../transactions/application/use-cases/revert-transaction.use-case.js';
import { TransactionsModule } from '../transactions/transactions.module.js';
import { DeleteAccountMetadataUseCase } from './application/use-cases/delete-account-metadata.use-case.js';
import { GetAccountUseCase } from './application/use-cases/get-account.use-case.js';
import { ListAccountsUseCase } from './application/use-cases/list-accounts.use-case.js';
import { SaveAccountMetadataUseCase } from './application/use-cases/save-account-metadata.use-case.js';
import { AccountNotFoundError } from './domain/errors/account-not-found.error.js';

// Every test uses new organization ids, so tests never see each other's rows
// and nothing has to be cleaned up (the append-only tables cannot be cleaned anyway).
// Accounts are made the way they are made in real life: by a transaction. So the
// transactions module is imported here, only to make accounts for the tests.
const newOrganizationId = () => new Uuidv7IdGenerator().next();

describe('AccountsModule (real database)', () => {
  let app: INestApplication;
  let db: LedgerDatabase;
  let createLedger: CreateLedgerUseCase;
  let createTransaction: CreateTransactionUseCase;
  let revertTransaction: RevertTransactionUseCase;
  let getAccount: GetAccountUseCase;
  let listAccounts: ListAccountsUseCase;
  let saveMetadata: SaveAccountMetadataUseCase;
  let deleteMetadata: DeleteAccountMetadataUseCase;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ LEDGER_RUNTIME_DATABASE_URL: process.env.LEDGER_RUNTIME_DATABASE_URL })],
        }),
        // The controllers use TenantGuard, and the guard needs PinoLogger.
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        TransactionsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get<LedgerDatabase>(KYSELY_DB);
    createLedger = app.get(CreateLedgerUseCase);
    createTransaction = app.get(CreateTransactionUseCase);
    revertTransaction = app.get(RevertTransactionUseCase);
    getAccount = app.get(GetAccountUseCase);
    listAccounts = app.get(ListAccountsUseCase);
    saveMetadata = app.get(SaveAccountMetadataUseCase);
    deleteMetadata = app.get(DeleteAccountMetadataUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  /** A new organization with a ledger called `main`. */
  async function setup(ledgerName = 'main') {
    const organizationId = newOrganizationId();
    const ledger = await createLedger.execute({
      organizationId,
      name: ledgerName,
      metadata: {},
    });
    return { organizationId, ledgerId: ledger.id };
  }

  const move = (
    organizationId: string,
    source: string,
    destination: string,
    amount: bigint,
    ledgerName = 'main',
  ) =>
    createTransaction.execute({
      organizationId,
      ledgerName,
      postings: [{ source, destination, asset: 'USD', amount }],
    });

  const save = (
    organizationId: string,
    metadata: Record<string, string>,
    address = 'users:1',
    ledgerName = 'main',
  ) => saveMetadata.execute({ organizationId, ledgerName, address, metadata });

  const remove = (organizationId: string, key: string, address = 'users:1', ledgerName = 'main') =>
    deleteMetadata.execute({ organizationId, ledgerName, address, key });

  const read = (organizationId: string, address = 'users:1', ledgerName = 'main') =>
    getAccount.execute({ organizationId, ledgerName, address });

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
        logs: await k.selectFrom('ledger_logs').selectAll().orderBy('seq').execute(),
        events: await k.selectFrom('outbox_events').selectAll().orderBy('id').execute(),
      };
    });

  it('starts with empty metadata when a transaction makes the account', async () => {
    const { organizationId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);

    const account = await read(organizationId);

    expect(account.metadata.entries).toEqual({});
  });

  it('saves the metadata, and get and list show it', async () => {
    const { organizationId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);

    await save(organizationId, { customerId: 'c_42', tier: 'gold' });

    expect((await read(organizationId)).metadata.entries).toEqual({
      customerId: 'c_42',
      tier: 'gold',
    });
    const page = await listAccounts.execute({
      organizationId,
      ledgerName: 'main',
      pageSize: 10,
    });
    expect(page.accounts.map((a) => [a.address.value, a.metadata.entries])).toEqual([
      ['users:1', { customerId: 'c_42', tier: 'gold' }],
      ['world', {}],
    ]);
  });

  it('adds keys and replaces a key that is there, and keeps the others', async () => {
    const { organizationId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);
    await save(organizationId, { a: '1', b: '2' });

    await save(organizationId, { b: '3', c: '4' });

    expect((await read(organizationId)).metadata.entries).toEqual({ a: '1', b: '3', c: '4' });
  });

  it('can give metadata to world, the account that may go below zero', async () => {
    const { organizationId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);

    await save(organizationId, { role: 'source' }, 'world');

    const world = await read(organizationId, 'world');
    expect(world.metadata.entries).toEqual({ role: 'source' });
    expect(world.allowOverdraft).toBe(true);
  });

  it('writes a journal entry and an outbox event about the account, with only the keys that changed', async () => {
    const { organizationId, ledgerId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);
    await save(organizationId, { a: '1' });

    await save(organizationId, { a: '1', b: '2' });
    const state = await readState(organizationId);

    // ledger created, transaction created, metadata saved twice
    expect(state.logs).toHaveLength(4);
    expect(state.logs[3]).toMatchObject({
      seq: '4',
      type: 'ACCOUNT_METADATA_SAVED',
      transaction_id: null,
      payload: { address: 'users:1', metadata: { b: '2' } },
    });
    expect(state.events).toHaveLength(4);
    expect(state.events[3]).toMatchObject({
      ledger_id: ledgerId,
      aggregate_type: 'account',
      aggregate_id: 'users:1',
      event_type: 'ledger.account.metadata.saved',
      published_at: null,
      payload: {
        address: 'users:1',
        ledgerId,
        organizationId,
        metadata: { b: '2' },
      },
    });
  });

  it('removes a key, and writes a journal entry and an outbox event', async () => {
    const { organizationId, ledgerId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);
    await save(organizationId, { a: '1', b: '2' });

    await remove(organizationId, 'a');
    const state = await readState(organizationId);

    expect((await read(organizationId)).metadata.entries).toEqual({ b: '2' });
    expect(state.logs[3]).toMatchObject({
      type: 'ACCOUNT_METADATA_DELETED',
      transaction_id: null,
      payload: { address: 'users:1', key: 'a' },
    });
    expect(state.events[3]).toMatchObject({
      aggregate_type: 'account',
      aggregate_id: 'users:1',
      event_type: 'ledger.account.metadata.deleted',
      payload: { address: 'users:1', ledgerId, organizationId, key: 'a' },
    });
  });

  it('saves and deletes metadata of an account with the longest address (256 characters)', async () => {
    const { organizationId } = await setup();
    const longest = 'a'.repeat(256);
    await move(organizationId, 'world', longest, 100n);

    await save(organizationId, { a: '1' }, longest);
    await remove(organizationId, 'a', longest);
    const state = await readState(organizationId);

    expect((await read(organizationId, longest)).metadata.entries).toEqual({});
    expect(state.events.slice(2).map((e) => [e.event_type, e.aggregate_id])).toEqual([
      ['ledger.account.metadata.saved', longest],
      ['ledger.account.metadata.deleted', longest],
    ]);
  });

  it('saves, logs and publishes nothing when nothing changes', async () => {
    const { organizationId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);
    await save(organizationId, { a: '1' });
    const before = await readState(organizationId);

    await save(organizationId, { a: '1' }); // the same value
    await remove(organizationId, 'never-there'); // a key that is not there
    const after = await readState(organizationId);

    expect(after.logs).toHaveLength(before.logs.length);
    expect(after.events).toHaveLength(before.events.length);
    expect((await read(organizationId)).metadata.entries).toEqual({ a: '1' });
  });

  it('never changes the balances, the overdraft rule, the date or the transactions', async () => {
    const { organizationId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);
    const before = await readState(organizationId);

    await save(organizationId, { a: '1' }, 'users:1');
    await save(organizationId, { a: '1' }, 'world');
    await remove(organizationId, 'a', 'world');
    const after = await readState(organizationId);

    expect(after.balances).toEqual(before.balances);
    expect(after.transactions).toEqual(before.transactions);
    expect(
      after.accounts.map(({ address, allow_overdraft, created_at }) => [
        address,
        allow_overdraft,
        created_at,
      ]),
    ).toEqual(
      before.accounts.map(({ address, allow_overdraft, created_at }) => [
        address,
        allow_overdraft,
        created_at,
      ]),
    );
  });

  it('does not make the account when the metadata of an unknown address is edited', async () => {
    const { organizationId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);

    await expect(save(organizationId, { a: '1' }, 'users:2')).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
    const state = await readState(organizationId);

    expect(state.accounts.map((a) => a.address)).toEqual(['users:1', 'world']);
    expect(state.logs).toHaveLength(2);
  });

  it('keeps the metadata when more money moves through the account', async () => {
    const { organizationId } = await setup();
    await move(organizationId, 'world', 'users:1', 100n);
    await save(organizationId, { customerId: 'c_42' });

    await move(organizationId, 'users:1', 'users:2', 30n);

    const account = await read(organizationId);
    expect(account.metadata.entries).toEqual({ customerId: 'c_42' });
    expect(account.balances[0]?.amount).toBe(70n);
  });

  it('keeps the metadata of the account that a revert takes money from', async () => {
    const { organizationId } = await setup();
    const { transaction } = await move(organizationId, 'world', 'users:1', 100n);
    await save(organizationId, { customerId: 'c_42' });

    await revertTransaction.execute({
      organizationId,
      ledgerName: 'main',
      transactionId: transaction.id,
    });

    const account = await read(organizationId);
    expect(account.metadata.entries).toEqual({ customerId: 'c_42' });
    expect(account.balances[0]?.amount).toBe(0n);
  });

  describe('limits', () => {
    it('refuses too much metadata, and saves nothing', async () => {
      const { organizationId } = await setup();
      await move(organizationId, 'world', 'users:1', 100n);
      const tooMany = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, 'v']));
      const before = await readState(organizationId);

      await expect(save(organizationId, tooMany)).rejects.toBeInstanceOf(
        MetadataLimitExceededError,
      );
      const after = await readState(organizationId);

      expect((await read(organizationId)).metadata.entries).toEqual({});
      expect(after.logs).toHaveLength(before.logs.length);
      expect(after.events).toHaveLength(before.events.length);
    });

    it('checks the stored metadata, so many small saves cannot pass the limit', async () => {
      const { organizationId } = await setup();
      await move(organizationId, 'world', 'users:1', 100n);
      const full = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, 'v']));
      await save(organizationId, full);

      await expect(save(organizationId, { oneMore: 'x' })).rejects.toBeInstanceOf(
        MetadataLimitExceededError,
      );

      expect((await read(organizationId)).metadata.size).toBe(128);
    });

    it('lets an account with a full metadata get smaller, and then bigger again', async () => {
      const { organizationId } = await setup();
      await move(organizationId, 'world', 'users:1', 100n);
      const full = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, 'v']));
      await save(organizationId, full);

      await remove(organizationId, 'k0');
      await save(organizationId, { fresh: 'x' });

      expect((await read(organizationId)).metadata.size).toBe(128);
    });
  });

  describe('not found', () => {
    it('throws LedgerNotFoundError for a ledger that does not exist', async () => {
      const { organizationId } = await setup();

      await expect(save(organizationId, { a: '1' }, 'users:1', 'missing')).rejects.toBeInstanceOf(
        LedgerNotFoundError,
      );
      await expect(remove(organizationId, 'a', 'users:1', 'missing')).rejects.toBeInstanceOf(
        LedgerNotFoundError,
      );
    });

    it('throws AccountNotFoundError for an address no transaction has used', async () => {
      const { organizationId } = await setup();

      await expect(save(organizationId, { a: '1' })).rejects.toBeInstanceOf(AccountNotFoundError);
      await expect(remove(organizationId, 'a')).rejects.toBeInstanceOf(AccountNotFoundError);
    });

    it('does not edit the account of another ledger of the same organization', async () => {
      const { organizationId } = await setup('one');
      await createLedger.execute({ organizationId, name: 'two', metadata: {} });
      await move(organizationId, 'world', 'users:1', 100n, 'one');

      await expect(save(organizationId, { a: 'changed' }, 'users:1', 'two')).rejects.toBeInstanceOf(
        AccountNotFoundError,
      );

      expect((await read(organizationId, 'users:1', 'one')).metadata.entries).toEqual({});
    });

    it('does not edit the account of another organization', async () => {
      const { organizationId } = await setup();
      await move(organizationId, 'world', 'users:1', 100n);
      await save(organizationId, { a: '1' });
      const stranger = newOrganizationId();
      await createLedger.execute({ organizationId: stranger, name: 'main', metadata: {} });

      await expect(save(stranger, { a: 'changed' })).rejects.toBeInstanceOf(AccountNotFoundError);
      await expect(remove(stranger, 'a')).rejects.toBeInstanceOf(AccountNotFoundError);

      expect((await read(organizationId)).metadata.entries).toEqual({ a: '1' });
    });

    it('keeps the same address apart in two ledgers', async () => {
      const { organizationId } = await setup('one');
      await createLedger.execute({ organizationId, name: 'two', metadata: {} });
      await move(organizationId, 'world', 'users:1', 100n, 'one');
      await move(organizationId, 'world', 'users:1', 100n, 'two');

      await save(organizationId, { ledger: 'one' }, 'users:1', 'one');
      await save(organizationId, { ledger: 'two' }, 'users:1', 'two');

      expect((await read(organizationId, 'users:1', 'one')).metadata.entries).toEqual({
        ledger: 'one',
      });
      expect((await read(organizationId, 'users:1', 'two')).metadata.entries).toEqual({
        ledger: 'two',
      });
    });
  });

  describe('at the same time', () => {
    it('keeps every key when many edits of different keys run together', async () => {
      const { organizationId } = await setup();
      await move(organizationId, 'world', 'users:1', 100n);
      const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);

      await Promise.all(keys.map((key) => save(organizationId, { [key]: 'v' })));
      const state = await readState(organizationId);

      expect(Object.keys((await read(organizationId)).metadata.entries).sort()).toEqual(
        [...keys].sort(),
      );
      // ledger created, transaction created, and one entry per edit, with no gap in seq
      expect(state.logs.map((log) => log.seq)).toEqual(
        Array.from({ length: 22 }, (_, i) => String(i + 1)),
      );
    });

    it('lets only one of many edits of the same key win, and logs each of them once', async () => {
      const { organizationId } = await setup();
      await move(organizationId, 'world', 'users:1', 100n);
      const values = Array.from({ length: 10 }, (_, i) => `v${i}`);

      await Promise.all(values.map((winner) => save(organizationId, { winner })));
      const state = await readState(organizationId);

      const metadata = (await read(organizationId)).metadata.entries;
      expect(Object.keys(metadata)).toEqual(['winner']);
      // Every value is different, so every edit is a real change: 2 entries from
      // the setup (ledger, transaction) and 10 from the edits, each with an event.
      expect(state.logs).toHaveLength(12);
      expect(state.events).toHaveLength(12);
      expect(state.logs.map((log) => log.seq)).toEqual(
        Array.from({ length: 12 }, (_, i) => String(i + 1)),
      );
      const recorded = state.logs
        .slice(2)
        .map((log) => (log.payload as { metadata: { winner: string } }).metadata.winner);
      expect([...recorded].sort()).toEqual([...values].sort());
      // The last journal entry is the value that is stored now.
      expect(recorded.at(-1)).toBe(metadata['winner']);
    });

    it('does not deadlock with transactions that move money through the same account', async () => {
      const { organizationId } = await setup();
      await move(organizationId, 'world', 'users:1', 1000n);

      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => save(organizationId, { [`k${i}`]: 'v' })),
        ...Array.from({ length: 10 }, (_, i) =>
          i % 2 === 0
            ? move(organizationId, 'users:1', 'users:2', 10n)
            : move(organizationId, 'world', 'users:1', 10n),
        ),
      ]);
      const state = await readState(organizationId);

      expect((await read(organizationId)).metadata.size).toBe(10);
      // 5 times -10 and 5 times +10 on users:1: net zero
      expect(state.balances.find((b) => b.account_address === 'users:1')?.balance).toBe('1000');
      expect(state.logs.map((log) => log.seq)).toEqual(
        Array.from({ length: state.logs.length }, (_, i) => String(i + 1)),
      );
    });

    it('does not deadlock when edits and moves use the same two accounts in both orders', async () => {
      const { organizationId } = await setup();
      await move(organizationId, 'world', 'a', 1000n);
      await move(organizationId, 'world', 'b', 1000n);

      await Promise.all([
        ...Array.from({ length: 6 }, (_, i) => save(organizationId, { [`a${i}`]: 'v' }, 'a')),
        ...Array.from({ length: 6 }, (_, i) => save(organizationId, { [`b${i}`]: 'v' }, 'b')),
        ...Array.from({ length: 6 }, (_, i) =>
          i % 2 === 0 ? move(organizationId, 'a', 'b', 5n) : move(organizationId, 'b', 'a', 5n),
        ),
      ]);

      expect((await read(organizationId, 'a')).metadata.size).toBe(6);
      expect((await read(organizationId, 'b')).metadata.size).toBe(6);
    });
  });
});
