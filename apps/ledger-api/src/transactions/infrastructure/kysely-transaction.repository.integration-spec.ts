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
import type {
  ITransactionPage,
  ITransactionPageQuery,
} from '../application/ports/transaction-repository.port.js';
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
async function prepareLedger(
  trx: TenantTransaction,
  organizationId: string,
  name = 'main',
): Promise<string> {
  const ledgerId = ids.next();
  await unwrapTenantTransaction(trx)
    .insertInto('ledgers')
    .values({ id: ledgerId, organization_id: organizationId, name })
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

describe('KyselyTransactionRepository.findPage', () => {
  const BASE_TIME = new Date('2026-11-07T10:00:00.000Z').getTime();
  /** The time `seconds` after the first transaction time. */
  const at = (seconds: number) => new Date(BASE_TIME + seconds * 1000);

  /** A transaction that happened at this time, with one posting of this amount. */
  const makeAt = (
    organizationId: string,
    ledgerId: string,
    postedAt: Date,
    amount = 1n,
    id = ids.next(),
  ) =>
    Transaction.create({
      id,
      organizationId,
      ledgerId,
      reference: null,
      postings: [posting('world', 'a', amount)],
      postedAt,
      createdAt: postedAt,
    });

  /** Makes a ledger and saves one transaction per time, in this order. Returns the ledger id and the transactions. */
  const saveAll = (organizationId: string, times: Date[]) =>
    withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      const saved: Transaction[] = [];
      for (const [index, time] of times.entries()) {
        const transaction = makeAt(organizationId, ledgerId, time, BigInt(index + 1));
        await repository.insert(trx, transaction);
        saved.push(transaction);
      }
      return { ledgerId, saved };
    });

  const readPage = (organizationId: string, ledgerId: string, query: ITransactionPageQuery) =>
    withTenant(db, organizationId, (trx) => repository.findPage(trx, ledgerId, query));

  const idsOf = (page: ITransactionPage) => page.transactions.map((transaction) => transaction.id);

  it('loads the transactions with all their fields and postings in order', async () => {
    const organizationId = ids.next();

    const { page, saved } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      const created = makeTransaction(organizationId, ledgerId, 'ref-1');
      await repository.insert(trx, created);
      return { saved: created, page: await repository.findPage(trx, ledgerId, { limit: 10 }) };
    });

    expect(page.transactions).toHaveLength(1);
    const [found] = page.transactions;
    expect(found).toBeInstanceOf(Transaction);
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

  it('keeps the postings of each transaction apart and in order', async () => {
    const organizationId = ids.next();

    const page = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await prepareLedger(trx, organizationId);
      for (const [index, count] of [3, 1, 2].entries()) {
        await repository.insert(
          trx,
          Transaction.create({
            id: ids.next(),
            organizationId,
            ledgerId,
            reference: null,
            // The amount of a posting says which transaction and which place it has.
            postings: Array.from({ length: count }, (_, place) =>
              posting('world', 'a', BigInt((index + 1) * 10 + place)),
            ),
            postedAt: at(index),
            createdAt: at(index),
          }),
        );
      }
      return repository.findPage(trx, ledgerId, { limit: 10 });
    });

    // Newest first: the third transaction was saved last and has the latest time.
    expect(page.transactions.map((t) => t.postings.map((p) => p.money.amount))).toEqual([
      [30n, 31n],
      [20n],
      [10n, 11n, 12n],
    ]);
  });

  it('sorts from the newest postedAt, whatever the order the transactions were saved in', async () => {
    const organizationId = ids.next();
    const { ledgerId, saved } = await saveAll(organizationId, [at(20), at(30), at(10)]);

    const page = await readPage(organizationId, ledgerId, { limit: 10 });

    expect(idsOf(page)).toEqual([saved[1]!.id, saved[0]!.id, saved[2]!.id]);
    expect(page.hasMore).toBe(false);
  });

  it('sorts transactions with the same postedAt by id, the biggest first', async () => {
    const organizationId = ids.next();
    const { ledgerId, saved } = await saveAll(organizationId, [at(1), at(1), at(1)]);

    const page = await readPage(organizationId, ledgerId, { limit: 10 });

    expect(idsOf(page)).toEqual(
      saved
        .map((t) => t.id)
        .sort()
        .reverse(),
    );
  });

  it('returns an empty page when the ledger has no transactions', async () => {
    const organizationId = ids.next();
    const ledgerId = await withTenant(db, organizationId, (trx) =>
      prepareLedger(trx, organizationId),
    );

    const page = await readPage(organizationId, ledgerId, { limit: 10 });

    expect(page).toEqual({ transactions: [], hasMore: false });
  });

  it('returns at most `limit` transactions and says there are more', async () => {
    const organizationId = ids.next();
    const { ledgerId, saved } = await saveAll(organizationId, [at(1), at(2), at(3)]);

    const page = await readPage(organizationId, ledgerId, { limit: 2 });

    expect(idsOf(page)).toEqual([saved[2]!.id, saved[1]!.id]);
    expect(page.hasMore).toBe(true);
  });

  it('says there is nothing more when the page holds exactly the rest', async () => {
    const organizationId = ids.next();
    const { ledgerId } = await saveAll(organizationId, [at(1), at(2), at(3)]);

    const exact = await readPage(organizationId, ledgerId, { limit: 3 });
    const roomToSpare = await readPage(organizationId, ledgerId, { limit: 5 });

    expect(exact.transactions).toHaveLength(3);
    expect(exact.hasMore).toBe(false);
    expect(roomToSpare.hasMore).toBe(false);
  });

  it('starts after the given position and does not include it', async () => {
    const organizationId = ids.next();
    const { ledgerId, saved } = await saveAll(organizationId, [at(1), at(2), at(3)]);
    const middle = saved[1]!;

    const page = await readPage(organizationId, ledgerId, {
      limit: 10,
      after: { postedAt: middle.postedAt, id: middle.id },
    });

    expect(idsOf(page)).toEqual([saved[0]!.id]);
  });

  it('keeps the transactions with the same postedAt that come after the position', async () => {
    const organizationId = ids.next();
    const { ledgerId, saved } = await saveAll(organizationId, [at(1), at(1), at(1), at(0)]);
    const [biggest, middle, smallest] = saved
      .slice(0, 3)
      .toSorted((a, b) => (a.id < b.id ? 1 : -1));

    const page = await readPage(organizationId, ledgerId, {
      limit: 10,
      after: { postedAt: biggest!.postedAt, id: biggest!.id },
    });

    // The two others with the same time, then the older one: none is lost.
    expect(idsOf(page)).toEqual([middle!.id, smallest!.id, saved[3]!.id]);
  });

  it('accepts a position that no transaction has', async () => {
    const organizationId = ids.next();
    const { ledgerId, saved } = await saveAll(organizationId, [at(1), at(3)]);

    const page = await readPage(organizationId, ledgerId, {
      limit: 10,
      after: { postedAt: at(2), id: ids.next() },
    });

    expect(idsOf(page)).toEqual([saved[0]!.id]);
  });

  it('returns an empty page after the oldest transaction', async () => {
    const organizationId = ids.next();
    const { ledgerId, saved } = await saveAll(organizationId, [at(1), at(2)]);
    const oldest = saved[0]!;

    const page = await readPage(organizationId, ledgerId, {
      limit: 10,
      after: { postedAt: oldest.postedAt, id: oldest.id },
    });

    expect(page).toEqual({ transactions: [], hasMore: false });
  });

  it('returns only the transactions of the given ledger', async () => {
    const organizationId = ids.next();

    const { page, one } = await withTenant(db, organizationId, async (trx) => {
      const ledgerOne = await prepareLedger(trx, organizationId, 'one');
      const ledgerTwo = await prepareLedger(trx, organizationId, 'two');
      const inOne = makeAt(organizationId, ledgerOne, at(1));
      await repository.insert(trx, inOne);
      await repository.insert(trx, makeAt(organizationId, ledgerTwo, at(2)));
      return { one: inOne, page: await repository.findPage(trx, ledgerOne, { limit: 10 }) };
    });

    expect(idsOf(page)).toEqual([one.id]);
  });

  it('does not return the transactions of other organizations', async () => {
    const owner = ids.next();
    const other = ids.next();
    const { ledgerId } = await saveAll(owner, [at(1), at(2)]);
    await saveAll(other, [at(3)]);

    // The ledger of `owner`, read as `other`: row-level security hides everything.
    const page = await readPage(other, ledgerId, { limit: 10 });

    expect(page).toEqual({ transactions: [], hasMore: false });
  });

  it('reads every transaction once when the pages are followed one by one', async () => {
    const organizationId = ids.next();
    // Two share a time, to check that the pages do not break between them.
    const { ledgerId, saved } = await saveAll(organizationId, [at(1), at(2), at(2), at(3), at(4)]);

    const pages: string[][] = [];
    let after: ITransactionPageQuery['after'];
    for (;;) {
      const page = await readPage(organizationId, ledgerId, { limit: 2, after });
      pages.push(idsOf(page));
      if (!page.hasMore) break;
      const last = page.transactions.at(-1)!;
      after = { postedAt: last.postedAt, id: last.id };
    }

    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toHaveLength(5);
    expect(new Set(pages.flat())).toEqual(new Set(saved.map((t) => t.id)));
  });

  it('does not change the pages that follow when newer transactions are added', async () => {
    const organizationId = ids.next();
    const { ledgerId, saved } = await saveAll(organizationId, [at(1), at(2), at(3)]);

    const first = await readPage(organizationId, ledgerId, { limit: 2 });
    // A new transaction comes in, and it is the newest.
    await withTenant(db, organizationId, (trx) =>
      repository.insert(trx, makeAt(organizationId, ledgerId, at(10))),
    );
    const last = first.transactions.at(-1)!;
    const second = await readPage(organizationId, ledgerId, {
      limit: 2,
      after: { postedAt: last.postedAt, id: last.id },
    });

    expect(idsOf(first)).toEqual([saved[2]!.id, saved[1]!.id]);
    expect(idsOf(second)).toEqual([saved[0]!.id]);
  });

  it('keeps the milliseconds of a position, so a transaction is not read twice', async () => {
    const organizationId = ids.next();
    const times = [new Date('2026-11-07T10:00:00.001Z'), new Date('2026-11-07T10:00:00.002Z')];
    const { ledgerId, saved } = await saveAll(organizationId, times);
    const newest = saved[1]!;

    const page = await readPage(organizationId, ledgerId, {
      limit: 10,
      after: { postedAt: newest.postedAt, id: newest.id },
    });

    expect(idsOf(page)).toEqual([saved[0]!.id]);
  });
});
