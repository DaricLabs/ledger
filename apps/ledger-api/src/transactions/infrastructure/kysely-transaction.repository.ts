import { Injectable } from '@nestjs/common';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { isUniqueViolation, sql, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type { ITransactionRepository } from '../application/ports/transaction-repository.port.js';
import { Posting } from '../domain/posting.js';
import { TransactionReferenceAlreadyExistsError } from '../domain/transaction-reference-already-exists.error.js';
import { Transaction } from '../domain/transaction.entity.js';

/** Postgres name of `unique (organization_id, ledger_id, reference)` on `transactions`. */
const REFERENCE_UNIQUE_CONSTRAINT = 'transactions_organization_id_ledger_id_reference_key';

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
      .select(['id', 'organization_id', 'ledger_id', 'reference', 'posted_at', 'created_at'])
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
      .select(['source_account', 'destination_account', 'asset', 'amount'])
      .where('transaction_id', '=', row.id)
      .orderBy('seq')
      .execute();

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
}
