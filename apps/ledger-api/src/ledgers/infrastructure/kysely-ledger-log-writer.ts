import { Injectable } from '@nestjs/common';
import { sql, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type {
  ILedgerLogEntry,
  ILedgerLogWriter,
} from '../application/ports/ledger-log-writer.port.js';

@Injectable()
export class KyselyLedgerLogWriter implements ILedgerLogWriter {
  async append(trx: TenantTransaction, entry: ILedgerLogEntry): Promise<void> {
    await unwrapTenantTransaction(trx)
      .insertInto('ledger_logs')
      .values({
        // The tenant is the one set on the transaction. A row for another
        // tenant is impossible, and row-level security would refuse it anyway.
        organization_id: sql<string>`current_organization_id()`,
        ledger_id: entry.ledgerId,
        // No default exists, so this is NULL for a moment. The BEFORE INSERT
        // trigger sets the real, gap-free seq before NOT NULL is checked.
        seq: sql<string>`default`,
        type: entry.type,
        payload: JSON.stringify(entry.payload), // Postgres parses the text as jsonb
      })
      .execute();
  }
}
