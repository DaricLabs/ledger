import { Inject, Injectable } from '@nestjs/common';
import { LedgerNotFoundError } from '../../domain/errors/ledger-not-found.error.js';
import type { Ledger } from '../../domain/entities/ledger.entity.js';
import { LEDGER_REPOSITORY, type ILedgerRepository } from '../ports/ledger-repository.port.js';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../../../journal/application/ports/tenant-transaction-runner.port.js';

export interface IGetLedgerInput {
  organizationId: string;
  name: string;
}

/**
 * Gets one ledger of an organization by its name.
 *
 * It reads inside a tenant transaction, because row-level security needs the
 * organization to be set. It writes nothing: reads are not logged.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this
 * name. The presentation layer turns it into an HTTP response.
 */
@Injectable()
export class GetLedgerUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
  ) {}

  async execute(input: IGetLedgerInput): Promise<Ledger> {
    const ledger = await this.transactions.run(input.organizationId, (trx) =>
      this.ledgers.findByName(trx, input.name),
    );
    if (ledger === null) {
      throw new LedgerNotFoundError(input.name);
    }
    return ledger;
  }
}
