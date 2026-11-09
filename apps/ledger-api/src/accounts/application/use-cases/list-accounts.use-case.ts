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
  ACCOUNT_REPOSITORY,
  type IAccountPage,
  type IAccountRepository,
} from '../ports/account-repository.port.js';

export interface IListAccountsInput {
  organizationId: string;
  /** The name of the ledger to list. */
  ledgerName: string;
  /** The most accounts to return. The caller checks the allowed range. */
  pageSize: number;
  /** The address of the last account of the previous page. Leave it out for the first page. */
  afterAddress?: string;
}

/**
 * Lists the accounts of a ledger with their balances, one page at a time,
 * sorted by address.
 *
 * It reads inside a tenant transaction, because row-level security needs the
 * organization to be set. It writes nothing: reads are not logged.
 *
 * A ledger with no accounts (or a position after the last one) gives an empty
 * page, not an error.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * The presentation layer turns it into an HTTP response.
 */
@Injectable()
export class ListAccountsUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
  ) {}

  async execute(input: IListAccountsInput): Promise<IAccountPage> {
    return this.transactions.run(input.organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, input.ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.ledgerName);
      }

      return this.accounts.findPage(trx, ledger.id, {
        limit: input.pageSize,
        afterAddress: input.afterAddress,
      });
    });
  }
}
