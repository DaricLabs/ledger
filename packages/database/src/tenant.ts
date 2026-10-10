import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from './generated/db.js';

declare const tenantTransactionBrand: unique symbol;

/**
 * Opaque handle for a Postgres transaction that already has
 * `daric.organization_id` set via withTenant.
 *
 * Ports and use-cases pass this type around and never see the real Kysely
 * Transaction. Only storage-layer adapters may unwrap it, via
 * `unwrapTenantTransaction`. Keeps kysely out of application-layer imports.
 */
export interface TenantTransaction {
  readonly [tenantTransactionBrand]: true;
}

/**
 * Unwraps a TenantTransaction back into the real Kysely Transaction.
 * Only call this inside storage-layer adapters.
 */
export function unwrapTenantTransaction(trx: TenantTransaction): Transaction<DB> {
  return trx as unknown as Transaction<DB>;
}

/**
 * Executes a callback inside a database transaction bound to a specific tenant.
 *
 * This helper sets the PostgreSQL setting `daric.organization_id` for the
 * duration of the transaction only. The Ledger schema uses
 * `current_organization_id()` and row-level-security policies to isolate
 * rows by `organization_id`.
 *
 * The setting is applied with `is_local = true`, so it disappears when the
 * transaction ends. This prevents tenant context from leaking to a reused
 * pooled connection.
 *
 * If `fn` resolves, the transaction commits. If `fn` rejects, the
 * transaction rolls back and the error is propagated to the caller.
 *
 * @template T Return type of the transaction callback.
 * @param db Kysely database instance.
 * @param organizationId Tenant organization identifier. Must be a valid
 * UUIDv7 string and must already be authorized for the current caller.
 * @param fn Callback that performs database work. It receives an opaque
 * `TenantTransaction` handle, not the raw Kysely one. Adapter authors who
 * need the real thing should use `unwrapTenantTransaction`.
 * @returns A promise that resolves with the return value of `fn` after the
 * transaction commits.
 * @throws Propagates any error from setting the tenant context, executing
 * `fn`, or committing/rolling back the transaction.
 *
 * @remarks
 * Use this helper for Ledger operations that must be protected by tenant
 * isolation. Do not use it for trusted cross-tenant background workers
 * unless they have an explicit strategy for row-level security.
 *
 * @example
 * const ledger = await withTenant(db, organizationId, async (tenantTrx) => {
 *   return await ledgerRepository.findFirst(tenantTrx);
 * });
 */
export async function withTenant<T>(
  db: Kysely<DB>,
  organizationId: string,
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('daric.organization_id', ${organizationId}, true)`.execute(trx);
    return fn(trx as unknown as TenantTransaction);
  });
}
