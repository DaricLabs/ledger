import { Inject, Injectable } from '@nestjs/common';
import { Ledger } from '../../domain/ledger.entity.js';
import { ID_GENERATOR, type IIdGenerator } from '../ports/id-generator.port.js';
import { LEDGER_REPOSITORY, type ILedgerRepository } from '../ports/ledger-repository.port.js';
import { LEDGER_LOG_WRITER, type ILedgerLogWriter } from '../ports/ledger-log-writer.port.js';
import { OUTBOX_WRITER, type IOutboxWriter } from '../ports/outbox-writer.port.js';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../ports/tenant-transaction-runner.port.js';

export interface ICreateLedgerInput {
  organizationId: string;
  name: string;
  metadata: Record<string, string>;
}

/**
 * Creates a ledger.
 *
 * In one tenant transaction it writes the `ledgers` row, the first journal
 * entry (`LEDGER_CREATED`) and the `ledger.created` outbox event. Either all
 * three are saved or none.
 *
 * The domain checks the name and metadata before any transaction is opened.
 * Domain errors (`InvalidLedgerNameError`, `InvalidLedgerMetadataError`,
 * `LedgerMetadataLimitExceededError`, `LedgerAlreadyExistsError`) pass through
 * unchanged. The presentation layer
 * turns them into HTTP responses.
 */
@Injectable()
export class CreateLedgerUseCase {
  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IIdGenerator,
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: ICreateLedgerInput): Promise<Ledger> {
    const ledger = Ledger.create({
      id: this.ids.next(),
      organizationId: input.organizationId,
      name: input.name,
      metadata: input.metadata,
      createdAt: new Date(),
    });

    await this.transactions.run(input.organizationId, async (trx) => {
      // Order matters: the log and the outbox rows point to the ledger row.
      await this.ledgers.insert(trx, ledger);
      await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: 'LEDGER_CREATED',
        payload: { name: ledger.name, metadata: ledger.metadata },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        aggregateType: 'ledger',
        aggregateId: ledger.id,
        eventType: 'ledger.created',
        payload: {
          ledgerId: ledger.id,
          organizationId: ledger.organizationId,
          name: ledger.name,
          metadata: ledger.metadata,
          createdAt: ledger.createdAt.toISOString(),
        },
      });
    });

    return ledger;
  }
}
