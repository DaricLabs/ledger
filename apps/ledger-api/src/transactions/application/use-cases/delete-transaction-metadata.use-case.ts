import { Inject, Injectable } from '@nestjs/common';
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

export interface IDeleteTransactionMetadataInput {
  organizationId: string;
  /** The name of the ledger the transaction is in. */
  ledgerName: string;
  /** The id of the transaction (UUIDv7). */
  transactionId: string;
  /** The metadata key to remove. */
  key: string;
}

/**
 * Removes one metadata key from a transaction.
 *
 * In one tenant transaction it locks the transaction row, saves the new
 * metadata, and writes the `TRANSACTION_METADATA_DELETED` journal entry and
 * the `ledger.transaction.metadata.deleted` outbox event. Either all of it is
 * saved or none.
 *
 * Deleting a key that is not there is not an error. Nothing is saved, logged
 * or published, because no state changed. So a client can repeat the call
 * safely.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws TransactionNotFoundError If the ledger has no transaction with this
 * id. The presentation layer turns these errors into HTTP responses.
 */
@Injectable()
export class DeleteTransactionMetadataUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: ITransactionRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: IDeleteTransactionMetadataInput): Promise<void> {
    // Read the input once, before any await. The caller could change its
    // object while we wait for the database, and then the removed key, the
    // journal entry and the event would not agree.
    const { organizationId, ledgerName, transactionId, key } = input;

    await this.transactions.run(organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(ledgerName);
      }

      // The lock is held until the transaction ends (see SaveTransactionMetadataUseCase).
      const transaction = await this.transactionRepository.lockById(trx, ledger.id, transactionId);
      if (transaction === null) {
        throw new TransactionNotFoundError(transactionId);
      }

      const updated = transaction.withoutMetadataKey(key);
      if (updated === transaction) {
        return;
      }

      await this.transactionRepository.updateMetadata(trx, updated);
      const logSeq = await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: TRANSACTION_LOG_TYPE.METADATA_DELETED,
        transactionId: transaction.id,
        payload: { transactionId: transaction.id, key },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        logSeq,
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        eventType: 'ledger.transaction.metadata.deleted',
        payload: {
          transactionId: transaction.id,
          ledgerId: ledger.id,
          organizationId: transaction.organizationId,
          key,
        },
      });
    });
  }
}
