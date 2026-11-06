import type { TenantTransaction } from '@ledger/database';

/**
 * Runs a piece of work inside one database transaction that belongs to one
 * organization (tenant).
 *
 * A use case never opens a transaction itself, because that needs Kysely.
 * It asks this port instead, and passes the `TenantTransaction` it gets to
 * every other port that must write in the same transaction.
 */
export interface ITenantTransactionRunner {
  /**
   * @param organizationId Tenant that owns the work. It must already be
   * authorized for the caller (the tenant guard checks only the format).
   * @param work Called once with the open transaction.
   * @returns What `work` returns, after the transaction has committed.
   * @throws Anything `work` throws. The transaction is rolled back first.
   */
  run<T>(organizationId: string, work: (trx: TenantTransaction) => Promise<T>): Promise<T>;
}

/** Nest DI token for {@link ITenantTransactionRunner}. */
export const TENANT_TRANSACTION_RUNNER = Symbol('TENANT_TRANSACTION_RUNNER');
