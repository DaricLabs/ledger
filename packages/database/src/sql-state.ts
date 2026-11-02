/**
 * Postgres error codes (SQLSTATE). The value is the 5-character `code` field that `pg`
 * puts on a database error.
 *
 * This is not the full list. Add a code when you first need it. The full list is in the
 * PostgreSQL docs, appendix "PostgreSQL Error Codes".
 */
export enum SqlState {
  // Class 08: connection problems
  ConnectionException = '08000',
  ConnectionDoesNotExist = '08003',
  ConnectionFailure = '08006',

  // Class 22: bad data
  StringDataRightTruncation = '22001',
  /** For example a number that does not fit in `numeric(78, 0)`. */
  NumericValueOutOfRange = '22003',
  /** For example a text that is not a valid UUID. */
  InvalidTextRepresentation = '22P02',

  // Class 23: constraint violations
  NotNullViolation = '23502',
  ForeignKeyViolation = '23503',
  UniqueViolation = '23505',
  /** Also raised by a failed `check` of a domain (for example `uuidv7`). */
  CheckViolation = '23514',
  ExclusionViolation = '23P01',

  // Class 25: transaction state
  /** Any statement after a failed one, inside the same transaction. */
  InFailedSqlTransaction = '25P02',

  // Class 40: transaction rollback
  SerializationFailure = '40001',
  DeadlockDetected = '40P01',

  // Class 42: access and syntax
  /** Also raised when a row-level security policy refuses a write. */
  InsufficientPrivilege = '42501',
  SyntaxError = '42601',
  UndefinedColumn = '42703',
  UndefinedTable = '42P01',

  // Class 53: server resources
  TooManyConnections = '53300',

  // Class 55: object state
  LockNotAvailable = '55P03',

  // Class 57: operator intervention
  /** Also raised when `statement_timeout` cancels a slow query. */
  QueryCanceled = '57014',
  AdminShutdown = '57P01',

  // Class P0: PL/pgSQL
  /** Default code of `raise exception`, like the append-only triggers do. */
  RaiseException = 'P0001',
}
