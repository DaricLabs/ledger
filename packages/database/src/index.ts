/**
 * Public entry point for the application layer.
 *
 * This module exposes only the pieces of the package that application
 * layer code is allowed to depend on. Anything database-related (Kysely,
 * connection handling, etc.) lives in `storage.ts` and is intentionally
 * **not** re-exported here — only the infrastructure layer may import it.
 *
 * Keep this file free of runtime database concerns so that application
 * layers can safely import from the package root without pulling in
 * database dependencies.
 */

export type { TenantTransaction } from './tenant.js';
