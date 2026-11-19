import { Inject, Injectable } from '@nestjs/common';
import type { MetadataEntries } from '@ledger/domain';
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
import {
  LEDGER_REPOSITORY,
  type ILedgerRepository,
} from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { TRANSACTION_LOG_TYPE } from '../../domain/constants/transaction-log-type.constant.js';
import { TransactionNotFoundError } from '../../domain/errors/transaction-not-found.error.js';
import {
  TRANSACTION_REPOSITORY,
  type ITransactionRepository,
} from '../ports/transaction-repository.port.js';

export interface ISaveTransactionMetadataInput {
  organizationId: string;
  /** The name of the ledger the transaction is in. */
  ledgerName: string;
  /** The id of the transaction (UUIDv7). */
  transactionId: string;
  /** The entries to add. A key that is already there gets the new value. */
  metadata: MetadataEntries;
}

/**
 * Adds metadata entries to a transaction. Keys that are not in the request
 * stay as they are.
 *
 * A transaction never changes, but its metadata does, so every edit leaves a
 * trace. In one tenant transaction it locks the transaction row, saves the new
 * metadata, and writes the `TRANSACTION_METADATA_SAVED` journal entry and the
 * `ledger.transaction.metadata.saved` outbox event. Either all of it is saved
 * or none. The entry and the event are about the edited transaction, and their
 * payload holds only the keys that changed (a key that already had the
 * requested value is left out).
 *
 * When every key already has the requested value, nothing is saved, logged or
 * published: no state changed, so there is nothing to record.
 *
 * It works the same for a reverted transaction. Metadata is a note about the
 * transaction, and it does not move any money.
 *
 * The locks are taken in the same order as in the revert (the transaction row,
 * then the journal), so the two never wait for each other in a circle.
 *
 * Do not put personal data in metadata: the journal and the outbox are
 * append-only, so what is written there stays. Use ids instead.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws TransactionNotFoundError If the ledger has no transaction with this id.
 * @throws InvalidMetadataError If the metadata breaks the domain rules.
 * @throws MetadataLimitExceededError If the transaction would have too many
 * keys, or a key, a value or the total would be too big. The size is checked
 * on the locked, stored metadata, so many small saves cannot pass the limits.
 * The presentation layer turns these errors into HTTP responses.
 */
@Injectable()
export class SaveTransactionMetadataUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: ITransactionRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: ISaveTransactionMetadataInput): Promise<void> {
    await this.transactions.run(input.organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, input.ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.ledgerName);
      }

      // The lock is held until the transaction ends. Without it, two edits at
      // the same time could both read the old metadata, and one would be lost.
      const transaction = await this.transactionRepository.lockById(
        trx,
        ledger.id,
        input.transactionId,
      );
      if (transaction === null) {
        throw new TransactionNotFoundError(input.transactionId);
      }

      const updated = transaction.withMetadata(input.metadata);
      if (updated === transaction) {
        return;
      }

      const changed = changedEntries(transaction.metadata.entries, input.metadata);
      await this.transactionRepository.updateMetadata(trx, updated);
      await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: TRANSACTION_LOG_TYPE.METADATA_SAVED,
        transactionId: transaction.id,
        payload: { transactionId: transaction.id, metadata: changed },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        eventType: 'ledger.transaction.metadata.saved',
        payload: {
          transactionId: transaction.id,
          ledgerId: ledger.id,
          organizationId: transaction.organizationId,
          metadata: changed,
        },
      });
    });
  }
}

/** The entries of `requested` that are new or have another value than in `stored`. */
function changedEntries(stored: MetadataEntries, requested: MetadataEntries): MetadataEntries {
  return Object.fromEntries(
    Object.entries(requested).filter(
      ([key, value]) => !Object.hasOwn(stored, key) || stored[key] !== value,
    ),
  );
}
