import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';

export type RecordedEvent =
  | { type: 'begin' }
  | { type: 'commit' }
  | { type: 'rollback' }
  | { type: 'query'; sql: string; parameters: readonly unknown[] };

export interface RecordingDb {
  db: Kysely<any>;
  /** Everything the database "saw", in order. */
  events: RecordedEvent[];
}

/**
 * A Kysely instance that never talks to a real database. It records
 * transaction control and queries, so unit tests can check what our code sends.
 *
 * @param failQuery Return an error for a query to make it fail.
 */
export function createRecordingDb(failQuery?: (sql: string) => Error | undefined): RecordingDb {
  const events: RecordedEvent[] = [];

  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      events.push({ type: 'query', sql: query.sql, parameters: query.parameters });
      const error = failQuery?.(query.sql);
      if (error) throw error;
      return { rows: [] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streamQuery is not supported by the recording driver');
    },
  };

  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {
      events.push({ type: 'begin' });
    },
    async commitTransaction() {
      events.push({ type: 'commit' });
    },
    async rollbackTransaction() {
      events.push({ type: 'rollback' });
    },
    async releaseConnection() {},
    async destroy() {},
  };

  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  return { db, events };
}
