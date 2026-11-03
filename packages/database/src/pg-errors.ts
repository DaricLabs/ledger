import { SqlState } from './sql-state.js';

/**
 * Tells if `error` is a Postgres unique violation of the constraint called `constraint`.
 *
 * The constraint name is required on purpose. A table can have several unique
 * constraints (for example the primary key and a unique name), and a caller must only
 * react to the one it means. Without a name, a clash on another constraint would be
 * reported as the wrong problem.
 *
 * It reads the `code` and `constraint` fields of the `pg` error without importing `pg`,
 * so apps do not need that dependency.
 *
 * @param error Anything that was thrown.
 * @param constraint Name of the unique constraint or unique index, as Postgres reports it.
 * @returns `true` only for a unique violation of that constraint.
 *
 * @example
 * if (isUniqueViolation(error, 'ledgers_organization_id_name_key')) {
 *   throw new LedgerAlreadyExistsError(name);
 * }
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint: name } = error as { code?: unknown; constraint?: unknown };
  return code === SqlState.UniqueViolation && name === constraint;
}
