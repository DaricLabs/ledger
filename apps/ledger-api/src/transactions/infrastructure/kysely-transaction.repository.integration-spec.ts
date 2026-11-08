import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import {
  createDb,
  SqlState,
  unwrapTenantTransaction,
  withTenant,
  type LedgerDatabase,
} from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import { Uuidv7IdGenerator } from '../../ids/infrastructure/uuidv7-id-generator.js';
import { AccountBalance } from '../domain/account-balance.js';
import { Posting } from '../domain/posting.js';
import { TransactionReferenceAlreadyExistsError } from '../domain/transaction-reference-already-exists.error.js';
import { Transaction } from '../domain/transaction.entity.js';
import { KyselyAccountBalanceRepository } from './kysely-account-balance.repository.js';
import { KyselyTransactionRepository } from './kysely-transaction.repository.js';

// The repositories have no constructor arguments, so these tests do not need Nest.
// Every test uses a new organization id, so tests never see each other's rows.
const ids = new Uuidv7IdGenerator();
const repository = new KyselyTransactionRepository();
const balances = new KyselyAccountBalanceRepository();
let db: LedgerDatabase;

beforeAll(() => {
  // The runtime role, like the app. Row-level security applies to it.
  db = createDb(process.env.LEDGER_RUNTIME_DATABASE_URL!, {
    onPoolError: (error) => console.error(error),
  });
});

afterAll(() => db.destroy());

const usd = AssetCode.of('USD');
const posting = (source: string, destination: string, amount: bigint) =>
  Posting.of(AccountAddress.of(source), AccountAddress.of(destination), Money.of(usd, amount));

/** Adds a ledger and the accounts `world`, `a` and `b`, so the postings have accounts to point to. */
async function prepareLedger(trx: TenantTransaction, organizationId: string): Promise<string> {
  const ledgerId = ids.next();
  await unwrapTenantTransaction(trx)
    .insertInto('ledgers')
    .values({ id: ledgerId, organization_id: organizationId, name: 'main' })
    .execute();
  await balances.open(
    trx,
    ledgerId,
    ['a', 'b', 'world'].map((name) => AccountBalance.open(AccountAddress.of(name), usd)),
  );
  return ledgerId;
}

const makeTransaction = (
  organizationId: string,
  ledgerId: string,
  reference: string | null,
  id = ids.next(),
) =>
  Transaction.create({
    id,
    organizationId,
    ledgerId,
    reference,
    postings: [posting('world', 'a', 100n), posting('a', 'b', 30n)],
    postedAt: new Date('2026-11-07T10:00:00.000Z'),
    createdAt: new Date('2026-11-07T10:00:01.000Z'),
  });

describe('KyselyTransactionRepository.insert', () => {
  it('saves the transaction and its postings, numbered from 1 in order', async () => {
    const organizationId = ids.next();

    const { transaction, rows, postings } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      const created = makeTransaction(organizationId, ledgerId, 'ref-1');
      await repository.insert(trx, created);
      const k = unwrapTenantTransaction(trx);
      return {
        transaction: created,
        rows: await k.selectFrom('transactions').selectAll().execute(),
        postings: await k.selectFrom('postings').selectAll().orderBy('seq').execute(),
      };
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: transaction.id,
      organization_id: organizationId,
      ledger_id: transaction.ledgerId,
      reference: 'ref-1',
      metadata: {},
      posted_at: new Date('2026-11-07T10:00:00.000Z'),
      created_at: new Date('2026-11-07T10:00:01.000Z'),
      reverted_at: null,
      reverted_by_transaction_id: null,
    });
    expect(
      postings.map((p) => [p.seq, p.source_account, p.destination_account, p.asset, p.amount]),
    ).toEqual([
      [1, 'world', 'a', 'USD', '100'],
      [2, 'a', 'b', 'USD', '30'],
    ]);
  });

  it('saves a transaction without a reference, and there can be many', async () => {
    const organizationId = ids.next();

    const count = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      await repository.insert(trx, makeTransaction(organizationId, ledgerId, null));
      await repository.insert(trx, makeTransaction(organizationId, ledgerId, null));
      return unwrapTenantTransaction(trx).selectFrom('transactions').select('reference').execute();
    });

    expect(count).toEqual([{ reference: null }, { reference: null }]);
  });

  it('maps a duplicate reference to TransactionReferenceAlreadyExistsError', async () => {
    const organizationId = ids.next();

    const error = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      await repository.insert(trx, makeTransaction(organizationId, ledgerId, 'ref-1'));
      await repository.insert(trx, makeTransaction(organizationId, ledgerId, 'ref-1'));
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TransactionReferenceAlreadyExistsError);
  });

  it('does not hide another unique violation (same id, different reference)', async () => {
    const organizationId = ids.next();
    const id = ids.next();

    const error = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      await repository.insert(trx, makeTransaction(organizationId, ledgerId, 'one', id));
      await repository.insert(trx, makeTransaction(organizationId, ledgerId, 'two', id));
    }).catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(TransactionReferenceAlreadyExistsError);
    expect(error).toMatchObject({ code: SqlState.UniqueViolation });
  });

  it('refuses postings of accounts that do not exist (foreign key)', async () => {
    const organizationId = ids.next();

    const error = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      await repository.insert(
        trx,
        Transaction.create({
          id: ids.next(),
          organizationId,
          ledgerId,
          reference: null,
          postings: [posting('world', 'nobody', 1n)],
          postedAt: new Date(),
          createdAt: new Date(),
        }),
      );
    }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: SqlState.ForeignKeyViolation });
  });
});

describe('KyselyTransactionRepository.findById', () => {
  it('finds a saved transaction, with its postings in order', async () => {
    const organizationId = ids.next();

    const { saved, found } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      const created = makeTransaction(organizationId, ledgerId, 'ref-1');
      await repository.insert(trx, created);
      return { saved: created, found: await repository.findById(trx, ledgerId, created.id) };
    });

    expect(found).not.toBeNull();
    expect(found).toMatchObject({
      id: saved.id,
      organizationId,
      ledgerId: saved.ledgerId,
      reference: 'ref-1',
      postedAt: new Date('2026-11-07T10:00:00.000Z'),
      createdAt: new Date('2026-11-07T10:00:01.000Z'),
    });
    expect(
      found?.postings.map((p) => [
        p.source.value,
        p.destination.value,
        p.asset.value,
        p.money.amount,
      ]),
    ).toEqual([
      ['world', 'a', 'USD', 100n],
      ['a', 'b', 'USD', 30n],
    ]);
  });

  it('gives back a null reference as null', async () => {
    const organizationId = ids.next();

    const found = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      const created = makeTransaction(organizationId, ledgerId, null);
      await repository.insert(trx, created);
      return repository.findById(trx, ledgerId, created.id);
    });

    expect(found?.reference).toBeNull();
  });

  it('keeps the posting order for many postings', async () => {
    const organizationId = ids.next();

    const found = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      const created = Transaction.create({
        id: ids.next(),
        organizationId,
        ledgerId,
        reference: null,
        // The amounts are the order: 1, 2, ... 12.
        postings: Array.from({ length: 12 }, (_, i) => posting('world', 'a', BigInt(i + 1))),
        postedAt: new Date('2026-11-07T10:00:00.000Z'),
        createdAt: new Date('2026-11-07T10:00:01.000Z'),
      });
      await repository.insert(trx, created);
      return repository.findById(trx, ledgerId, created.id);
    });

    expect(found?.postings.map((p) => p.money.amount)).toEqual(
      Array.from({ length: 12 }, (_, i) => BigInt(i + 1)),
    );
  });

  it('keeps the biggest amount the column can hold', async () => {
    const organizationId = ids.next();
    const big = 10n ** 78n - 1n;

    const found = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      const created = Transaction.create({
        id: ids.next(),
        organizationId,
        ledgerId,
        reference: null,
        postings: [posting('world', 'a', big)],
        postedAt: new Date('2026-11-07T10:00:00.000Z'),
        createdAt: new Date('2026-11-07T10:00:01.000Z'),
      });
      await repository.insert(trx, created);
      return repository.findById(trx, ledgerId, created.id);
    });

    expect(found?.postings[0]?.money.amount).toBe(big);
  });

  it('gives null for an id that does not exist', async () => {
    const organizationId = ids.next();

    const found = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      return repository.findById(trx, ledgerId, ids.next());
    });

    expect(found).toBeNull();
  });

  it('gives null for a transaction of another ledger of the same organization', async () => {
    const organizationId = ids.next();

    const found = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      const created = makeTransaction(organizationId, ledgerId, null);
      await repository.insert(trx, created);
      return repository.findById(trx, ids.next(), created.id);
    });

    expect(found).toBeNull();
  });

  it('does not find the transaction of another organization', async () => {
    const organizationId = ids.next();
    const { ledgerId, transactionId } = await withTenant(db, organizationId, async (trx) => {
      const id = await prepareLedger(trx, organizationId);
      const created = makeTransaction(organizationId, id, null);
      await repository.insert(trx, created);
      return { ledgerId: id, transactionId: created.id };
    });

    // Even with the right ledger id and transaction id, row-level security hides the rows.
    const found = await withTenant(db, ids.next(), (trx) =>
      repository.findById(trx, ledgerId, transactionId),
    );

    expect(found).toBeNull();
  });
});
