import { Inject, Injectable } from '@nestjs/common';
import { LEDGER_LOG_TYPE } from '../../domain/constants/ledger-log-type.constant.js';
import { LedgerNotFoundError } from '../../domain/errors/ledger-not-found.error.js';
import { LEDGER_REPOSITORY, type ILedgerRepository } from '../ports/ledger-repository.port.js';
import {
  LEDGER_LOG_WRITER,
  type ILedgerLogWriter,
} from '../../../journal/application/ports/ledger-log-writer.port.js';
import {
  OUTBOX_WRITER,
  type IOutboxWriter,
} from '../../../journal/application/ports/outbox-writer.port.js';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../../../journal/application/ports/tenant-transaction-runner.port.js';

export interface IDeleteLedgerMetadataInput {
  organizationId: string;
  name: string;
  /** The metadata key to remove. */
  key: string;
}

/**
 * Removes one metadata key from a ledger.
 *
 * In one tenant transaction it locks the ledger row, saves the new metadata,
 * and writes the `LEDGER_METADATA_DELETED` journal entry and the
 * `ledger.metadata.deleted` outbox event. Either all of it is saved or none.
 *
 * Deleting a key that is not there is not an error. Nothing is saved, logged
 * or published, because no state changed. So a client can repeat the call
 * safely.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this
 * name. The presentation layer turns it into an HTTP response.
 */
@Injectable()
export class DeleteLedgerMetadataUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: IDeleteLedgerMetadataInput): Promise<void> {
    await this.transactions.run(input.organizationId, async (trx) => {
      // The lock is held until the transaction ends (see SaveLedgerMetadataUseCase).
      const ledger = await this.ledgers.findByNameForUpdate(trx, input.name);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.name);
      }

      const updated = ledger.withoutMetadataKey(input.key);
      if (updated === ledger) {
        return;
      }

      await this.ledgers.updateMetadata(trx, updated);
      await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: LEDGER_LOG_TYPE.METADATA_DELETED,
        payload: { key: input.key },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        aggregateType: 'ledger',
        aggregateId: ledger.id,
        eventType: 'ledger.metadata.deleted',
        payload: {
          ledgerId: ledger.id,
          organizationId: ledger.organizationId,
          name: ledger.name,
          key: input.key,
        },
      });
    });
  }
}
