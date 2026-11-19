import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import {
  createDb,
  sql,
  SqlState,
  unwrapTenantTransaction,
  withTenant,
  type LedgerDatabase,
} from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import { Uuidv7IdGenerator } from '../../../ids/infrastructure/adapters/uuidv7-id-generator.adapter.js';
import { AccountBalance } from '../../domain/entities/account-balance.entity.js';
import { KyselyAccountBalanceRepository } from './kysely-account-balance.repository.js';
import { KyselyAccountRepository } from './kysely-account.repository.js';

// The repositories have no constructor arguments, so these tests do not need Nest.
// Every test uses a new organization id, so tests never see each other's rows.
// The ledger is added with plain SQL on purpose: this feature does not own it.
// Accounts are made with the balance repository, the way transactions make them.
const ids = new Uuidv7IdGenerator();
const balances = new KyselyAccountBalanceRepository();
const repository = new KyselyAccountRepository();
let db: LedgerDatabase;

beforeAll(() => {
  // The runtime role, like the app. Row-level security applies to it.
  db = createDb(process.env.LEDGER_RUNTIME_DATABASE_URL!, {
    onPoolError: (error) => console.error(error),
  });
});

afterAll(() => db.destroy());

const address = (value: string) => AccountAddress.of(value);
const asset = (value: string) => AssetCode.of(value);

/** Sets the metadata of an account with plain SQL, as the setup of a test. */
async function setMetadata(
  trx: TenantTransaction,
  ledgerId: string,
  account: string,
  metadata: Record<string, string>,
): Promise<void> {
  await unwrapTenantTransaction(trx)
    .updateTable('accounts')
    .set({ metadata })
    .where('ledger_id', '=', ledgerId)
    .where('address', '=', account)
    .execute();
}

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

/** Makes an account with these balances, like a transaction would. */
async function putBalances(
  trx: TenantTransaction,
  ledgerId: string,
  account: string,
  amounts: Record<string, bigint>,
): Promise<void> {
  const opened = Object.keys(amounts).map((code) =>
    AccountBalance.open(address(account), asset(code)),
  );
  await balances.open(trx, ledgerId, opened);
  await balances.save(
    trx,
    ledgerId,
    Object.entries(amounts).map(([code, amount]) =>
      AccountBalance.reconstitute({
        address: address(account),
        balance: Money.of(asset(code), amount),
        allowOverdraft: address(account).isWorld(),
      }),
    ),
  );
}

describe('KyselyAccountRepository.findByAddress', () => {
  it('finds an account with its rules, its date and its balances', async () => {
    const organizationId = ids.next();

    const account = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putBalances(trx, ledgerId, 'users:1', { USD: 1050n, EUR: 5n });
      return repository.findByAddress(trx, ledgerId, address('users:1'));
    });

    expect(account?.address.value).toBe('users:1');
    expect(account?.allowOverdraft).toBe(false);
    expect(account?.createdAt).toBeInstanceOf(Date);
    expect(account?.balances.map((money) => [money.asset.value, money.amount])).toEqual([
      ['EUR', 5n],
      ['USD', 1050n],
    ]);
  });

  it('returns null for an address that has no account', async () => {
    const organizationId = ids.next();

    const account = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      return repository.findByAddress(trx, ledgerId, address('users:1'));
    });

    expect(account).toBeNull();
  });

  it('matches the whole address, not a part of it', async () => {
    const organizationId = ids.next();

    const found = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putBalances(trx, ledgerId, 'users:1:main', { USD: 1n });
      return [
        await repository.findByAddress(trx, ledgerId, address('users')),
        await repository.findByAddress(trx, ledgerId, address('users:1')),
      ];
    });

    expect(found).toEqual([null, null]);
  });

  it('gives the balances in the order of the asset codes, by character code', async () => {
    const organizationId = ids.next();

    const account = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      // `USD` is before `USDT` in any order, and `EUR2` is before `EURO`
      // only when digits come before letters, as in character code order.
      await putBalances(trx, ledgerId, 'users:1', {
        USDT: 1n,
        EURO: 2n,
        USD: 3n,
        EUR2: 4n,
        BTC: 5n,
      });
      return repository.findByAddress(trx, ledgerId, address('users:1'));
    });

    expect(account?.balances.map((money) => money.asset.value)).toEqual([
      'BTC',
      'EUR2',
      'EURO',
      'USD',
      'USDT',
    ]);
  });

  it('keeps every digit of a very big balance, and the sign of a negative one', async () => {
    const organizationId = ids.next();
    const big = 10n ** 77n + 1n;

    const { user, world } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putBalances(trx, ledgerId, 'users:1', { USD: big });
      await putBalances(trx, ledgerId, 'world', { USD: -big });
      return {
        user: await repository.findByAddress(trx, ledgerId, address('users:1')),
        world: await repository.findByAddress(trx, ledgerId, address('world')),
      };
    });

    expect(user?.balances[0]?.amount).toBe(big);
    expect(world?.allowOverdraft).toBe(true);
    expect(world?.balances[0]?.amount).toBe(-big);
  });

  it('gives an account that has no balance an empty list', async () => {
    const organizationId = ids.next();

    const account = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await unwrapTenantTransaction(trx)
        .insertInto('accounts')
        .values({
          organization_id: organizationId,
          ledger_id: ledgerId,
          address: 'users:1',
        })
        .execute();
      return repository.findByAddress(trx, ledgerId, address('users:1'));
    });

    expect(account?.balances).toEqual([]);
  });

  it('only finds accounts of the ledger it is asked about', async () => {
    const organizationId = ids.next();

    const { inFirst, inSecond } = await withTenant(db, organizationId, async (trx) => {
      const first = await insertLedger(trx, organizationId, 'first');
      const second = await insertLedger(trx, organizationId, 'second');
      await putBalances(trx, first, 'users:1', { USD: 100n });
      await putBalances(trx, second, 'users:1', { USD: 7n });
      return {
        inFirst: await repository.findByAddress(trx, first, address('users:1')),
        inSecond: await repository.findByAddress(trx, second, address('users:1')),
      };
    });

    expect(inFirst?.balances[0]?.amount).toBe(100n);
    expect(inSecond?.balances[0]?.amount).toBe(7n);
  });

  it('does not find the account of another organization', async () => {
    const organizationId = ids.next();
    const otherOrganizationId = ids.next();
    const ledgerId = await withTenant(db, organizationId, async (trx) => {
      const id = await insertLedger(trx, organizationId);
      await putBalances(trx, id, 'users:1', { USD: 100n });
      return id;
    });

    // Even with the right ledger id, row-level security hides the rows.
    const account = await withTenant(db, otherOrganizationId, (trx) =>
      repository.findByAddress(trx, ledgerId, address('users:1')),
    );

    expect(account).toBeNull();
  });
});

describe('KyselyAccountRepository metadata', () => {
  it('gives an account with no metadata an empty one', async () => {
    const organizationId = ids.next();

    const account = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putBalances(trx, ledgerId, 'users:1', { USD: 1n });
      return repository.findByAddress(trx, ledgerId, address('users:1'));
    });

    expect(account?.metadata.entries).toEqual({});
  });

  it('reads the metadata in findByAddress and findPage', async () => {
    const organizationId = ids.next();

    const { found, page } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putBalances(trx, ledgerId, 'users:1', { USD: 1n });
      await setMetadata(trx, ledgerId, 'users:1', { customerId: 'c_42', tier: 'gold' });
      return {
        found: await repository.findByAddress(trx, ledgerId, address('users:1')),
        page: await repository.findPage(trx, ledgerId, { limit: 10 }),
      };
    });

    expect(found?.metadata.entries).toEqual({ customerId: 'c_42', tier: 'gold' });
    expect(page.accounts[0]?.metadata.entries).toEqual({ customerId: 'c_42', tier: 'gold' });
  });

  describe('lockByAddress', () => {
    it('finds an account like findByAddress does, with its balances and metadata', async () => {
      const organizationId = ids.next();

      const { locked, found } = await withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await putBalances(trx, ledgerId, 'users:1', { USD: 1050n, EUR: 5n });
        await setMetadata(trx, ledgerId, 'users:1', { customerId: 'c_42' });
        return {
          locked: await repository.lockByAddress(trx, ledgerId, address('users:1')),
          found: await repository.findByAddress(trx, ledgerId, address('users:1')),
        };
      });

      expect(locked?.address.value).toBe('users:1');
      expect(locked?.metadata.entries).toEqual({ customerId: 'c_42' });
      expect(locked?.balances.map((m) => [m.asset.value, m.amount])).toEqual([
        ['EUR', 5n],
        ['USD', 1050n],
      ]);
      expect(locked?.createdAt).toEqual(found?.createdAt);
    });

    it('returns null for an address that has no account, and matches the whole address', async () => {
      const organizationId = ids.next();

      const { missing, part } = await withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await putBalances(trx, ledgerId, 'users:12', { USD: 1n });
        return {
          missing: await repository.lockByAddress(trx, ledgerId, address('users:9')),
          part: await repository.lockByAddress(trx, ledgerId, address('users:1')),
        };
      });

      expect(missing).toBeNull();
      expect(part).toBeNull();
    });

    it('only finds accounts of the ledger it is asked about', async () => {
      const organizationId = ids.next();

      const { inFirst, inSecond } = await withTenant(db, organizationId, async (trx) => {
        const first = await insertLedger(trx, organizationId, 'first');
        const second = await insertLedger(trx, organizationId, 'second');
        await putBalances(trx, first, 'users:1', { USD: 100n });
        return {
          inFirst: await repository.lockByAddress(trx, first, address('users:1')),
          inSecond: await repository.lockByAddress(trx, second, address('users:1')),
        };
      });

      expect(inFirst).not.toBeNull();
      expect(inSecond).toBeNull();
    });

    it('does not find the account of another organization', async () => {
      const organizationId = ids.next();
      const otherOrganizationId = ids.next();
      const ledgerId = await withTenant(db, organizationId, async (trx) => {
        const id = await insertLedger(trx, organizationId);
        await putBalances(trx, id, 'users:1', { USD: 100n });
        return id;
      });

      const account = await withTenant(db, otherOrganizationId, (trx) =>
        repository.lockByAddress(trx, ledgerId, address('users:1')),
      );

      expect(account).toBeNull();
    });

    describe('the lock', () => {
      /**
       * Locks the account in a transaction that stays open until `release` is
       * called. Resolves when the lock is taken.
       */
      async function holdLock(organizationId: string, ledgerId: string) {
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let taken!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
          taken = resolve;
        });

        const done = withTenant(db, organizationId, async (trx) => {
          await repository.lockByAddress(trx, ledgerId, address('users:1'));
          taken();
          await released;
        });
        await Promise.race([lockTaken, done]); // `done` ends first only if locking failed
        return { release, done };
      }

      const prepare = async () => {
        const organizationId = ids.next();
        const ledgerId = await withTenant(db, organizationId, async (trx) => {
          const id = await insertLedger(trx, organizationId);
          await putBalances(trx, id, 'users:1', { USD: 100n });
          return id;
        });
        return { organizationId, ledgerId };
      };

      it('makes a second locking read wait until the first transaction ends', async () => {
        const { organizationId, ledgerId } = await prepare();
        const first = await holdLock(organizationId, ledgerId);

        // A short lock timeout turns "waits forever" into an error we can check.
        const second = withTenant(db, organizationId, async (trx) => {
          await sql`set local lock_timeout = '300ms'`.execute(unwrapTenantTransaction(trx));
          await repository.lockByAddress(trx, ledgerId, address('users:1'));
        });

        await expect(second).rejects.toMatchObject({ code: SqlState.LockNotAvailable });
        first.release();
        await first.done;
      });

      it('lets the next locking read go on after the first transaction ends', async () => {
        const { organizationId, ledgerId } = await prepare();
        const first = await holdLock(organizationId, ledgerId);
        first.release();
        await first.done;

        const found = await withTenant(db, organizationId, (trx) =>
          repository.lockByAddress(trx, ledgerId, address('users:1')),
        );

        expect(found?.address.value).toBe('users:1');
      });

      it('does not block a plain read of the same account', async () => {
        const { organizationId, ledgerId } = await prepare();
        const first = await holdLock(organizationId, ledgerId);

        const found = await withTenant(db, organizationId, async (trx) => {
          await sql`set local lock_timeout = '300ms'`.execute(unwrapTenantTransaction(trx));
          return repository.findByAddress(trx, ledgerId, address('users:1'));
        });

        expect(found?.address.value).toBe('users:1');
        first.release();
        await first.done;
      });

      it('does not block the balance rows, so money can still move through a locked account', async () => {
        const { organizationId, ledgerId } = await prepare();
        const first = await holdLock(organizationId, ledgerId);

        const moved = await withTenant(db, organizationId, async (trx) => {
          await sql`set local lock_timeout = '300ms'`.execute(unwrapTenantTransaction(trx));
          const [balance] = await balances.lock(trx, ledgerId, [
            { address: address('users:1'), asset: asset('USD') },
          ]);
          await balances.save(trx, ledgerId, [balance!]);
          return balance;
        });

        expect(moved?.balance.amount).toBe(100n);
        first.release();
        await first.done;
      });
    });
  });

  describe('updateMetadata', () => {
    it('saves the metadata of the account, and findByAddress reads it back', async () => {
      const organizationId = ids.next();

      const { saved, found } = await withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await putBalances(trx, ledgerId, 'users:1', { USD: 100n });
        const account = await repository.lockByAddress(trx, ledgerId, address('users:1'));
        const updated = account!.withMetadata({ customerId: 'c_42', tier: 'gold' });
        await repository.updateMetadata(trx, ledgerId, updated);
        return {
          saved: updated,
          found: await repository.findByAddress(trx, ledgerId, address('users:1')),
        };
      });

      expect(found?.metadata.entries).toEqual({ customerId: 'c_42', tier: 'gold' });
      expect(found?.metadata.entries).toEqual(saved.metadata.entries);
    });

    it('replaces the stored metadata with the one of the account, so a removed key is gone', async () => {
      const organizationId = ids.next();

      const found = await withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await putBalances(trx, ledgerId, 'users:1', { USD: 100n });
        await setMetadata(trx, ledgerId, 'users:1', { a: '1', b: '2' });
        const account = await repository.lockByAddress(trx, ledgerId, address('users:1'));
        await repository.updateMetadata(trx, ledgerId, account!.withoutMetadataKey('a'));
        return repository.findByAddress(trx, ledgerId, address('users:1'));
      });

      expect(found?.metadata.entries).toEqual({ b: '2' });
    });

    it('keeps values that look like SQL or JSON as plain text', async () => {
      const organizationId = ids.next();
      const tricky = { quote: `it's "x"`, json: '{"a":1}', unicode: 'é✓', empty: '' };

      const found = await withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await putBalances(trx, ledgerId, 'users:1', { USD: 100n });
        const account = await repository.lockByAddress(trx, ledgerId, address('users:1'));
        await repository.updateMetadata(trx, ledgerId, account!.withMetadata(tricky));
        return repository.findByAddress(trx, ledgerId, address('users:1'));
      });

      expect(found?.metadata.entries).toEqual(tricky);
    });

    it('changes nothing else: not the balances, the overdraft rule or the date', async () => {
      const organizationId = ids.next();

      const { before, after } = await withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await putBalances(trx, ledgerId, 'world', { USD: -100n });
        await putBalances(trx, ledgerId, 'users:1', { USD: 100n });
        const account = await repository.lockByAddress(trx, ledgerId, address('world'));
        await repository.updateMetadata(trx, ledgerId, account!.withMetadata({ a: '1' }));
        return {
          before: account,
          after: await repository.findByAddress(trx, ledgerId, address('world')),
        };
      });

      expect(after?.allowOverdraft).toBe(true);
      expect(after?.createdAt).toEqual(before?.createdAt);
      expect(after?.balances.map((m) => m.amount)).toEqual([-100n]);
    });

    it('changes only the account it is given', async () => {
      const organizationId = ids.next();

      const other = await withTenant(db, organizationId, async (trx) => {
        const first = await insertLedger(trx, organizationId, 'first');
        const second = await insertLedger(trx, organizationId, 'second');
        await putBalances(trx, first, 'users:1', { USD: 1n });
        await putBalances(trx, first, 'users:2', { USD: 1n });
        await putBalances(trx, second, 'users:1', { USD: 1n });
        const account = await repository.lockByAddress(trx, first, address('users:1'));
        await repository.updateMetadata(trx, first, account!.withMetadata({ a: '1' }));
        return {
          sameLedger: await repository.findByAddress(trx, first, address('users:2')),
          otherLedger: await repository.findByAddress(trx, second, address('users:1')),
        };
      });

      expect(other.sameLedger?.metadata.entries).toEqual({});
      expect(other.otherLedger?.metadata.entries).toEqual({});
    });

    it('throws when the account is not there, instead of passing quietly', async () => {
      const organizationId = ids.next();

      const update = withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await putBalances(trx, ledgerId, 'users:1', { USD: 1n });
        const account = await repository.lockByAddress(trx, ledgerId, address('users:1'));
        // Another ledger id: there is no such account row.
        await repository.updateMetadata(trx, ids.next(), account!.withMetadata({ a: '1' }));
      });

      await expect(update).rejects.toThrow('Expected to update 1 account row, but updated 0');
    });

    it('throws for the account of another organization (row-level security hides the row)', async () => {
      const organizationId = ids.next();
      const otherOrganizationId = ids.next();
      const { ledgerId, account } = await withTenant(db, organizationId, async (trx) => {
        const id = await insertLedger(trx, organizationId);
        await putBalances(trx, id, 'users:1', { USD: 1n });
        return {
          ledgerId: id,
          account: await repository.findByAddress(trx, id, address('users:1')),
        };
      });

      const update = withTenant(db, otherOrganizationId, (trx) =>
        repository.updateMetadata(trx, ledgerId, account!.withMetadata({ a: '1' })),
      );

      await expect(update).rejects.toThrow('Expected to update 1 account row, but updated 0');
      const unchanged = await withTenant(db, organizationId, (trx) =>
        repository.findByAddress(trx, ledgerId, address('users:1')),
      );
      expect(unchanged?.metadata.entries).toEqual({});
    });
  });
});

describe('KyselyAccountRepository.findPage', () => {
  /** Makes accounts with one balance each, so a page has something to show. */
  async function putAccounts(trx: TenantTransaction, ledgerId: string, addresses: string[]) {
    for (const account of addresses) {
      await putBalances(trx, ledgerId, account, { USD: 1n });
    }
  }

  const addressesOf = (page: { accounts: { address: AccountAddress }[] }) =>
    page.accounts.map((account) => account.address.value);

  it('returns the first page sorted by address, with the balances of each account', async () => {
    const organizationId = ids.next();

    const page = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putAccounts(trx, ledgerId, ['users:2', 'users:1', 'world']);
      await putBalances(trx, ledgerId, 'users:1', { USD: 1050n, EUR: 5n });
      return repository.findPage(trx, ledgerId, { limit: 10 });
    });

    expect(addressesOf(page)).toEqual(['users:1', 'users:2', 'world']);
    expect(page.hasMore).toBe(false);
    expect(page.accounts[0]?.balances.map((m) => [m.asset.value, m.amount])).toEqual([
      ['EUR', 5n],
      ['USD', 1050n],
    ]);
    expect(page.accounts[2]?.allowOverdraft).toBe(true);
  });

  it('cuts the page at the limit and tells there is a next page', async () => {
    const organizationId = ids.next();

    const page = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putAccounts(trx, ledgerId, ['a', 'b', 'c']);
      return repository.findPage(trx, ledgerId, { limit: 2 });
    });

    expect(addressesOf(page)).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(true);
  });

  it('has no next page when the last page is exactly full', async () => {
    const organizationId = ids.next();

    const page = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putAccounts(trx, ledgerId, ['a', 'b']);
      return repository.findPage(trx, ledgerId, { limit: 2 });
    });

    expect(addressesOf(page)).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(false);
  });

  it('reads every account once when it is followed page by page', async () => {
    const organizationId = ids.next();
    const all = ['a', 'a:b', 'a:b:c', 'a-b', 'b', 'users:1', 'users:10', 'users:2', 'world'];

    const seen = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putAccounts(trx, ledgerId, all);
      const collected: string[] = [];
      let afterAddress: string | undefined;
      for (;;) {
        const page = await repository.findPage(trx, ledgerId, { limit: 2, afterAddress });
        collected.push(...addressesOf(page));
        if (!page.hasMore) return collected;
        afterAddress = collected.at(-1);
      }
    });

    // Every address once, and no address in two places. The order is the one
    // of the database, so it is compared as a set.
    expect([...seen].sort()).toEqual([...all].sort());
    expect(new Set(seen).size).toBe(all.length);
  });

  it('starts after an address that has no account', async () => {
    const organizationId = ids.next();

    const page = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putAccounts(trx, ledgerId, ['a', 'c']);
      return repository.findPage(trx, ledgerId, { limit: 10, afterAddress: 'b' });
    });

    expect(addressesOf(page)).toEqual(['c']);
  });

  it('gives an empty page after the last address, and for a ledger with no accounts', async () => {
    const organizationId = ids.next();

    const { afterLast, empty } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId, 'full');
      const emptyLedgerId = await insertLedger(trx, organizationId, 'empty');
      await putAccounts(trx, ledgerId, ['a']);
      return {
        afterLast: await repository.findPage(trx, ledgerId, { limit: 10, afterAddress: 'a' }),
        empty: await repository.findPage(trx, emptyLedgerId, { limit: 10 }),
      };
    });

    expect(afterLast).toEqual({ accounts: [], hasMore: false });
    expect(empty).toEqual({ accounts: [], hasMore: false });
  });

  it('keeps the pages after a position steady when accounts are added in between', async () => {
    const organizationId = ids.next();

    const { second, secondAfterInsert } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await putAccounts(trx, ledgerId, ['b', 'd', 'f']);
      const first = await repository.findPage(trx, ledgerId, { limit: 1 });
      const afterAddress = first.accounts.at(-1)?.address.value;
      const before = await repository.findPage(trx, ledgerId, { limit: 10, afterAddress });
      // An account that sorts before the position, and one that sorts after it.
      await putAccounts(trx, ledgerId, ['a', 'e']);
      const after = await repository.findPage(trx, ledgerId, { limit: 10, afterAddress });
      return { second: before, secondAfterInsert: after };
    });

    expect(addressesOf(second)).toEqual(['d', 'f']);
    // `a` is before the position and never shows up. `e` shows up where it belongs.
    expect(addressesOf(secondAfterInsert)).toEqual(['d', 'e', 'f']);
  });

  it('only lists the accounts of the ledger it is asked about', async () => {
    const organizationId = ids.next();

    const { first, second } = await withTenant(db, organizationId, async (trx) => {
      const firstId = await insertLedger(trx, organizationId, 'first');
      const secondId = await insertLedger(trx, organizationId, 'second');
      await putAccounts(trx, firstId, ['a']);
      await putAccounts(trx, secondId, ['b']);
      return {
        first: await repository.findPage(trx, firstId, { limit: 10 }),
        second: await repository.findPage(trx, secondId, { limit: 10 }),
      };
    });

    expect(addressesOf(first)).toEqual(['a']);
    expect(addressesOf(second)).toEqual(['b']);
  });

  it('does not list the accounts of another organization', async () => {
    const organizationId = ids.next();
    const otherOrganizationId = ids.next();
    const ledgerId = await withTenant(db, organizationId, async (trx) => {
      const id = await insertLedger(trx, organizationId);
      await putAccounts(trx, id, ['a']);
      return id;
    });

    // Even with the right ledger id, row-level security hides the rows.
    const page = await withTenant(db, otherOrganizationId, (trx) =>
      repository.findPage(trx, ledgerId, { limit: 10 }),
    );

    expect(page).toEqual({ accounts: [], hasMore: false });
  });
});
