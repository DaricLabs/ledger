import { Module } from '@nestjs/common';
import { DatabaseModule } from '../core/database/database.module.js';
import { LEDGER_LOG_WRITER } from './application/ports/ledger-log-writer.port.js';
import { OUTBOX_WRITER } from './application/ports/outbox-writer.port.js';
import { TENANT_TRANSACTION_RUNNER } from './application/ports/tenant-transaction-runner.port.js';
import { KyselyLedgerLogWriter } from './infrastructure/adapters/kysely-ledger-log-writer.adapter.js';
import { KyselyOutboxWriter } from './infrastructure/adapters/kysely-outbox-writer.adapter.js';
import { KyselyTenantTransactionRunner } from './infrastructure/adapters/kysely-tenant-transaction-runner.adapter.js';

/**
 * The write path every feature that changes ledger state shares: one tenant
 * transaction, the journal entry and the outbox event written inside it.
 *
 * A feature imports this module and injects the ports by their tokens.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: TENANT_TRANSACTION_RUNNER, useClass: KyselyTenantTransactionRunner },
    { provide: LEDGER_LOG_WRITER, useClass: KyselyLedgerLogWriter },
    { provide: OUTBOX_WRITER, useClass: KyselyOutboxWriter },
  ],
  exports: [TENANT_TRANSACTION_RUNNER, LEDGER_LOG_WRITER, OUTBOX_WRITER],
})
export class JournalModule {}
