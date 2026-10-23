import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './generated/db.js';

/**
 * A Kysely instance typed with the Ledger schema.
 *
 * Exported so that apps can name this type without adding `kysely` as their
 * own dependency.
 */
export type LedgerDatabase = Kysely<DB>;

/** Options for {@link createDb}. */
export interface CreateDbOptions {
  /**
   * Maximum number of connections in the pool. Defaults to 10.
   * Must be a positive whole number, otherwise `createDb` throws.
   *
   * Keep this value low. Every running instance of a service gets its own
   * pool, so the total is (pool size × number of instances), and it must stay
   * below the `max_connections` limit of Postgres.
   */
  maxConnections?: number;

  /**
   * Called when an idle connection in the pool fails (for example when the
   * database restarts or the network drops).
   *
   * It is required on purpose. `pg` emits an `error` event for these failures.
   * If nobody listens to it, Node.js treats it as an uncaught exception and
   * the whole process crashes. Log the error here. The pool removes the broken
   * connection by itself and opens a new one when needed.
   */
  onPoolError: (error: Error) => void;
}

/**
 * Creates the database client for a long-running service, such as an HTTP API
 * or a background worker.
 *
 * It builds one `pg` connection pool and wraps it in a typed Kysely instance.
 * Create it **once** when the service starts, share it for the whole life of
 * the process, and call `db.destroy()` when the service stops. That closes the
 * pool.
 *
 * The pool is lazy: no connection is opened until the first query, so a wrong
 * URL fails on the first query and not inside this function.
 *
 * Use it with the `ledger_runtime` role (`LEDGER_RUNTIME_DATABASE_URL`). That
 * role has the least access the apps need, and row-level security applies to
 * it. Run tenant queries through `withTenant`, never directly on `db`. A plain
 * query has no tenant, so row-level security refuses it.
 *
 * Why this is not used by `run-migrations.ts` or by the test helpers:
 * - `run-migrations.ts` is a short script. It connects as `ledger_migrator`,
 *   runs the migrations once, and exits. It has no need for the Ledger types
 *   (`Kysely<unknown>`), and a script that exits right away does not need
 *   idle-connection error handling.
 * - The test helpers in `test/support/db.ts` connect as different roles and
 *   need other type parameters.
 *
 * @param url - Postgres connection string, usually `LEDGER_RUNTIME_DATABASE_URL`.
 * @param options - Pool size and the idle-connection error handler.
 * @returns A typed Kysely instance. The caller owns it and must destroy it.
 * @throws {RangeError} If `options.maxConnections` is not a positive whole number.
 *
 * @example
 * const db = createDb(config.databaseUrl, {
 *   onPoolError: (error) => logger.error(error, 'idle database connection failed'),
 * });
 * // ... later, when the service stops:
 * await db.destroy();
 */
export function createDb(url: string, options: CreateDbOptions): LedgerDatabase {
  const maxConnections = options.maxConnections ?? 10;
  // `pg` does not check this value: 0 silently becomes 10, and a negative value
  // makes the pool think it is always full, so every query waits until it times out.
  // Fail at startup instead.
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new RangeError('maxConnections must be a positive integer');
  }

  const pool = new Pool({
    connectionString: url,
    max: maxConnections,
    connectionTimeoutMillis: 10_000, // fail fast instead of waiting forever for a free connection
  });

  pool.on('error', options.onPoolError);

  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
