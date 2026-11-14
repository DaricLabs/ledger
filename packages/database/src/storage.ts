/**
 * Infrastructure-only entry point.
 *
 * This module is the **only** doorway into the package's database layer.
 * Everything exported here (Kysely instances, query builders, tenant
 * transactions, SQL helpers, etc.) is meant exclusively for infrastructure
 * layer. Application-layer code must **not** import from this file.
 * It should use the type-only surface re-exported from `index.ts` instead.
 *
 * The goal of this split is to keep database runtime dependencies (Kysely
 * and friends) out of the application layer while still giving adapters a
 * single, well-defined entry point.
 */

export { createDb, type CreateDbOptions, type LedgerDatabase } from './connection.js';

export type { DB } from './generated/db.js';

export { assertSafeRuntimeRole } from './role-check.js';

export { withTenant, unwrapTenantTransaction } from './tenant.js';

export { isUniqueViolation } from './pg-errors.js';

export { SqlState } from './sql-state.js';

/**
 * Re-export of Kysely's `sql` template tag, so adapters can write `sql`
 * fragments without taking a direct dependency on `kysely` themselves.
 */
export { sql } from 'kysely';
