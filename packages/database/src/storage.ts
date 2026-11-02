// Only for infrastructure adapters
export { createDb } from './connection.js';
export type { CreateDbOptions, LedgerDatabase } from './connection.js';
export { assertSafeRuntimeRole } from './role-check.js';
export { withTenant, unwrapTenantTransaction } from './tenant.js';
export { sql } from 'kysely'; // lets adapters write `sql` fragments without depending on kysely themselves
export type { DB } from './generated/db.js';
export { isUniqueViolation } from './pg-errors.js';
export { SqlState } from './sql-state.js';
