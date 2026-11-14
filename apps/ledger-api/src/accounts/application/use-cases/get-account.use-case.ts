import { Inject, Injectable } from '@nestjs/common';
import { AccountAddress } from '@ledger/domain';
import {
  TENANT_TRANSACTION_RUNNER,
  type ITenantTransactionRunner,
} from '../../../journal/application/ports/tenant-transaction-runner.port.js';
import {
  LEDGER_REPOSITORY,
  type ILedgerRepository,
} from '../../../ledgers/application/ports/ledger-repository.port.js';
import { LedgerNotFoundError } from '../../../ledgers/domain/errors/ledger-not-found.error.js';
import { AccountNotFoundError } from '../../domain/account-not-found.error.js';
import type { Account } from '../../domain/account.entity.js';
import { ACCOUNT_REPOSITORY, type IAccountRepository } from '../ports/account-repository.port.js';

export interface IGetAccountInput {
  organizationId: string;
  /** The name of the ledger the account is in. */
  ledgerName: string;
  /** The address of the account, like `users:42`. */
  address: string;
}

/**
 * Gets one account of a ledger by its address, with what it holds.
 *
 * It reads inside a tenant transaction, because row-level security needs the
 * organization to be set. It writes nothing: reads are not logged.
 *
 * Only an address that was used in a transaction has an account. Any other
 * address gives `AccountNotFoundError`, even if it is a valid address.
 *
 * @throws LedgerNotFoundError If the organization has no ledger with this name.
 * @throws AccountNotFoundError If the ledger has no account with this address.
 * The presentation layer turns both errors into HTTP responses.
 * @throws {InvalidAccountAddressError} If the address is not valid. The
 * presentation layer checks the shape first, so a caller of the HTTP API never
 * gets here with a bad address.
 */
@Injectable()
export class GetAccountUseCase {
  constructor(
    @Inject(TENANT_TRANSACTION_RUNNER) private readonly transactions: ITenantTransactionRunner,
    @Inject(LEDGER_REPOSITORY) private readonly ledgers: ILedgerRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
  ) {}

  async execute(input: IGetAccountInput): Promise<Account> {
    // Checked first, because it needs no database.
    const address = AccountAddress.of(input.address);

    return this.transactions.run(input.organizationId, async (trx) => {
      const ledger = await this.ledgers.findByName(trx, input.ledgerName);
      if (ledger === null) {
        throw new LedgerNotFoundError(input.ledgerName);
      }

      const account = await this.accounts.findByAddress(trx, ledger.id, address);
      if (account === null) {
        throw new AccountNotFoundError(input.address);
      }
      return account;
    });
  }
}
