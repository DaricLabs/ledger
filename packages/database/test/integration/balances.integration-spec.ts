import { randomUUIDv7 } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../src/storage.js';
import { createRuntimeDb, inTenant } from '../support/db.js';
import { insertAccount, insertLedger } from '../support/fixtures.js';

const CHECK_VIOLATION = '23514';
const LOCK_NOT_AVAILABLE = '55P03';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('balances', () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = createRuntimeDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  interface Setup {
    org: string;
    ledgerId: string;
  }

  /** Creates a ledger with the given accounts, in its own committed transaction. */
  async function createLedgerWithAccounts(
    accounts: Record<string, { allowOverdraft: boolean }>,
  ): Promise<Setup> {
    const org = randomUUIDv7();
    const ledgerId = await inTenant(db, org, async (trx) => {
      const ledger = await insertLedger(trx, org);
      for (const [address, options] of Object.entries(accounts)) {
        await insertAccount(trx, org, ledger.id, address, options);
      }
      return ledger.id;
    });
    return { org, ledgerId };
  }

  function insertBalance(trx: Transaction<DB>, { org, ledgerId }: Setup, address: string) {
    return trx
      .insertInto('balances')
      .values({ organization_id: org, ledger_id: ledgerId, account_address: address, asset: 'USD' })
      .execute();
  }

  function setBalance(
    trx: Transaction<DB>,
    { org, ledgerId }: Setup,
    address: string,
    value: string,
  ) {
    return trx
      .updateTable('balances')
      .set({ balance: value })
      .where('organization_id', '=', org)
      .where('ledger_id', '=', ledgerId)
      .where('account_address', '=', address)
      .execute();
  }

  function readBalance(trx: Transaction<DB>, { org, ledgerId }: Setup, address: string) {
    return trx
      .selectFrom('balances')
      .selectAll()
      .where('organization_id', '=', org)
      .where('ledger_id', '=', ledgerId)
      .where('account_address', '=', address)
      .executeTakeFirstOrThrow();
  }

  it('starts at zero', async () => {
    const setup = await createLedgerWithAccounts({ 'users:1': { allowOverdraft: false } });

    const balance = await inTenant(db, setup.org, async (trx) => {
      await insertBalance(trx, setup, 'users:1');
      return readBalance(trx, setup, 'users:1');
    });

    expect(balance.balance).toBe('0');
  });

  it('copies allow_overdraft from the account when the balance is created', async () => {
    const setup = await createLedgerWithAccounts({
      world: { allowOverdraft: true },
      'users:1': { allowOverdraft: false },
    });

    const [world, user] = await inTenant(db, setup.org, async (trx) => {
      await insertBalance(trx, setup, 'world');
      await insertBalance(trx, setup, 'users:1');
      return [await readBalance(trx, setup, 'world'), await readBalance(trx, setup, 'users:1')];
    });

    expect(world.allow_overdraft).toBe(true);
    expect(user.allow_overdraft).toBe(false);
  });

  it('fails with a clear error when the account does not exist', async () => {
    const setup = await createLedgerWithAccounts({});

    await expect(
      inTenant(db, setup.org, (trx) => insertBalance(trx, setup, 'ghost')),
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('account not found'),
    });
  });

  describe('negative values', () => {
    it('are rejected when the account does not allow overdraft', async () => {
      const setup = await createLedgerWithAccounts({ 'users:1': { allowOverdraft: false } });

      await expect(
        inTenant(db, setup.org, async (trx) => {
          await insertBalance(trx, setup, 'users:1');
          await setBalance(trx, setup, 'users:1', '-1');
        }),
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'balances_nonnegative_unless_overdraft',
      });
    });

    it('are accepted when the account allows overdraft, and kept exactly', async () => {
      const setup = await createLedgerWithAccounts({ world: { allowOverdraft: true } });
      const huge = `-${(2n ** 256n - 1n).toString()}`;

      const balance = await inTenant(db, setup.org, async (trx) => {
        await insertBalance(trx, setup, 'world');
        await setBalance(trx, setup, 'world', huge);
        return readBalance(trx, setup, 'world');
      });

      expect(balance.balance).toBe(huge);
    });
  });

  describe('when allow_overdraft changes on the account', () => {
    function setOverdraft(
      trx: Transaction<DB>,
      { org, ledgerId }: Setup,
      address: string,
      value: boolean,
    ) {
      return trx
        .updateTable('accounts')
        .set({ allow_overdraft: value })
        .where('organization_id', '=', org)
        .where('ledger_id', '=', ledgerId)
        .where('address', '=', address)
        .execute();
    }

    it('copies the new value to the balances of that account (both directions)', async () => {
      const setup = await createLedgerWithAccounts({ 'users:1': { allowOverdraft: false } });
      await inTenant(db, setup.org, (trx) => insertBalance(trx, setup, 'users:1'));

      await inTenant(db, setup.org, (trx) => setOverdraft(trx, setup, 'users:1', true));
      const enabled = await inTenant(db, setup.org, (trx) => readBalance(trx, setup, 'users:1'));
      await inTenant(db, setup.org, (trx) => setOverdraft(trx, setup, 'users:1', false));
      const disabled = await inTenant(db, setup.org, (trx) => readBalance(trx, setup, 'users:1'));

      expect(enabled.allow_overdraft).toBe(true);
      expect(disabled.allow_overdraft).toBe(false);
    });

    it('refuses to turn overdraft off while the balance is negative', async () => {
      const setup = await createLedgerWithAccounts({ world: { allowOverdraft: true } });
      await inTenant(db, setup.org, async (trx) => {
        await insertBalance(trx, setup, 'world');
        await setBalance(trx, setup, 'world', '-5');
      });

      await expect(
        inTenant(db, setup.org, (trx) => setOverdraft(trx, setup, 'world', false)),
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'balances_nonnegative_unless_overdraft',
      });

      const account = await inTenant(db, setup.org, (trx) =>
        trx.selectFrom('accounts').select('allow_overdraft').executeTakeFirstOrThrow(),
      );
      expect(account.allow_overdraft).toBe(true); // the failed change was rolled back
    });

    it('does not touch the balances of other accounts', async () => {
      const setup = await createLedgerWithAccounts({
        a: { allowOverdraft: false },
        b: { allowOverdraft: false },
      });
      await inTenant(db, setup.org, async (trx) => {
        await insertBalance(trx, setup, 'a');
        await insertBalance(trx, setup, 'b');
      });

      await inTenant(db, setup.org, (trx) => setOverdraft(trx, setup, 'a', true));

      const b = await inTenant(db, setup.org, (trx) => readBalance(trx, setup, 'b'));
      expect(b.allow_overdraft).toBe(false);
    });
  });

  describe('updated_at', () => {
    it('moves forward when the balance changes, but not when only the flag is copied', async () => {
      const setup = await createLedgerWithAccounts({ 'users:1': { allowOverdraft: false } });
      await inTenant(db, setup.org, (trx) => insertBalance(trx, setup, 'users:1'));
      const created = await inTenant(db, setup.org, (trx) => readBalance(trx, setup, 'users:1'));

      await sleep(20); // now() is fixed inside a transaction, so use a later one
      await inTenant(db, setup.org, (trx) => setBalance(trx, setup, 'users:1', '10'));
      const afterChange = await inTenant(db, setup.org, (trx) =>
        readBalance(trx, setup, 'users:1'),
      );

      await sleep(20);
      await inTenant(db, setup.org, (trx) =>
        trx
          .updateTable('accounts')
          .set({ allow_overdraft: true })
          .where('organization_id', '=', setup.org)
          .execute(),
      );
      const afterFlagCopy = await inTenant(db, setup.org, (trx) =>
        readBalance(trx, setup, 'users:1'),
      );

      expect(afterChange.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime());
      expect(afterFlagCopy.allow_overdraft).toBe(true);
      expect(afterFlagCopy.updated_at).toEqual(afterChange.updated_at);
    });
  });

  describe('locks around the overdraft flag', () => {
    /** Runs `work` in a tenant transaction that stays open until `release` is called. */
    async function holdOpen(
      setup: Setup,
      work: (trx: Transaction<DB>) => Promise<unknown>,
    ): Promise<{ release: () => Promise<void> }> {
      let end!: () => void;
      const mayEnd = new Promise<void>((resolve) => {
        end = resolve;
      });
      let started!: () => void;
      const isOpen = new Promise<void>((resolve) => {
        started = resolve;
      });
      const done = inTenant(db, setup.org, async (trx) => {
        await work(trx);
        started();
        await mayEnd;
      });
      await Promise.race([isOpen, done]); // `done` ends first only if `work` failed
      return {
        release: async () => {
          end();
          await done;
        },
      };
    }

    const noWait = (trx: Transaction<DB>) => sql`set local lock_timeout = '300ms'`.execute(trx);

    function editMetadata(trx: Transaction<DB>, { org, ledgerId }: Setup, address: string) {
      return trx
        .updateTable('accounts')
        .set({ metadata: { edited: 'yes' } })
        .where('organization_id', '=', org)
        .where('ledger_id', '=', ledgerId)
        .where('address', '=', address)
        .execute();
    }

    it('lets a balance be created while the metadata of its account is being edited', async () => {
      const setup = await createLedgerWithAccounts({ 'users:1': { allowOverdraft: false } });
      const edit = await holdOpen(setup, (trx) => editMetadata(trx, setup, 'users:1'));

      try {
        const balance = await inTenant(db, setup.org, async (trx) => {
          await noWait(trx);
          await insertBalance(trx, setup, 'users:1');
          return readBalance(trx, setup, 'users:1');
        });

        expect(balance.allow_overdraft).toBe(false);
      } finally {
        await edit.release();
      }
    });

    it('makes a flag change wait for a balance insert that is still open', async () => {
      const setup = await createLedgerWithAccounts({ 'users:1': { allowOverdraft: false } });
      const insert = await holdOpen(setup, (trx) => insertBalance(trx, setup, 'users:1'));

      try {
        await expect(
          inTenant(db, setup.org, async (trx) => {
            await noWait(trx);
            await trx
              .updateTable('accounts')
              .set({ allow_overdraft: true })
              .where('organization_id', '=', setup.org)
              .execute();
          }),
        ).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
      } finally {
        await insert.release();
      }

      // Once the insert is committed, the change goes through and reaches the new row.
      await inTenant(db, setup.org, (trx) =>
        trx
          .updateTable('accounts')
          .set({ allow_overdraft: true })
          .where('organization_id', '=', setup.org)
          .execute(),
      );
      const balance = await inTenant(db, setup.org, (trx) => readBalance(trx, setup, 'users:1'));
      expect(balance.allow_overdraft).toBe(true);
    });

    it('makes a balance insert wait for a flag change that is still open, and then use the new flag', async () => {
      const setup = await createLedgerWithAccounts({ 'users:1': { allowOverdraft: false } });
      const change = await holdOpen(setup, (trx) =>
        trx
          .updateTable('accounts')
          .set({ allow_overdraft: true })
          .where('organization_id', '=', setup.org)
          .execute(),
      );

      try {
        await expect(
          inTenant(db, setup.org, async (trx) => {
            await noWait(trx);
            await insertBalance(trx, setup, 'users:1');
          }),
        ).rejects.toMatchObject({ code: LOCK_NOT_AVAILABLE });
      } finally {
        await change.release();
      }

      await inTenant(db, setup.org, (trx) => insertBalance(trx, setup, 'users:1'));
      const balance = await inTenant(db, setup.org, (trx) => readBalance(trx, setup, 'users:1'));
      expect(balance.allow_overdraft).toBe(true);
    });
  });

  it('does not let the app delete a balance', async () => {
    const setup = await createLedgerWithAccounts({ 'users:1': { allowOverdraft: false } });
    await inTenant(db, setup.org, (trx) => insertBalance(trx, setup, 'users:1'));

    await expect(
      inTenant(db, setup.org, (trx) => sql`delete from balances`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
