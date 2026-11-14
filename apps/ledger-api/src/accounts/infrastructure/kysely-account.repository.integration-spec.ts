import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import {
  createDb,
  unwrapTenantTransaction,
  withTenant,
  type LedgerDatabase,
} from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import { Uuidv7IdGenerator } from '../../ids/infrastructure/adapters/uuidv7-id-generator.adapter.js';
import { AccountBalance } from '../domain/account-balance.js';
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
