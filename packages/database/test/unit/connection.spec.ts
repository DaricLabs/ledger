import { createDb } from '../../src/connection.js';

interface FakePool {
  options: Record<string, unknown>;
  listeners: Map<string, (error: Error) => void>;
}

// vi.mock is moved to the top of the file, so what it uses must be created with vi.hoisted.
const { createdPools } = vi.hoisted(() => ({ createdPools: [] as FakePool[] }));

// Replaces `pg` so these tests need no database. The fake only records how the pool is built.
vi.mock('pg', () => ({
  Pool: class implements FakePool {
    listeners = new Map<string, (error: Error) => void>();

    constructor(public options: Record<string, unknown>) {
      createdPools.push(this);
    }

    on(event: string, listener: (error: Error) => void): this {
      this.listeners.set(event, listener);
      return this;
    }
  },
}));

const URL = 'postgres://ledger_runtime:password@127.0.0.1:5432/ledger';

describe('createDb', () => {
  beforeEach(() => {
    createdPools.length = 0;
  });

  it('builds the pool with the given URL, a default of 10 connections, a 10 second connect timeout and a 10 second query timeout', () => {
    createDb(URL, { onPoolError: () => undefined });

    expect(createdPools).toHaveLength(1);
    expect(createdPools[0].options).toEqual({
      connectionString: URL,
      max: 10,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000, // the server cancels a slow query
      query_timeout: 11_000, // client backstop, 1 second longer
    });
  });

  it('uses maxConnections when it is given', () => {
    createDb(URL, { maxConnections: 3, onPoolError: () => undefined });

    expect(createdPools[0].options).toMatchObject({ max: 3 });
  });

  it('accepts the smallest valid pool size, 1', () => {
    createDb(URL, { maxConnections: 1, onPoolError: () => undefined });

    expect(createdPools[0].options).toMatchObject({ max: 1 });
  });

  it.each([
    ['zero (pg would silently use 10)', 0],
    ['a negative number (the pool would always look full)', -1],
    ['a number with decimals', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects maxConnections that is %s, and creates no pool', (_label, maxConnections) => {
    expect(() => createDb(URL, { maxConnections, onPoolError: () => undefined })).toThrow(
      RangeError,
    );
    expect(createdPools).toHaveLength(0);
  });

  it('uses queryTimeoutMillis for the server limit, and a client backstop 1 second longer', () => {
    createDb(URL, { queryTimeoutMillis: 5_000, onPoolError: () => undefined });

    expect(createdPools[0].options).toMatchObject({
      statement_timeout: 5_000,
      query_timeout: 6_000,
    });
  });

  it('accepts the smallest valid query timeout, 1 millisecond', () => {
    createDb(URL, { queryTimeoutMillis: 1, onPoolError: () => undefined });

    expect(createdPools[0].options).toMatchObject({ statement_timeout: 1, query_timeout: 1_001 });
  });

  it.each([
    ['zero (pg would use no limit)', 0],
    ['a negative number', -1],
    ['a number with decimals', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects queryTimeoutMillis that is %s, and creates no pool', (_label, queryTimeoutMillis) => {
    const create = () => createDb(URL, { queryTimeoutMillis, onPoolError: () => undefined });

    expect(create).toThrow(RangeError);
    expect(create).toThrow('queryTimeoutMillis must be a positive integer');
    expect(createdPools).toHaveLength(0);
  });

  it('does not connect when it is created (the fake pool has no connect method)', () => {
    expect(() => createDb(URL, { onPoolError: () => undefined })).not.toThrow();
  });

  it('passes errors of idle pool connections to onPoolError', () => {
    const onPoolError = vi.fn();
    createDb(URL, { onPoolError });
    const failure = new Error('terminating connection due to administrator command');

    createdPools[0].listeners.get('error')?.(failure);

    expect(onPoolError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each(['statement_timeout', 'query_timeout'])(
    'rejects a URL that sets %s, and creates no pool',
    (param) => {
      const create = () => createDb(`${URL}?${param}=0`, { onPoolError: () => undefined });

      expect(create).toThrow(`Remove "${param}" from the database URL`);
      expect(createdPools).toHaveLength(0);
    },
  );

  it('accepts other URL parameters', () => {
    createDb(`${URL}?sslmode=require&application_name=ledger-api`, {
      onPoolError: () => undefined,
    });

    expect(createdPools).toHaveLength(1);
  });

  // Node.js turns a timer above 2_147_483_647 ms into a 1 ms timer. query_timeout is
  // queryTimeoutMillis + 1000, so the biggest allowed value is 1000 below that.
  it('accepts the biggest query timeout whose client backstop still fits a Node.js timer', () => {
    createDb(URL, { queryTimeoutMillis: 2_147_482_647, onPoolError: () => undefined });

    expect(createdPools[0].options).toMatchObject({
      statement_timeout: 2_147_482_647,
      query_timeout: 2_147_483_647,
    });
  });

  it('rejects a query timeout one above that, and creates no pool', () => {
    const create = () =>
      createDb(URL, { queryTimeoutMillis: 2_147_482_648, onPoolError: () => undefined });

    expect(create).toThrow(RangeError);
    expect(create).toThrow('queryTimeoutMillis must not be more than');
    expect(createdPools).toHaveLength(0);
  });
});
