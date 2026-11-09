import { Injectable } from '@nestjs/common';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { isUniqueViolation, sql, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type {
  ITransactionPage,
  ITransactionPageQuery,
  ITransactionRepository,
} from '../application/ports/transaction-repository.port.js';
import { Posting } from '../domain/posting.js';
import { TransactionReferenceAlreadyExistsError } from '../domain/transaction-reference-already-exists.error.js';
import { Transaction } from '../domain/transaction.entity.js';

/** Postgres name of `unique (organization_id, ledger_id, reference)` on `transactions`. */
const REFERENCE_UNIQUE_CONSTRAINT = 'transactions_organization_id_ledger_id_reference_key';

/** The `transactions` columns the entity is built from. */
const TRANSACTION_COLUMNS = [
  'id',
  'organization_id',
  'ledger_id',
  'reference',
  'posted_at',
  'created_at',
] as const;

/** The `postings` columns a posting is built from. */
const POSTING_COLUMNS = ['source_account', 'destination_account', 'asset', 'amount'] as const;

/** A row with the columns of `TRANSACTION_COLUMNS`, as Kysely returns it. */
interface ITransactionRow {
  id: string;
  organization_id: string;
  ledger_id: string;
  reference: string | null;
  posted_at: Date;
  created_at: Date;
}

/** A row with the columns of `POSTING_COLUMNS`, as Kysely returns it. */
interface IPostingRow {
  source_account: string;
  destination_account: string;
  asset: string;
  amount: string | bigint | number;
}

/** Stateless: the transaction comes with every call, so this class needs nothing injected. */
@Injectable()
export class KyselyTransactionRepository implements ITransactionRepository {
  async insert(trx: TenantTransaction, transaction: Transaction): Promise<void> {
    const k = unwrapTenantTransaction(trx);

    try {
      await k
        .insertInto('transactions')
        .values({
          id: transaction.id,
          // The tenant is the one set on the transaction (see the balance repository).
          organization_id: sql<string>`current_organization_id()`,
          ledger_id: transaction.ledgerId,
          reference: transaction.reference,
          posted_at: transaction.postedAt,
          created_at: transaction.createdAt,
        })
        .execute();
    } catch (error) {
      // Only the reference constraint means "already exists". An id clash or
      // any other database error is a real failure and must not be hidden.
      if (transaction.reference !== null && isUniqueViolation(error, REFERENCE_UNIQUE_CONSTRAINT)) {
        throw new TransactionReferenceAlreadyExistsError(transaction.reference);
      }
      throw error;
    }

    await k
      .insertInto('postings')
      .values(
        transaction.postings.map((posting, index) => ({
          transaction_id: transaction.id,
          organization_id: sql<string>`current_organization_id()`,
          ledger_id: transaction.ledgerId,
          seq: index + 1, // `postings.seq` starts at 1
          source_account: posting.source.value,
          destination_account: posting.destination.value,
          asset: posting.asset.value,
          amount: posting.money.amount,
        })),
      )
      .execute();
  }

  async findById(
    trx: TenantTransaction,
    ledgerId: string,
    id: string,
  ): Promise<Transaction | null> {
    const k = unwrapTenantTransaction(trx);

    // No `organization_id` filter on purpose: row-level security already limits
    // the rows to the organization of the transaction. The ledger is filtered,
    // so a transaction of another ledger is not found.
    const row = await k
      .selectFrom('transactions')
      .select(TRANSACTION_COLUMNS)
      .where('ledger_id', '=', ledgerId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }

    // A transaction and its postings are saved in one database transaction, so
    // if the transaction row is visible, all its postings are too.
    const postings = await k
      .selectFrom('postings')
      .select(POSTING_COLUMNS)
      .where('transaction_id', '=', row.id)
      .orderBy('seq')
      .execute();

    return toTransaction(row, postings);
  }

  async findPage(
    trx: TenantTransaction,
    ledgerId: string,
    query: ITransactionPageQuery,
  ): Promise<ITransactionPage> {
    const k = unwrapTenantTransaction(trx);

    // No `organization_id` filter here either (see `findById`). The order is
    // the one of `idx_transactions_org_ledger_posted_at`, and `id` makes it
    // total, so two transactions with the same `postedAt` never swap places
    // between two calls.
    let select = k
      .selectFrom('transactions')
      .select(TRANSACTION_COLUMNS)
      .where('ledger_id', '=', ledgerId)
      .orderBy('posted_at', 'desc')
      .orderBy('id', 'desc');
    if (query.after !== undefined) {
      // One comparison of two columns at once. Two separate conditions would
      // lose the transactions that share the `postedAt` of the position.
      // `postedAt` is saved from a JavaScript date, so it has milliseconds and
      // a date in a cursor is exact. The database could hold more digits.
      select = select.where(
        sql<boolean>`(posted_at, id) < (${query.after.postedAt}, ${query.after.id})`,
      );
    }

    // Ask for one row more than the page. If it comes back, there is a next
    // page, and we know it without a second query or a count.
    const rows = await select.limit(query.limit + 1).execute();
    const pageRows = rows.slice(0, query.limit);
    if (pageRows.length === 0) {
      return { transactions: [], hasMore: false };
    }

    // One query for the postings of the whole page, and not one per
    // transaction. At most 100 transactions with 100 postings each.
    const postingRows = await k
      .selectFrom('postings')
      .select(['transaction_id', ...POSTING_COLUMNS])
      .where(
        'transaction_id',
        'in',
        pageRows.map((row) => row.id),
      )
      .orderBy('transaction_id')
      .orderBy('seq')
      .execute();

    const postingsByTransaction = new Map<string, IPostingRow[]>();
    for (const { transaction_id: transactionId, ...posting } of postingRows) {
      const list = postingsByTransaction.get(transactionId) ?? [];
      list.push(posting);
      postingsByTransaction.set(transactionId, list);
    }

    return {
      // A transaction is saved with its postings in one database transaction,
      // so every row of the page has its postings (see `findById`).
      transactions: pageRows.map((row) =>
        toTransaction(row, postingsByTransaction.get(row.id) ?? []),
      ),
      hasMore: rows.length > query.limit,
    };
  }
}

/** Builds the entity from a transaction row and its posting rows, which are in the order of `seq`. */
function toTransaction(row: ITransactionRow, postings: readonly IPostingRow[]): Transaction {
  return Transaction.reconstitute({
    id: row.id,
    organizationId: row.organization_id,
    ledgerId: row.ledger_id,
    reference: row.reference,
    postings: postings.map((posting) =>
      Posting.of(
        AccountAddress.of(posting.source_account),
        AccountAddress.of(posting.destination_account),
        Money.of(AssetCode.of(posting.asset), BigInt(posting.amount)),
      ),
    ),
    postedAt: row.posted_at,
    createdAt: row.created_at,
  });
}
