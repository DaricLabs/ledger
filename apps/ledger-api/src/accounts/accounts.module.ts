import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { LedgersModule } from '../ledgers/ledgers.module.js';
import { ACCOUNT_BALANCE_REPOSITORY } from './application/ports/account-balance-repository.port.js';
import { ACCOUNT_REPOSITORY } from './application/ports/account-repository.port.js';
import { GetAccountUseCase } from './application/use-cases/get-account.use-case.js';
import { ListAccountsUseCase } from './application/use-cases/list-accounts.use-case.js';
import { KyselyAccountBalanceRepository } from './infrastructure/kysely-account-balance.repository.js';
import { KyselyAccountRepository } from './infrastructure/kysely-account.repository.js';
import { AccountsController } from './presentation/accounts.controller.js';

/**
 * Accounts and their balances.
 *
 * An account belongs to a ledger, so this feature imports `LedgersModule` to
 * find a ledger by its name (`LEDGER_REPOSITORY`), and `JournalModule` for the
 * tenant transaction runner.
 *
 * An account is made when money first moves through it. Other features that
 * move money (like transactions) import this module for
 * `ACCOUNT_BALANCE_REPOSITORY`, which creates accounts and changes their
 * balances. Accounts never import those features.
 */
@Module({
  imports: [JournalModule, LedgersModule],
  controllers: [AccountsController],
  providers: [
    { provide: ACCOUNT_BALANCE_REPOSITORY, useClass: KyselyAccountBalanceRepository },
    { provide: ACCOUNT_REPOSITORY, useClass: KyselyAccountRepository },
    GetAccountUseCase,
    ListAccountsUseCase,
  ],
  exports: [ACCOUNT_BALANCE_REPOSITORY, GetAccountUseCase, ListAccountsUseCase],
})
export class AccountsModule {}
