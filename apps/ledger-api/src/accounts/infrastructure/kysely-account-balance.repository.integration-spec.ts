import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import {
  createDb,
  SqlState,
  unwrapTenantTransaction,
  withTenant,
  type LedgerDatabase,
} from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import { Uuidv7IdGenerator } from '../../ids/infrastructure/adapters/uuidv7-id-generator.adapter.js';
import { AccountBalance } from '../domain/account-balance.js';
import { KyselyAccountBalanceRepository } from './kysely-account-balance.repository.js';

// The repository has no constructor arguments, so these tests do not need Nest.
// Every test uses a new organization id, so tests never see each other's rows.
// The ledger is added with plain SQL on purpose: this feature does not own it.
const ids = new Uuidv7IdGenerator();
const repository = new KyselyAccountBalanceRepository();
let db: LedgerDatabase;

beforeAll(() => {
  // The runtime role, like the app. Row-level security applies to it.
  db = createDb(process.env.LEDGER_RUNTIME_DATABASE_URL!, {
    onPoolError: (error) => console.error(error),
  });
});

afterAll(() => db.destroy());

const address = (value: string) => AccountAddress.of(value);
const usd = AssetCode.of('USD');
const eur = AssetCode.of('EUR');

async function insertLedger(trx: TenantTransaction, organizationId: string): Promise<string> {
  const id = ids.next();
  await unwrapTenantTransaction(trx)
    .insertInto('ledgers')
    .values({ id, organization_id: organizationId, name: 'main' })
    .execute();
  return id;
}

/** A balance of an account, with an amount, as storage would give it back. */
const balanceOf = (account: string, asset: AssetCode, amount: bigint, allowOverdraft = false) =>
  AccountBalance.reconstitute({
    address: address(account),
    balance: Money.of(asset, amount),
    allowOverdraft,
  });

describe('KyselyAccountBalanceRepository.open', () => {
  it('creates the accounts and zero balances, and world may go below zero', async () => {
    const organizationId = ids.next();

    const { accounts, balances } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await repository.open(trx, ledgerId, [
        AccountBalance.open(address('users:1'), usd),
        AccountBalance.open(address('users:1'), eur),
        AccountBalance.open(address('world'), usd),
      ]);
      const k = unwrapTenantTransaction(trx);
      return {
        accounts: await k
          .selectFrom('accounts')
          .select(['address', 'allow_overdraft'])
          .orderBy('address')
          .execute(),
        balances: await k
          .selectFrom('balances')
          .select(['account_address', 'asset', 'balance', 'allow_overdraft'])
          .orderBy('account_address')
          .orderBy('asset')
          .execute(),
      };
    });

    expect(accounts).toEqual([
      { address: 'users:1', allow_overdraft: false },
      { address: 'world', allow_overdraft: true },
    ]);
    expect(balances).toEqual([
      { account_address: 'users:1', asset: 'EUR', balance: '0', allow_overdraft: false },
      { account_address: 'users:1', asset: 'USD', balance: '0', allow_overdraft: false },
      { account_address: 'world', asset: 'USD', balance: '0', allow_overdraft: true }, // copied by the trigger
    ]);
  });

  it('leaves what already exists as it is, and can run twice', async () => {
    const organizationId = ids.next();

    const rows = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      const key = [AccountBalance.open(address('users:1'), usd)];
      await repository.open(trx, ledgerId, key);
      await repository.save(trx, ledgerId, [balanceOf('users:1', usd, 500n)]);
      await repository.open(trx, ledgerId, key);
      return unwrapTenantTransaction(trx).selectFrom('balances').select('balance').execute();
    });

    expect(rows).toEqual([{ balance: '500' }]); // not reset to 0
  });
});

describe('KyselyAccountBalanceRepository.lock and save', () => {
  it('loads the balances in the order of the keys, and save changes the amounts', async () => {
    const organizationId = ids.next();

    const { before, after } = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      const opened = [
        AccountBalance.open(address('a'), usd),
        AccountBalance.open(address('b'), usd),
        AccountBalance.open(address('world'), usd),
      ];
      await repository.open(trx, ledgerId, opened);
      const keys = opened.map((balance) => balance.key);

      const loaded = await repository.lock(trx, ledgerId, keys);
      await repository.save(trx, ledgerId, [
        balanceOf('a', usd, 70n),
        balanceOf('b', usd, 130n),
        balanceOf('world', usd, -200n, true),
      ]);
      return { before: loaded, after: await repository.lock(trx, ledgerId, keys) };
    });

    expect(before.map((b) => [b.address.value, b.balance.amount, b.allowOverdraft])).toEqual([
      ['a', 0n, false],
      ['b', 0n, false],
      ['world', 0n, true],
    ]);
    expect(after.map((b) => b.balance.amount)).toEqual([70n, 130n, -200n]);
  });

  it('holds amounts above the size of a JavaScript number without losing a digit', async () => {
    const organizationId = ids.next();
    const big = 10n ** 78n - 1n;

    const loaded = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      const opened = AccountBalance.open(address('world'), usd);
      await repository.open(trx, ledgerId, [opened]);
      await repository.save(trx, ledgerId, [balanceOf('world', usd, -big, true)]);
      return repository.lock(trx, ledgerId, [opened.key]);
    });

    expect(loaded[0]?.balance.amount).toBe(-big);
  });

  it('throws when a balance does not exist', async () => {
    const organizationId = ids.next();

    await expect(
      withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await repository.lock(trx, ledgerId, [AccountBalance.open(address('a'), usd).key]);
      }),
    ).rejects.toThrow('Expected to lock 1 balances, but found 0');
  });

  it('throws when save finds no row to update', async () => {
    const organizationId = ids.next();

    await expect(
      withTenant(db, organizationId, async (trx) => {
        const ledgerId = await insertLedger(trx, organizationId);
        await repository.save(trx, ledgerId, [balanceOf('a', usd, 1n)]);
      }),
    ).rejects.toThrow('Expected to update 1 balance rows, but updated 0');
  });

  it('is stopped by the database when a balance would go below zero without overdraft', async () => {
    const organizationId = ids.next();

    const error = await withTenant(db, organizationId, async (trx) => {
      const ledgerId = await insertLedger(trx, organizationId);
      await repository.open(trx, ledgerId, [AccountBalance.open(address('a'), usd)]);
      await repository.save(trx, ledgerId, [balanceOf('a', usd, -1n)]);
    }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: SqlState.CheckViolation });
  });

  it('does not see the balances of another organization', async () => {
    const organizationId = ids.next();
    const otherId = ids.next();
    const key = AccountBalance.open(address('a'), usd).key;
    const ledgerId = await withTenant(db, organizationId, async (trx) => {
      const id = await insertLedger(trx, organizationId);
      await repository.open(trx, id, [AccountBalance.open(address('a'), usd)]);
      return id;
    });

    await expect(
      withTenant(db, otherId, (trx) => repository.lock(trx, ledgerId, [key])),
    ).rejects.toThrow('Expected to lock 1 balances, but found 0');
  });
});
