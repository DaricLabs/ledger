import { Inject, Injectable } from '@nestjs/common';
import {
  LEDGER_REPOSITORY,
  type ILedgerPage,
  type ILedgerRepository,
} from '../ports/ledger-repository.port.js';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../ports/tenant-transaction-runner.port.js';

export interface IListLedgersInput {
  organizationId: string;
  /** The most ledgers to return. The caller checks the allowed range. */
  pageSize: number;
  /** Name of the last ledger of the previous page. Leave it out for the first page. */
  afterName?: string;
}

/**
 * Lists the ledgers of an organization, one page at a time, sorted by name.
 *
 * It reads inside a tenant transaction, because row-level security needs the
 * organization to be set. It writes nothing: reads are not logged.
 *
 * An organization with no ledgers (or a position after the last one) gives an
 * empty page, not an error.
 */
@Injectable()
export class ListLedgersUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
  ) {}

  execute(input: IListLedgersInput): Promise<ILedgerPage> {
    return this.transactions.run(input.organizationId, (trx) =>
      this.ledgers.findPage(trx, { limit: input.pageSize, afterName: input.afterName }),
    );
  }
}
