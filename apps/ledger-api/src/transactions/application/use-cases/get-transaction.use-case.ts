import { Inject, Injectable } from '@nestjs/common';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import {
  LEDGER_REPOSITORY,
  type ILedgerRepository,
} from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { TransactionNotFoundError } from '../../domain/transaction-not-found.error.js';
import type { Transaction } from '../../domain/transaction.entity.js';
import {
  TRANSACTION_REPOSITORY,
  type ITransactionRepository,
} from '../ports/transaction-repository.port.js';

export interface IGetTransactionInput {
  organizationId: string;
  /** The name of the ledger the transaction is in. */
  ledgerName: string;
  /** The id of the transaction (UUIDv7). */
  transactionId: string;
}

/**
 * Gets one transaction of a ledger by its id.
 *
 * It reads inside a tenant transaction, because row-level security needs the
 * organization to be set. It writes nothing: reads are not logged.
 *
 * Transactions never change once they are saved, so there is nothing to lock.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws TransactionNotFoundError If the ledger has no transaction with this
 * id. The presentation layer turns both errors into HTTP responses.
 */
@Injectable()
export class GetTransactionUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: ITransactionRepository,
  ) {}

  async execute(input: IGetTransactionInput): Promise<Transaction> {
    return this.transactions.run(input.organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, input.ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.ledgerName);
      }

      const transaction = await this.transactionRepository.findById(
        trx,
        ledger.id,
        input.transactionId,
      );
      if (transaction === null) {
        throw new TransactionNotFoundError(input.transactionId);
      }
      return transaction;
    });
  }
}
