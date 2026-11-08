import { Injectable } from '@nestjs/common';
import { isUniqueViolation, sql, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type { ITransactionRepository } from '../application/ports/transaction-repository.port.js';
import { TransactionReferenceAlreadyExistsError } from '../domain/transaction-reference-already-exists.error.js';
import type { Transaction } from '../domain/transaction.entity.js';

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
}
