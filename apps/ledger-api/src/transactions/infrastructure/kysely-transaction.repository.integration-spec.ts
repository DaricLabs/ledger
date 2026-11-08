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
