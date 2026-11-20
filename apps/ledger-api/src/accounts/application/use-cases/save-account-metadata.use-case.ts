import { Inject, Injectable } from '@nestjs/common';
import { AccountAddress, Metadata, type MetadataEntries } from '@ledger/domain';
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

export interface ISaveAccountMetadataInput {
  organizationId: string;
  /** The name of the ledger the account is in. */
  ledgerName: string;
  /** The address of the account, like `users:42`. */
  address: string;
  /** The entries to add. A key that is already there gets the new value. */
  metadata: MetadataEntries;
}

/**
 * Adds metadata entries to an account. Keys that are not in the request stay
 * as they are.
 *
 * An account is made by a transaction, so only an address that a transaction
 * has used can get metadata. Any other address gives `AccountNotFoundError`,
 * like the get call does.
 *
 * Every edit leaves a trace. In one tenant transaction it locks the account
 * row, saves the new metadata, and writes the `ACCOUNT_METADATA_SAVED` journal
 * entry and the `ledger.account.metadata.saved` outbox event. Either all of it
 * is saved or none. The payload holds only the keys that changed (a key that
 * already had the requested value is left out).
 *
 * When every key already has the requested value, nothing is saved, logged or
 * published: no state changed, so there is nothing to record.
 *
 * Only the account row is locked, not its balances, so an edit never makes a
 * transaction that moves money through the account wait. The journal is
 * locked last, like in every other writer, so two writers never wait for each
 * other in a circle.
 *
 * Do not put personal data in metadata: the journal and the outbox are
 * append-only, so what is written there stays. Use ids instead.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws AccountNotFoundError If the ledger has no account with this address.
 * @throws InvalidAccountAddressError If the address is not valid. The
 * presentation layer checks the shape first, so a caller of the HTTP API never
 * gets here with a bad address.
 * @throws InvalidMetadataError If the metadata breaks the domain rules. This
 * is checked first, before the ledger is looked up.
 * @throws MetadataLimitExceededError If a key or a value is too big, or the
 * account would have too many keys or be too big in total. The total is
 * checked on the locked, stored metadata, so many small saves cannot pass the
 * limits.
 * The presentation layer turns these errors into HTTP responses.
 */
@Injectable()
export class SaveAccountMetadataUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(LEDGER_LOG_WRITER) private readonly logs: ILedgerLogWriter,
    @Inject(OUTBOX_WRITER) private readonly outbox: IOutboxWriter,
  ) {}

  async execute(input: ISaveAccountMetadataInput): Promise<void> {
    // Read the input once, before any await. The caller could change its
    // object while we wait for the database, and then the saved metadata, the
    // journal entry and the event would not agree. `Metadata.of` copies and
    // checks the entries, so this also refuses bad metadata before we open a
    // database transaction.
    const { organizationId, ledgerName } = input;
    const address = AccountAddress.of(input.address);
    const changes = Metadata.of(input.metadata).entries;

    await this.transactions.run(organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(ledgerName);
      }

      // The lock is held until the transaction ends. Without it, two edits at
      // the same time could both read the old metadata, and one would be lost.
      const account = await this.accounts.lockByAddress(trx, ledger.id, address);
      if (account === null) {
        throw new AccountNotFoundError(address.value);
      }

      const updated = account.withMetadata(changes);
      if (updated === account) {
        return;
      }

      const changed = changedEntries(account.metadata.entries, changes);
      await this.accounts.updateMetadata(trx, ledger.id, updated);
      await this.logs.append(trx, {
        ledgerId: ledger.id,
        type: ACCOUNT_LOG_TYPE.METADATA_SAVED,
        payload: { address: address.value, metadata: changed },
      });
      await this.outbox.append(trx, {
        ledgerId: ledger.id,
        aggregateType: 'account',
        aggregateId: address.value,
        eventType: 'ledger.account.metadata.saved',
        payload: {
          address: address.value,
          ledgerId: ledger.id,
          organizationId: ledger.organizationId,
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
