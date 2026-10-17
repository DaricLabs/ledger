import { randomBytes } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { inTenant } from './db.js';
import { uuidv7 } from './uuidv7.js';

/** Small insert helpers. Each one inserts one row and uses valid defaults. */

export function randomName(prefix = 'l'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

export async function insertLedger(
  trx: Transaction<DB>,
  organizationId: string,
  values: { id?: string; name?: string } = {},
): Promise<{ id: string; name: string }> {
  const id = values.id ?? uuidv7();
  const name = values.name ?? randomName();
  await trx.insertInto('ledgers').values({ id, organization_id: organizationId, name }).execute();
  return { id, name };
}

export async function insertAccount(
  trx: Transaction<DB>,
  organizationId: string,
  ledgerId: string,
  address: string,
  options: { allowOverdraft?: boolean } = {},
): Promise<void> {
  await trx
    .insertInto('accounts')
    .values({
      organization_id: organizationId,
      ledger_id: ledgerId,
      address,
      allow_overdraft: options.allowOverdraft ?? false,
    })
    .execute();
}

export async function insertTransaction(
  trx: Transaction<DB>,
  organizationId: string,
  ledgerId: string,
  values: { id?: string; reference?: string | null } = {},
): Promise<string> {
  const id = values.id ?? uuidv7();
  await trx
    .insertInto('transactions')
    .values({
      id,
      organization_id: organizationId,
      ledger_id: ledgerId,
      reference: values.reference ?? null,
    })
    .execute();
  return id;
}

export async function insertPosting(
  trx: Transaction<DB>,
  organizationId: string,
  ledgerId: string,
  transactionId: string,
  values: {
    seq?: number;
    source?: string;
    destination?: string;
    asset?: string;
    amount?: string;
  } = {},
): Promise<void> {
  await trx
    .insertInto('postings')
    .values({
      organization_id: organizationId,
      ledger_id: ledgerId,
      transaction_id: transactionId,
      seq: values.seq ?? 1,
      source_account: values.source ?? 'world',
      destination_account: values.destination ?? 'users:1',
      asset: values.asset ?? 'USD',
      amount: values.amount ?? '100',
    })
    .execute();
}

/**
 * Inserts one log and returns the `seq` the database gave it.
 * The generated type makes `seq` required, but the trigger always overwrites
 * it, so the value passed here is ignored (see ledger_logs_assign_seq).
 */
export async function insertLog(
  trx: Transaction<DB>,
  organizationId: string,
  ledgerId: string,
  values: { type?: string; transactionId?: string | null; seq?: number } = {},
): Promise<number> {
  const row = await trx
    .insertInto('ledger_logs')
    .values({
      organization_id: organizationId,
      ledger_id: ledgerId,
      seq: values.seq ?? 0,
      type: values.type ?? 'TRANSACTION_CREATED',
      transaction_id: values.transactionId ?? null,
      payload: {},
    })
    .returning('seq')
    .executeTakeFirstOrThrow();
  return Number(row.seq);
}

export function sha256Like(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

export async function insertAnchor(
  trx: Transaction<DB>,
  organizationId: string,
  ledgerId: string,
  values: { from: number; to: number; root?: Buffer; previous?: Buffer | null },
): Promise<void> {
  await trx
    .insertInto('ledger_audit_anchors')
    .values({
      id: uuidv7(),
      organization_id: organizationId,
      ledger_id: ledgerId,
      from_log_seq: values.from,
      to_log_seq: values.to,
      root_hash: values.root ?? sha256Like(1),
      previous_root_hash: values.previous ?? null,
    })
    .execute();
}

export async function insertOutboxEvent(
  trx: Transaction<DB>,
  organizationId: string,
  ledgerId: string,
  values: Partial<{
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    event_version: number;
    publish_attempts: number;
    published_at: Date | null;
    last_error: string | null;
  }> = {},
): Promise<number> {
  const row = await trx
    .insertInto('outbox_events')
    .values({
      organization_id: organizationId,
      ledger_id: ledgerId,
      aggregate_type: 'transaction',
      aggregate_id: uuidv7(),
      event_type: 'ledger.transaction.created',
      payload: {},
      ...values,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

export async function insertIdempotencyKey(
  trx: Transaction<DB>,
  organizationId: string,
  ledgerId: string,
  values: Partial<{
    operation: string;
    key: string;
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    state: 'in_progress' | 'completed';
    response_status: number | null;
    response_body: Record<string, never> | null;
    completed_at: Date | null;
    created_at: Date;
    expires_at: Date;
    lock_expires_at: Date | null;
    request_hash: Buffer;
  }> = {},
): Promise<string> {
  const key = values.key ?? randomName('key');
  await trx
    .insertInto('idempotency_keys')
    .values({
      organization_id: organizationId,
      ledger_id: ledgerId,
      operation: 'transactions.create',
      key,
      method: 'POST',
      path: '/v2/ledger/transactions',
      request_hash: sha256Like(7),
      expires_at: new Date(Date.now() + 24 * 3_600_000),
      lock_expires_at: new Date(Date.now() + 30_000),
      ...values,
    })
    .execute();
  return key;
}

export interface SeededTenant {
  organizationId: string;
  ledgerId: string;
  transactionId: string;
}

/**
 * Creates a tenant with exactly one row in every table, in a single transaction.
 * Used to prove that other tenants cannot see or change any of it.
 */
export async function seedTenant(
  db: Kysely<DB>,
  organizationId: string = uuidv7(),
): Promise<SeededTenant> {
  return inTenant(db, organizationId, async (trx) => {
    const ledger = await insertLedger(trx, organizationId);
    await insertAccount(trx, organizationId, ledger.id, 'world', { allowOverdraft: true });
    await insertAccount(trx, organizationId, ledger.id, 'users:1');
    const transactionId = await insertTransaction(trx, organizationId, ledger.id);
    await insertPosting(trx, organizationId, ledger.id, transactionId);
    await trx
      .insertInto('balances')
      .values({
        organization_id: organizationId,
        ledger_id: ledger.id,
        account_address: 'users:1',
        asset: 'USD',
      })
      .execute();
    const seq = await insertLog(trx, organizationId, ledger.id, { transactionId });
    await insertAnchor(trx, organizationId, ledger.id, { from: seq, to: seq });
    await insertOutboxEvent(trx, organizationId, ledger.id);
    await insertIdempotencyKey(trx, organizationId, ledger.id);
    return { organizationId, ledgerId: ledger.id, transactionId };
  });
}
