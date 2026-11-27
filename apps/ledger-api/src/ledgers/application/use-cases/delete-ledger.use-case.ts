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

export interface IDeleteLedgerInput {
  organizationId: string;
  name: string;
}

/**
 * Deletes a ledger.
 *
 * This is a soft delete. The ledger row, its logs, transactions and postings
 * stay in storage, because they are append-only and the audit trail must stay
 * whole. What changes is that the ledger is marked as deleted, so every other
 * use case answers `LedgerNotFoundError` for it, and its name can never be
 * used for a new ledger.
 *
 * In one tenant transaction it locks the ledger row, writes the
 * `LEDGER_DELETED` journal entry and the `ledger.deleted` outbox event, and
 * then marks the ledger as deleted. Either all of it is saved or none. The
 * journal entry comes first on purpose: storage refuses journal entries for a
 * deleted ledger, so this is the last one it will ever get.
 *
 * Because of the lock, a delete waits for a change that is already running on
 * the ledger, and a change that starts after the delete does not find the
 * ledger. A change that had already found the ledger before the delete
 * committed is stopped by storage when it writes its journal entry, and
 * nothing of it is saved.
 *
 * A ledger that still holds money can be deleted. Deleting twice is not an
 * error that hurts anyone: the second call finds no ledger and answers
 * `LedgerNotFoundError`.
 *
 * @throws LedgerNotFoundError If the organization has no live ledger with
 * this name (never created, already deleted, or owned by another
 * organization). The presentation layer turns it into an HTTP response.
 */
@Injectable()
export class DeleteLedgerUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: IDeleteLedgerInput): Promise<void> {
    const deletedAt = new Date();

    await this.transactions.run(input.organizationId, async (trx) => {
      // The lock is held until the transaction ends (see SaveLedgerMetadataUseCase).
      const ledger = await this.ledgers.findByNameForUpdate(trx, input.name);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.name);
      }

      // Order matters: the log must come before `markDeleted`, because
      // storage refuses logs for a deleted ledger.
      const logSeq = await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: LEDGER_LOG_TYPE.DELETED,
        payload: { name: ledger.name },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        logSeq,
        aggregateType: 'ledger',
        aggregateId: ledger.id,
        eventType: 'ledger.deleted',
        payload: {
          ledgerId: ledger.id,
          organizationId: ledger.organizationId,
          name: ledger.name,
          deletedAt: deletedAt.toISOString(),
        },
      });
      await this.ledgers.markDeleted(trx, ledger, deletedAt);
    });
  }
}
