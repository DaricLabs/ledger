import { Inject, Injectable } from '@nestjs/common';
import { AccountAddress } from '@ledger/domain';
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
import { ACCOUNT_LOG_TYPE } from '../../domain/constants/account-log-type.constant.js';
import { AccountNotFoundError } from '../../domain/errors/account-not-found.error.js';
import { ACCOUNT_REPOSITORY, type IAccountRepository } from '../ports/account-repository.port.js';

export interface IDeleteAccountMetadataInput {
  organizationId: string;
  /** The name of the ledger the account is in. */
  ledgerName: string;
  /** The address of the account, like `users:42`. */
  address: string;
  /** The metadata key to remove. */
  key: string;
}

/**
 * Removes one metadata key from an account.
 *
 * In one tenant transaction it locks the account row, saves the new metadata,
 * and writes the `ACCOUNT_METADATA_DELETED` journal entry and the
 * `ledger.account.metadata.deleted` outbox event. Either all of it is saved or
 * none.
 *
 * Deleting a key that is not there is not an error. Nothing is saved, logged
 * or published, because no state changed. So a client can repeat the call
 * safely. An address that has no account is still an error: there is nothing
 * to delete from.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws AccountNotFoundError If the ledger has no account with this address.
 * @throws InvalidAccountAddressError If the address is not valid. The
 * presentation layer checks the shape first, so a caller of the HTTP API never
 * gets here with a bad address.
 * The presentation layer turns these errors into HTTP responses.
 */
@Injectable()
export class DeleteAccountMetadataUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: IDeleteAccountMetadataInput): Promise<void> {
    // Read the input once, before any await. The caller could change its
    // object while we wait for the database, and then the removed key, the
    // journal entry and the event would not agree.
    const { organizationId, ledgerName, key } = input;
    const address = AccountAddress.of(input.address);

    await this.transactions.run(organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(ledgerName);
      }

      // The lock is held until the transaction ends (see SaveAccountMetadataUseCase).
      const account = await this.accounts.lockByAddress(trx, ledger.id, address);
      if (account === null) {
        throw new AccountNotFoundError(address.value);
      }

      const updated = account.withoutMetadataKey(key);
      if (updated === account) {
        return;
      }

      await this.accounts.updateMetadata(trx, ledger.id, updated);
      const logSeq = await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: ACCOUNT_LOG_TYPE.METADATA_DELETED,
        payload: { address: address.value, key },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        logSeq,
        aggregateType: 'account',
        aggregateId: address.value,
        eventType: 'ledger.account.metadata.deleted',
        payload: {
          address: address.value,
          ledgerId: ledger.id,
          organizationId: ledger.organizationId,
          key,
        },
      });
    });
  }
}
