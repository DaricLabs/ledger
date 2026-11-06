import { Inject, Injectable } from '@nestjs/common';
import { LedgerNotFoundError } from '../../domain/ledger-not-found.error.js';
import { LEDGER_REPOSITORY, type ILedgerRepository } from '../ports/ledger-repository.port.js';
import { LEDGER_LOG_WRITER, type ILedgerLogWriter } from '../ports/ledger-log-writer.port.js';
import { OUTBOX_WRITER, type IOutboxWriter } from '../ports/outbox-writer.port.js';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../ports/tenant-transaction-runner.port.js';

export interface ISaveLedgerMetadataInput {
  organizationId: string;
  name: string;
  /** The entries to add. A key that is already there gets the new value. */
  metadata: Record<string, string>;
}

/**
 * Adds metadata entries to a ledger. Keys that are not in the request stay as
 * they are.
 *
 * In one tenant transaction it locks the ledger row, saves the new metadata,
 * and writes the `LEDGER_METADATA_SAVED` journal entry and the
 * `ledger.metadata.saved` outbox event. Either all of it is saved or none.
 *
 * When every key already has the requested value, nothing is saved, logged or
 * published: no state changed, so there is nothing to record.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws InvalidLedgerMetadataError If the metadata breaks the domain rules.
 * @throws LedgerMetadataLimitExceededError If the ledger would have too many
 * keys, or a key, a value or the total would be too big. The size is checked on
 * the locked, stored metadata, so many small saves cannot pass the limits.
 * The presentation layer turns these errors into HTTP responses.
 */
@Injectable()
export class SaveLedgerMetadataUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: ISaveLedgerMetadataInput): Promise<void> {
    await this.transactions.run(input.organizationId, async (trx) => {
      // The lock is held until the transaction ends. Without it, two edits at
      // the same time could both read the old metadata, and one would be lost.
      const ledger = await this.ledgers.findByNameForUpdate(trx, input.name);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.name);
      }

      const updated = ledger.withMetadata(input.metadata);
      if (updated === ledger) {
        return;
      }

      await this.ledgers.updateMetadata(trx, updated);
      await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: 'LEDGER_METADATA_SAVED',
        payload: { metadata: input.metadata },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        aggregateType: 'ledger',
        aggregateId: ledger.id,
        eventType: 'ledger.metadata.saved',
        payload: {
          ledgerId: ledger.id,
          organizationId: ledger.organizationId,
          name: ledger.name,
          metadata: input.metadata,
        },
      });
    });
  }
}
