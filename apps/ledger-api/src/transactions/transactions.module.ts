import { Module } from '@nestjs/common';
import { IdsModule } from '../ids/ids.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { LedgersModule } from '../ledgers/ledgers.module.js';
import { ACCOUNT_BALANCE_REPOSITORY } from './application/ports/account-balance-repository.port.js';
import { TRANSACTION_REPOSITORY } from './application/ports/transaction-repository.port.js';
import { CreateTransactionUseCase } from './application/use-cases/create-transaction.use-case.js';
import { GetTransactionUseCase } from './application/use-cases/get-transaction.use-case.js';
import { ListTransactionsUseCase } from './application/use-cases/list-transactions.use-case.js';
import { KyselyAccountBalanceRepository } from './infrastructure/kysely-account-balance.repository.js';
import { KyselyTransactionRepository } from './infrastructure/kysely-transaction.repository.js';
import { TransactionsController } from './presentation/transactions.controller.js';

/**
 * Moves money between accounts.
 *
 * A transaction belongs to a ledger, so this feature imports `LedgersModule`
 * to find a ledger by its name (`LEDGER_REPOSITORY`). Ledgers never import
 * this feature.
 */
@Module({
  imports: [IdsModule, JournalModule, LedgersModule],
  controllers: [TransactionsController],
  providers: [
    { provide: ACCOUNT_BALANCE_REPOSITORY, useClass: KyselyAccountBalanceRepository },
    { provide: TRANSACTION_REPOSITORY, useClass: KyselyTransactionRepository },
    CreateTransactionUseCase,
    GetTransactionUseCase,
    ListTransactionsUseCase,
  ],
  exports: [CreateTransactionUseCase, GetTransactionUseCase, ListTransactionsUseCase],
})
export class TransactionsModule {}
