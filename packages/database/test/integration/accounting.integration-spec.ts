import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import {
  insertAccount,
  insertLedger,
  insertPosting,
  insertTransaction,
  randomName,
} from '../support/fixtures.js';
import { uuidv7 } from '../support/uuidv7.js';

const UINT256_MAX = (2n ** 256n - 1n).toString();
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

describe('ledgers, accounts, transactions and postings', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe('ledgers', () => {
    it('starts with empty metadata and no logs', async () => {
      const org = uuidv7();

      const ledger = await inTenant(db, org, async (trx) => {
        const { id } = await insertLedger(trx, org);
        return trx.selectFrom('ledgers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      });

      expect(ledger.metadata).toEqual({});
      expect(ledger.last_log_seq).toBe('0');
    });

    it('does not allow two ledgers with the same name in one organization', async () => {
      const org = uuidv7();
      const name = randomName();

      await expect(
        inTenant(db, org, async (trx) => {
          await insertLedger(trx, org, { name });
          await insertLedger(trx, org, { name });
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('allows the same ledger name in different organizations', async () => {
      const name = randomName();
      const [orgA, orgB] = [uuidv7(), uuidv7()];

      await inTenant(db, orgA, (trx) => insertLedger(trx, orgA, { name }));
      await inTenant(db, orgB, (trx) => insertLedger(trx, orgB, { name }));
    });
  });

  describe('accounts', () => {
    it('does not allow overdraft by default', async () => {
      const org = uuidv7();

      const account = await inTenant(db, org, async (trx) => {
        const ledger = await insertLedger(trx, org);
        await insertAccount(trx, org, ledger.id, 'users:1');
        return trx.selectFrom('accounts').selectAll().executeTakeFirstOrThrow();
      });

      expect(account.allow_overdraft).toBe(false);
      expect(account.metadata).toEqual({});
    });

    it('needs an existing ledger', async () => {
      const org = uuidv7();

      await expect(
        inTenant(db, org, (trx) => insertAccount(trx, org, uuidv7(), 'users:1')),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });

    it('cannot point at a ledger of another organization (composite foreign key)', async () => {
      const [orgA, orgB] = [uuidv7(), uuidv7()];
      const ledgerOfB = await inTenant(db, orgB, (trx) => insertLedger(trx, orgB));

      await expect(
        inTenant(db, orgA, (trx) => insertAccount(trx, orgA, ledgerOfB.id, 'users:1')),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });

    it('has unique addresses inside a ledger, but not across ledgers', async () => {
      const org = uuidv7();

      await inTenant(db, org, async (trx) => {
        const one = await insertLedger(trx, org);
        const two = await insertLedger(trx, org);
        await insertAccount(trx, org, one.id, 'users:1');
        await insertAccount(trx, org, two.id, 'users:1'); // same address, other ledger: fine
      });

      await expect(
        inTenant(db, org, async (trx) => {
          const ledger = await insertLedger(trx, org);
          await insertAccount(trx, org, ledger.id, 'users:1');
          await insertAccount(trx, org, ledger.id, 'users:1');
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  describe('transactions', () => {
    async function withLedger<T>(
      fn: (trx: Transaction<DB>, org: string, ledgerId: string) => Promise<T>,
    ): Promise<T> {
      const org = uuidv7();
      return inTenant(db, org, async (trx) => {
        const ledger = await insertLedger(trx, org);
        return fn(trx, org, ledger.id);
      });
    }

    it('allows many transactions without a reference', async () => {
      await withLedger(async (trx, org, ledgerId) => {
        await insertTransaction(trx, org, ledgerId);
        await insertTransaction(trx, org, ledgerId);
      });
    });

    it('does not allow the same reference twice in one ledger', async () => {
      await expect(
        withLedger(async (trx, org, ledgerId) => {
          await insertTransaction(trx, org, ledgerId, { reference: 'order-1' });
          await insertTransaction(trx, org, ledgerId, { reference: 'order-1' });
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('allows the same reference in different ledgers', async () => {
      const org = uuidv7();

      await inTenant(db, org, async (trx) => {
        const one = await insertLedger(trx, org);
        const two = await insertLedger(trx, org);
        await insertTransaction(trx, org, one.id, { reference: 'order-1' });
        await insertTransaction(trx, org, two.id, { reference: 'order-1' });
      });
    });

    it.each([
      ['empty', ''],
      ['longer than 128 characters', 'r'.repeat(129)],
    ])('rejects a reference that is %s', async (_label, reference) => {
      await expect(
        withLedger((trx, org, ledgerId) => insertTransaction(trx, org, ledgerId, { reference })),
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'transactions_reference_length',
      });
    });

    it('accepts a reference of exactly 128 characters', async () => {
      await withLedger((trx, org, ledgerId) =>
        insertTransaction(trx, org, ledgerId, { reference: 'r'.repeat(128) }),
      );
    });

    it('can be reverted by another transaction of the same ledger', async () => {
      const reverted = await withLedger(async (trx, org, ledgerId) => {
        const original = await insertTransaction(trx, org, ledgerId);
        const revert = await insertTransaction(trx, org, ledgerId);
        await trx
          .updateTable('transactions')
          .set({ reverted_at: new Date(), reverted_by_transaction_id: revert })
          .where('id', '=', original)
          .execute();
        return trx
          .selectFrom('transactions')
          .select(['reverted_at', 'reverted_by_transaction_id'])
          .where('id', '=', original)
          .executeTakeFirstOrThrow();
      });

      expect(reverted.reverted_at).toBeInstanceOf(Date);
      expect(reverted.reverted_by_transaction_id).not.toBeNull();
    });

    it.each([
      ['only reverted_at', { reverted_at: new Date() }],
      ['only reverted_by_transaction_id', { reverted_by_transaction_id: uuidv7() }],
    ])('rejects a revert with %s', async (_label, fields) => {
      await expect(
        withLedger(async (trx, org, ledgerId) => {
          const id = await insertTransaction(trx, org, ledgerId);
          await trx.updateTable('transactions').set(fields).where('id', '=', id).execute();
        }),
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'transactions_revert_fields_consistent',
      });
    });

    it('cannot be reverted by a transaction that does not exist', async () => {
      await expect(
        withLedger(async (trx, org, ledgerId) => {
          const id = await insertTransaction(trx, org, ledgerId);
          await trx
            .updateTable('transactions')
            .set({ reverted_at: new Date(), reverted_by_transaction_id: uuidv7() })
            .where('id', '=', id)
            .execute();
        }),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });

    it('lets the app edit metadata', async () => {
      const metadata = await withLedger(async (trx, org, ledgerId) => {
        const id = await insertTransaction(trx, org, ledgerId);
        await trx
          .updateTable('transactions')
          .set({ metadata: { channel: 'web' } })
          .where('id', '=', id)
          .execute();
        return (
          await trx
            .selectFrom('transactions')
            .select('metadata')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).metadata;
      });

      expect(metadata).toEqual({ channel: 'web' });
    });
  });

  describe('postings', () => {
    /** One ledger with accounts `world` and `users:1`, plus an empty transaction. */
    async function withTransaction<T>(
      fn: (
        trx: Transaction<DB>,
        ids: { org: string; ledgerId: string; transactionId: string },
      ) => Promise<T>,
    ): Promise<T> {
      const org = uuidv7();
      return inTenant(db, org, async (trx) => {
        const ledger = await insertLedger(trx, org);
        await insertAccount(trx, org, ledger.id, 'world');
        await insertAccount(trx, org, ledger.id, 'users:1');
        const transactionId = await insertTransaction(trx, org, ledger.id);
        return fn(trx, { org, ledgerId: ledger.id, transactionId });
      });
    }

    it('accepts seq 1 and seq 100', async () => {
      await withTransaction(async (trx, { org, ledgerId, transactionId }) => {
        await insertPosting(trx, org, ledgerId, transactionId, { seq: 1 });
        await insertPosting(trx, org, ledgerId, transactionId, { seq: 100 });
      });
    });

    it.each([
      [0, 'postings_seq_positive'],
      [101, 'postings_seq_max'],
    ])('rejects seq %i', async (seq, constraint) => {
      await expect(
        withTransaction((trx, { org, ledgerId, transactionId }) =>
          insertPosting(trx, org, ledgerId, transactionId, { seq }),
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
    });

    it('does not allow the same seq twice in one transaction', async () => {
      await expect(
        withTransaction(async (trx, { org, ledgerId, transactionId }) => {
          await insertPosting(trx, org, ledgerId, transactionId, { seq: 1 });
          await insertPosting(trx, org, ledgerId, transactionId, { seq: 1 });
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('does not allow the same source and destination', async () => {
      await expect(
        withTransaction((trx, { org, ledgerId, transactionId }) =>
          insertPosting(trx, org, ledgerId, transactionId, {
            source: 'world',
            destination: 'world',
          }),
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'postings_accounts_distinct' });
    });

    it.each(['0', '-1'])('rejects the amount %s', async (amount) => {
      await expect(
        withTransaction((trx, { org, ledgerId, transactionId }) =>
          insertPosting(trx, org, ledgerId, transactionId, { amount }),
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('stores the biggest uint256 amount exactly, as a string', async () => {
      const posting = await withTransaction(async (trx, { org, ledgerId, transactionId }) => {
        await insertPosting(trx, org, ledgerId, transactionId, { amount: UINT256_MAX });
        return trx.selectFrom('postings').select('amount').executeTakeFirstOrThrow();
      });

      expect(posting.amount).toBe(UINT256_MAX);
    });

    it.each([
      ['source', { source: 'missing' }],
      ['destination', { destination: 'missing' }],
    ])('needs an existing %s account', async (_label, accounts) => {
      await expect(
        withTransaction((trx, { org, ledgerId, transactionId }) =>
          insertPosting(trx, org, ledgerId, transactionId, accounts),
        ),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });

    it('cannot use an account of another ledger, even in the same organization', async () => {
      await expect(
        withTransaction(async (trx, { org, ledgerId, transactionId }) => {
          const other = await insertLedger(trx, org);
          await insertAccount(trx, org, other.id, 'only-in-other-ledger');
          await insertPosting(trx, org, ledgerId, transactionId, {
            source: 'only-in-other-ledger',
          });
        }),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });
  });
});
