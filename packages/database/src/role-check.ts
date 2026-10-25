import { sql } from 'kysely';
import type { LedgerDatabase } from './connection.js';

/**
 * Checks what the connected Postgres role is allowed to do, and throws if it
 * could skip row-level security.
 *
 * A superuser and a role with BYPASSRLS both ignore RLS policies, so tenant
 * isolation would silently stop working. The role name in the connection URL
 * is only a hint; this asks Postgres itself.
 *
 * Call it once at startup. The error message has the role name only, never
 * the connection URL (it contains the password).
 *
 * @param db - A database client that connects as the runtime role.
 * @throws {Error} If the role is a superuser, has BYPASSRLS, or cannot be read.
 */
export async function assertSafeRuntimeRole(db: LedgerDatabase): Promise<void> {
  const { rows } = await sql<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>`
    select current_user as role, rolsuper, rolbypassrls
    from pg_roles
    where rolname = current_user
  `.execute(db);

  const row = rows[0];
  if (!row) {
    throw new Error('Could not read the current database role from pg_roles');
  }
  if (row.rolsuper) {
    throw new Error(`Database role "${row.role}" must not be a superuser`);
  }
  if (row.rolbypassrls) {
    throw new Error(`Database role "${row.role}" must not have BYPASSRLS`);
  }
}
