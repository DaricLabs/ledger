import { Module } from '@nestjs/common';
import { DatabaseModule } from '../core/database/database.module.js';
import { ID_GENERATOR } from './application/ports/id-generator.port.js';
import { LEDGER_LOG_WRITER } from './application/ports/ledger-log-writer.port.js';
import { LEDGER_REPOSITORY } from './application/ports/ledger-repository.port.js';
import { OUTBOX_WRITER } from './application/ports/outbox-writer.port.js';
import { TENANT_TRANSACTION_RUNNER } from './application/ports/tenant-transaction-runner.port.js';
import { CreateLedgerUseCase } from './application/use-cases/create-ledger.use-case.js';
import { GetLedgerUseCase } from './application/use-cases/get-ledger.use-case.js';
import { KyselyLedgerLogWriter } from './infrastructure/kysely-ledger-log-writer.js';
import { KyselyLedgerRepository } from './infrastructure/kysely-ledger.repository.js';
import { KyselyOutboxWriter } from './infrastructure/kysely-outbox-writer.js';
import { KyselyTenantTransactionRunner } from './infrastructure/kysely-tenant-transaction-runner.js';
import { Uuidv7IdGenerator } from './infrastructure/uuidv7-id-generator.js';
import { LedgersController } from './presentation/ledgers.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [LedgersController],
  providers: [
    { provide: ID_GENERATOR, useClass: Uuidv7IdGenerator },
    { provide: TENANT_TRANSACTION_RUNNER, useClass: KyselyTenantTransactionRunner },
    { provide: LEDGER_REPOSITORY, useClass: KyselyLedgerRepository },
    { provide: LEDGER_LOG_WRITER, useClass: KyselyLedgerLogWriter },
    { provide: OUTBOX_WRITER, useClass: KyselyOutboxWriter },
    CreateLedgerUseCase,
    GetLedgerUseCase,
  ],
  exports: [CreateLedgerUseCase, GetLedgerUseCase],
})
export class LedgersModule {}
