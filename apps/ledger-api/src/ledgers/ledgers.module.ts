import { Module } from '@nestjs/common';
import { IdsModule } from '../ids/ids.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { LEDGER_REPOSITORY } from './application/ports/ledger-repository.port.js';
import { CreateLedgerUseCase } from './application/use-cases/create-ledger.use-case.js';
import { DeleteLedgerMetadataUseCase } from './application/use-cases/delete-ledger-metadata.use-case.js';
import { GetLedgerUseCase } from './application/use-cases/get-ledger.use-case.js';
import { ListLedgersUseCase } from './application/use-cases/list-ledgers.use-case.js';
import { SaveLedgerMetadataUseCase } from './application/use-cases/save-ledger-metadata.use-case.js';
import { KyselyLedgerRepository } from './infrastructure/repositories/kysely-ledger.repository.js';
import { LedgersController } from './presentation/controllers/ledgers.controller.js';

@Module({
  imports: [IdsModule, JournalModule],
  controllers: [LedgersController],
  providers: [
    { provide: LEDGER_REPOSITORY, useClass: KyselyLedgerRepository },
    CreateLedgerUseCase,
    GetLedgerUseCase,
    ListLedgersUseCase,
    SaveLedgerMetadataUseCase,
    DeleteLedgerMetadataUseCase,
  ],
  exports: [
    // Other features that work inside a ledger (like transactions) find it by name.
    LEDGER_REPOSITORY,
    CreateLedgerUseCase,
    GetLedgerUseCase,
    ListLedgersUseCase,
    SaveLedgerMetadataUseCase,
    DeleteLedgerMetadataUseCase,
  ],
})
export class LedgersModule {}
