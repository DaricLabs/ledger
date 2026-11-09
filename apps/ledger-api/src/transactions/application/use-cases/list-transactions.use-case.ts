import { Inject, Injectable } from '@nestjs/common';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import {
  LEDGER_REPOSITORY,
  type ILedgerRepository,
} from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/ledger-not-found.error.js';
import {
  TRANSACTION_REPOSITORY,
  type ITransactionPage,
  type ITransactionPosition,
  type ITransactionRepository,
} from '../ports/transaction-repository.port.js';

export interface IListTransactionsInput {
  organizationId: string;
  /** The name of the ledger to list. */
  ledgerName: string;
  /** The most transactions to return. The caller checks the allowed range. */
  pageSize: number;
  /** The last transaction of the previous page. Leave it out for the first page. */
  after?: ITransactionPosition;
}

/**
 * Lists the transactions of a ledger, one page at a time, newest first.
 *
 * It reads inside a tenant transaction, because row-level security needs the
 * organization to be set. It writes nothing: reads are not logged.
 *
 * A ledger with no transactions (or a position after the last one) gives an
 * empty page, not an error.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * The presentation layer turns it into an HTTP response.
 */
@Injectable()
export class ListTransactionsUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: ITransactionRepository,
  ) {}

  async execute(input: IListTransactionsInput): Promise<ITransactionPage> {
    return this.transactions.run(input.organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, input.ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.ledgerName);
      }

      return this.transactionRepository.findPage(trx, ledger.id, {
        limit: input.pageSize,
        after: input.after,
      });
    });
  }
}
