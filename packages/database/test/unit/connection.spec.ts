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

  it('builds the pool with the given URL, a default of 10 connections and a 10 second connect timeout', () => {
    createDb(URL, { onPoolError: () => undefined });

    expect(createdPools).toHaveLength(1);
    expect(createdPools[0].options).toEqual({
      connectionString: URL,
      max: 10,
      connectionTimeoutMillis: 10_000,
    });
  });

  it('uses maxConnections when it is given', () => {
    createDb(URL, { maxConnections: 3, onPoolError: () => undefined });

    expect(createdPools[0].options).toMatchObject({ max: 3 });
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
});
