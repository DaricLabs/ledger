import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type LedgerDatabase } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import { KYSELY_DB } from '../../../core/database/database.constant.js';
import type { ITenantTransactionRunner } from '../../application/ports/tenant-transaction-runner.port.js';

/**
 * Opens a transaction with `daric.organization_id` set (see `withTenant`), so
 * row-level security applies to everything the work does.
 */
@Injectable()
export class KyselyTenantTransactionRunner implements ITenantTransactionRunner {
  constructor(@Inject(KYSELY_DB) private readonly db: LedgerDatabase) {}

  run<T>(organizationId: string, work: (trx: TenantTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.db, organizationId, work);
  }
}
