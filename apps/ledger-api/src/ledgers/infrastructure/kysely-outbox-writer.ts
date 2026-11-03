import { Injectable } from '@nestjs/common';
import { sql, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type { IOutboxEvent, IOutboxWriter } from '../application/ports/outbox-writer.port.js';

@Injectable()
export class KyselyOutboxWriter implements IOutboxWriter {
  async append(trx: TenantTransaction, event: IOutboxEvent): Promise<void> {
    await unwrapTenantTransaction(trx)
      .insertInto('outbox_events')
      .values({
        organization_id: sql<string>`current_organization_id()`, // same reason as the log writer
        ledger_id: event.ledgerId,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        event_type: event.eventType,
        payload: JSON.stringify(event.payload), // Postgres parses the text as jsonb
      })
      .execute();
  }
}
