import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { IdsModule } from '../ids/ids.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { LedgersModule } from '../ledgers/ledgers.module.js';
import { TRANSACTION_REPOSITORY } from './application/ports/transaction-repository.port.js';
import { CreateTransactionUseCase } from './application/use-cases/create-transaction.use-case.js';
import { DeleteTransactionMetadataUseCase } from './application/use-cases/delete-transaction-metadata.use-case.js';
import { GetTransactionUseCase } from './application/use-cases/get-transaction.use-case.js';
import { ListTransactionsUseCase } from './application/use-cases/list-transactions.use-case.js';
import { RevertTransactionUseCase } from './application/use-cases/revert-transaction.use-case.js';
import { SaveTransactionMetadataUseCase } from './application/use-cases/save-transaction-metadata.use-case.js';
import { KyselyTransactionRepository } from './infrastructure/repositories/kysely-transaction.repository.js';
import { TransactionsController } from './presentation/controllers/transactions.controller.js';

/**
 * Moves money between accounts, takes it back (revert), and keeps the
 * metadata of a transaction.
 *
 * A transaction belongs to a ledger, so this feature imports `LedgersModule`
 * to find a ledger by its name (`LEDGER_REPOSITORY`). It imports
 * `AccountsModule` to create accounts and change their balances
 * (`ACCOUNT_BALANCE_REPOSITORY`), and `IdempotencyModule` so a create call can
 * be repeated safely (`IDEMPOTENCY_KEY_REPOSITORY`). Ledgers, accounts and
 * idempotency never import this feature.
 */
@Module({
  imports: [AccountsModule, IdempotencyModule, IdsModule, JournalModule, LedgersModule],
  controllers: [TransactionsController],
  providers: [
    { provide: TRANSACTION_REPOSITORY, useClass: KyselyTransactionRepository },
    CreateTransactionUseCase,
    GetTransactionUseCase,
    ListTransactionsUseCase,
    RevertTransactionUseCase,
    SaveTransactionMetadataUseCase,
    DeleteTransactionMetadataUseCase,
  ],
  exports: [
    CreateTransactionUseCase,
    GetTransactionUseCase,
    ListTransactionsUseCase,
    RevertTransactionUseCase,
    SaveTransactionMetadataUseCase,
    DeleteTransactionMetadataUseCase,
  ],
})
export class TransactionsModule {}
