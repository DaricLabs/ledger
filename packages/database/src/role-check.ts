import { sql } from 'kysely';
import type { LedgerDatabase } from './connection.js';

/**
 * Checks what the connected Postgres role is allowed to do, and throws if it
 * could skip row-level security.
 *
 * These roles ignore RLS policies, so tenant isolation would silently stop working:
 * - a superuser,
 * - a role with BYPASSRLS,
 * - an owner or a member of an owner role (even with NOINHERIT, because it can SET ROLE)
 *   of a table that has RLS enabled but not forced (the owner skips
 *   the policies unless FORCE ROW LEVEL SECURITY is set). Ownership through
 *   membership of another role counts too. This is the `ledger_migrator` case.
 *
 * The role name in the connection URL is only a hint; this asks Postgres itself.
 *
 * Call it once at startup. The error message has the role name only, never
 * the connection URL (it contains the password).
 *
 * @param db - A database client that connects as the runtime role.
 * @throws {Error} If the role is unsafe (see above) or cannot be read.
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

  // pg_has_role(..., 'MEMBER') is true for the role itself and for every role it is a member
  // of, with or without inheriting its privileges. That also covers a NOINHERIT role that
  // can SET ROLE to the owner. ('USAGE' misses that case, and 'SET' needs Postgres 16+.)
  const { rows: ownedRows } = await sql<{ table_name: string }>`
    select c.oid::regclass::text as table_name
    from pg_class c
    where c.relkind in ('r', 'p')
      and c.relrowsecurity
      and not c.relforcerowsecurity
      and pg_has_role(current_user, c.relowner, 'MEMBER')
    limit 1
  `.execute(db);

  const owned = ownedRows[0];
  if (owned) {
    throw new Error(
      `Database role "${row.role}" is, or can become, the owner of table ${owned.table_name} with row-level security that is not forced`,
    );
  }
}
