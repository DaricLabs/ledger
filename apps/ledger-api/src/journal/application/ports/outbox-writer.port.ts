import type { TenantTransaction } from '@ledger/database';

/**
 * An event waiting to be published. Other services read the payload, so its
 * shape is a public contract.
 */
export interface IOutboxEvent {
  ledgerId: string;
  /** What the event is about, like `ledger` or `transaction`. */
  aggregateType: string;
  aggregateId: string;
  /** Dotted lowercase name, like `ledger.created`. */
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Saves events for later publishing (transactional outbox). An event is
 * written in the same transaction as the change it announces, so one never
 * exists without the other. A separate worker publishes it.
 */
export interface IOutboxWriter {
  append(trx: TenantTransaction, event: IOutboxEvent): Promise<void>;
}

/** Nest DI token for {@link IOutboxWriter}. */
export const OUTBOX_WRITER = Symbol('OUTBOX_WRITER');
