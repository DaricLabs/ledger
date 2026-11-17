import { createHash } from 'node:crypto';
import {
  createDb,
  sql,
  unwrapTenantTransaction,
  withTenant,
  type LedgerDatabase,
} from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import { Uuidv7IdGenerator } from '../../../ids/infrastructure/adapters/uuidv7-id-generator.adapter.js';
import { IdempotencyKeyReusedError } from '../../domain/errors/idempotency-key-reused.error.js';
import { KyselyIdempotencyKeyRepository } from './kysely-idempotency-key.repository.js';

// The repository has no constructor arguments, so these tests do not need Nest.
// Every test uses a new organization id, so tests never see each other's rows.
// Ledgers and transactions are added with plain SQL on purpose: this module
// does not own them.
const ids = new Uuidv7IdGenerator();
const repository = new KyselyIdempotencyKeyRepository();
const OPERATION = 'transactions.create';
let db: LedgerDatabase;

beforeAll(() => {
  // The runtime role, like the app. Row-level security applies to it.
  db = createDb(process.env.LEDGER_RUNTIME_DATABASE_URL!, {
    onPoolError: (error) => console.error(error),
  });
});

afterAll(() => db.destroy());

const hash = (text: string) => createHash('sha256').update(text).digest();

async function insertLedger(
  trx: TenantTransaction,
  organizationId: string,
  name = 'main',
): Promise<string> {
  const id = ids.next();
  await unwrapTenantTransaction(trx)
    .insertInto('ledgers')
    .values({ id, organization_id: organizationId, name })
    .execute();
  return id;
}

/** Saves a transaction row, the way the use case does after it has claimed a key. */
async function insertTransaction(
  trx: TenantTransaction,
  organizationId: string,
  ledgerId: string,
  id: string,
): Promise<void> {
  await unwrapTenantTransaction(trx)
    .insertInto('transactions')
    .values({ id, organization_id: organizationId, ledger_id: ledgerId })
    .execute();
}

/** One organization with one ledger. Each call of `inTrx` is one database transaction. */
async function setup() {
  const organizationId = ids.next();
  const ledgerId = await withTenant(db, organizationId, (trx) => insertLedger(trx, organizationId));
  const inTrx = <T>(work: (trx: TenantTransaction) => Promise<T>) =>
    withTenant(db, organizationId, work);
  return { organizationId, ledgerId, inTrx };
}

const claimInput = (key: string, requestHash = hash('request'), transactionId = ids.next()) => ({
  operation: OPERATION,
  key,
  requestHash,
  transactionId,
});

describe('KyselyIdempotencyKeyRepository (real database)', () => {
  it('gives a new key to the first request', async () => {
    const { organizationId, ledgerId, inTrx } = await setup();

    const claim = await inTrx(async (trx) => {
      const input = claimInput('k1');
      const result = await repository.claim(trx, ledgerId, input);
      await insertTransaction(trx, organizationId, ledgerId, input.transactionId);
      return result;
    });

    expect(claim).toEqual({ replayed: false });
  });

  it('replays a request that was done before, and points to its transaction', async () => {
    const { organizationId, ledgerId, inTrx } = await setup();
    const first = claimInput('k1');
    await inTrx(async (trx) => {
      await repository.claim(trx, ledgerId, first);
      await insertTransaction(trx, organizationId, ledgerId, first.transactionId);
    });

    const second = await inTrx((trx) => repository.claim(trx, ledgerId, claimInput('k1')));

    expect(second).toEqual({ replayed: true, transactionId: first.transactionId });
  });

  it('refuses a live key that is used with another request', async () => {
    const { organizationId, ledgerId, inTrx } = await setup();
    const first = claimInput('k1', hash('request A'));
    await inTrx(async (trx) => {
      await repository.claim(trx, ledgerId, first);
      await insertTransaction(trx, organizationId, ledgerId, first.transactionId);
    });

    await expect(
      inTrx((trx) => repository.claim(trx, ledgerId, claimInput('k1', hash('request B')))),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('keeps the first request after a refusal', async () => {
    const { organizationId, ledgerId, inTrx } = await setup();
    const first = claimInput('k1', hash('request A'));
    await inTrx(async (trx) => {
      await repository.claim(trx, ledgerId, first);
      await insertTransaction(trx, organizationId, ledgerId, first.transactionId);
    });
    await inTrx((trx) =>
      repository.claim(trx, ledgerId, claimInput('k1', hash('request B'))),
    ).catch(() => undefined);

    const again = await inTrx((trx) =>
      repository.claim(trx, ledgerId, claimInput('k1', hash('request A'))),
    );

    expect(again).toEqual({ replayed: true, transactionId: first.transactionId });
  });

  it('treats the same key in another ledger or for another operation as another key', async () => {
    const { organizationId, ledgerId, inTrx } = await setup();
    const secondLedger = await inTrx((trx) => insertLedger(trx, organizationId, 'second'));
    const first = claimInput('k1');
    await inTrx(async (trx) => {
      await repository.claim(trx, ledgerId, first);
      await insertTransaction(trx, organizationId, ledgerId, first.transactionId);
    });

    const otherLedger = await inTrx(async (trx) => {
      const input = claimInput('k1');
      const result = await repository.claim(trx, secondLedger, input);
      await insertTransaction(trx, organizationId, secondLedger, input.transactionId);
      return result;
    });
    const otherOperation = await inTrx(async (trx) => {
      const input = { ...claimInput('k1'), operation: 'transactions.revert' };
      const result = await repository.claim(trx, ledgerId, input);
      await insertTransaction(trx, organizationId, ledgerId, input.transactionId);
      return result;
    });

    expect(otherLedger).toEqual({ replayed: false });
    expect(otherOperation).toEqual({ replayed: false });
  });

  it('does not see the keys of another organization', async () => {
    const a = await setup();
    const b = await setup();
    const input = claimInput('k1');
    await a.inTrx(async (trx) => {
      await repository.claim(trx, a.ledgerId, input);
      await insertTransaction(trx, a.organizationId, a.ledgerId, input.transactionId);
    });

    const claim = await b.inTrx(async (trx) => {
      const own = claimInput('k1');
      const result = await repository.claim(trx, b.ledgerId, own);
      await insertTransaction(trx, b.organizationId, b.ledgerId, own.transactionId);
      return result;
    });

    expect(claim).toEqual({ replayed: false });
  });

  it('frees the key when the work rolls back', async () => {
    const { organizationId, ledgerId, inTrx } = await setup();
    await expect(
      inTrx(async (trx) => {
        await repository.claim(trx, ledgerId, claimInput('k1'));
        throw new Error('the money was not enough');
      }),
    ).rejects.toThrow('the money was not enough');

    const retry = await inTrx(async (trx) => {
      const input = claimInput('k1');
      const result = await repository.claim(trx, ledgerId, input);
      await insertTransaction(trx, organizationId, ledgerId, input.transactionId);
      return result;
    });

    expect(retry).toEqual({ replayed: false });
  });

  it('fails the commit when the transaction row is not saved with the key', async () => {
    const { ledgerId, inTrx } = await setup();

    await expect(
      inTrx((trx) => repository.claim(trx, ledgerId, claimInput('k1'))),
    ).rejects.toMatchObject({ code: '23503' });
  });

  describe('an expired key', () => {
    async function claimThenExpire(
      setupResult: Awaited<ReturnType<typeof setup>>,
      first: ReturnType<typeof claimInput>,
    ) {
      const { organizationId, ledgerId, inTrx } = setupResult;
      await inTrx(async (trx) => {
        await repository.claim(trx, ledgerId, first);
        await insertTransaction(trx, organizationId, ledgerId, first.transactionId);
      });
      // The key is old: it was created 25 hours ago and expired an hour ago.
      await inTrx((trx) =>
        sql`update idempotency_keys
            set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
            where key = ${first.key}`.execute(unwrapTenantTransaction(trx)),
      );
    }

    it('is replaced by the next request, even one with another hash', async () => {
      const s = await setup();
      const first = claimInput('k1', hash('request A'));
      await claimThenExpire(s, first);

      const second = claimInput('k1', hash('request B'));
      const claim = await s.inTrx(async (trx) => {
        const result = await repository.claim(trx, s.ledgerId, second);
        await insertTransaction(trx, s.organizationId, s.ledgerId, second.transactionId);
        return result;
      });
      const replay = await s.inTrx((trx) =>
        repository.claim(trx, s.ledgerId, claimInput('k1', hash('request B'))),
      );

      expect(claim).toEqual({ replayed: false });
      expect(replay).toEqual({ replayed: true, transactionId: second.transactionId });
    });

    it('is remembered for 24 hours again after it is replaced', async () => {
      const s = await setup();
      await claimThenExpire(s, claimInput('k1'));
      const second = claimInput('k1');
      await s.inTrx(async (trx) => {
        await repository.claim(trx, s.ledgerId, second);
        await insertTransaction(trx, s.organizationId, s.ledgerId, second.transactionId);
      });

      const { rows } = await s.inTrx((trx) =>
        sql<{ hours: number }>`select extract(epoch from (expires_at - created_at)) / 3600 as hours
          from idempotency_keys where key = 'k1'`.execute(unwrapTenantTransaction(trx)),
      );

      expect(Number(rows[0]?.hours)).toBeCloseTo(24, 1);
    });
  });

  describe('two requests with the same key at the same time', () => {
    it('lets only one run: the other waits and then replays it', async () => {
      const { organizationId, ledgerId, inTrx } = await setup();
      const a = claimInput('k1');
      const b = claimInput('k1');
      let releaseA!: () => void;
      const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
      let aHasClaimed!: () => void;
      const aClaimed = new Promise<void>((resolve) => (aHasClaimed = resolve));

      // A claims the key and keeps its database transaction open.
      const runA = inTrx(async (trx) => {
        const result = await repository.claim(trx, ledgerId, a);
        await insertTransaction(trx, organizationId, ledgerId, a.transactionId);
        aHasClaimed();
        await aMayCommit;
        return result;
      });
      await aClaimed;

      // B comes with the same key while A is still open. It must wait.
      let bFinished = false;
      const runB = inTrx((trx) => repository.claim(trx, ledgerId, b)).then((result) => {
        bFinished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bFinished).toBe(false);

      releaseA();
      const [resultA, resultB] = await Promise.all([runA, runB]);

      expect(resultA).toEqual({ replayed: false });
      expect(resultB).toEqual({ replayed: true, transactionId: a.transactionId });
    });

    it('lets the second one run when the first one rolls back', async () => {
      const { organizationId, ledgerId, inTrx } = await setup();
      const a = claimInput('k1');
      const b = claimInput('k1');
      let failA!: () => void;
      const aMayFail = new Promise<void>((resolve) => (failA = resolve));
      let aHasClaimed!: () => void;
      const aClaimed = new Promise<void>((resolve) => (aHasClaimed = resolve));

      const runA = inTrx(async (trx) => {
        await repository.claim(trx, ledgerId, a);
        aHasClaimed();
        await aMayFail;
        throw new Error('A failed');
      });
      const settledA = runA.catch((error: Error) => error.message);
      await aClaimed;

      const runB = inTrx(async (trx) => {
        const result = await repository.claim(trx, ledgerId, b);
        await insertTransaction(trx, organizationId, ledgerId, b.transactionId);
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      failA();

      expect(await settledA).toBe('A failed');
      expect(await runB).toEqual({ replayed: false });
    });

    it('gives the key to exactly one of 10 parallel requests', async () => {
      const { organizationId, ledgerId, inTrx } = await setup();
      const inputs = Array.from({ length: 10 }, () => claimInput('k1'));

      const results = await Promise.all(
        inputs.map((input) =>
          inTrx(async (trx) => {
            const result = await repository.claim(trx, ledgerId, input);
            if (!result.replayed) {
              await insertTransaction(trx, organizationId, ledgerId, input.transactionId);
            }
            return result;
          }),
        ),
      );

      const winners = results.flatMap((result, index) => (result.replayed ? [] : [index]));
      expect(winners).toHaveLength(1);
      const winnerId = inputs[winners[0]!]!.transactionId;
      expect(results.filter((r) => r.replayed)).toEqual(
        Array.from({ length: 9 }, () => ({ replayed: true, transactionId: winnerId })),
      );
    });
  });
});
