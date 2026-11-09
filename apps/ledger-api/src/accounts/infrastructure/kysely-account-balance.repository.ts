import { Injectable } from '@nestjs/common';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { sql, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type { IAccountBalanceRepository } from '../application/ports/account-balance-repository.port.js';
import { AccountBalance, type IBalanceKey } from '../domain/account-balance.js';

/** A row of the lock query, as `pg` returns it. */
interface IBalanceRow {
  account_address: string;
  asset: string;
  /** `numeric` comes back as text, because it can be bigger than a JavaScript number can hold. */
  balance: string;
  allow_overdraft: boolean;
}

/**
 * The queries pass the keys as parallel arrays (`unnest`). This keeps them to
 * one round trip each, however many balances a transaction touches (up to 200),
 * and keeps the order of the keys.
 *
 * Stateless: the transaction comes with every call, so this class needs
 * nothing injected.
 */
@Injectable()
export class KyselyAccountBalanceRepository implements IAccountBalanceRepository {
  async open(
    trx: TenantTransaction,
    ledgerId: string,
    balances: readonly AccountBalance[],
  ): Promise<void> {
    const k = unwrapTenantTransaction(trx);

    // The accounts first: the balance rows point to them. The balances are
    // sorted by address, so the first of each address is the one to keep.
    const accounts = new Map<string, boolean>();
    for (const balance of balances) {
      accounts.set(balance.address.value, balance.allowOverdraft);
    }
    await k
      .insertInto('accounts')
      .values(
        [...accounts].map(([address, allowOverdraft]) => ({
          // The tenant is the one set on the transaction. A row for another
          // tenant is impossible, and row-level security would refuse it anyway.
          organization_id: sql<string>`current_organization_id()`,
          ledger_id: ledgerId,
          address,
          allow_overdraft: allowOverdraft,
        })),
      )
      // An account that exists keeps its own rules. Waiting for a transaction
      // that is creating the same account is what `DO NOTHING` does here.
      .onConflict((conflict) => conflict.doNothing())
      .execute();

    // `allow_overdraft` is not set here: a trigger copies it from the account.
    await k
      .insertInto('balances')
      .values(
        balances.map((balance) => ({
          organization_id: sql<string>`current_organization_id()`,
          ledger_id: ledgerId,
          account_address: balance.address.value,
          asset: balance.asset.value,
          balance: balance.balance.amount,
        })),
      )
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }

  async lock(
    trx: TenantTransaction,
    ledgerId: string,
    keys: readonly IBalanceKey[],
  ): Promise<AccountBalance[]> {
    // `order by k.position` gives the rows in the order of `keys`, and `for
    // update` locks them in the order they are returned (the lock step runs
    // after the sort). `of b` locks only the balance rows.
    const { rows } = await sql<IBalanceRow>`
      select b.account_address, b.asset, b.balance, b.allow_overdraft
        from unnest(${keys.map((key) => key.address.value)}::text[],
                    ${keys.map((key) => key.asset.value)}::text[])
             with ordinality as k(address, asset, position)
        join balances b
          on b.organization_id = current_organization_id()
         and b.ledger_id = ${ledgerId}::uuid
         and b.account_address = k.address
         and b.asset = k.asset
       order by k.position
         for update of b
    `.execute(unwrapTenantTransaction(trx));

    if (rows.length !== keys.length) {
      throw new Error(`Expected to lock ${keys.length} balances, but found ${rows.length}`);
    }
    return rows.map(toAccountBalance);
  }

  async save(
    trx: TenantTransaction,
    ledgerId: string,
    balances: readonly AccountBalance[],
  ): Promise<void> {
    // Only `balance` is written: the overdraft rule belongs to the account.
    const result = await sql`
      update balances b
         set balance = v.balance
        from unnest(${balances.map((balance) => balance.address.value)}::text[],
                    ${balances.map((balance) => balance.asset.value)}::text[],
                    ${balances.map((balance) => balance.balance.amount.toString())}::numeric[])
             as v(address, asset, balance)
       where b.organization_id = current_organization_id()
         and b.ledger_id = ${ledgerId}::uuid
         and b.account_address = v.address
         and b.asset = v.asset
    `.execute(unwrapTenantTransaction(trx));

    // Row-level security hides the rows of other organizations, so an update
    // for one of them would change 0 rows without an error. Do not let that
    // pass quietly.
    if (result.numAffectedRows !== BigInt(balances.length)) {
      throw new Error(
        `Expected to update ${balances.length} balance rows, but updated ${result.numAffectedRows}`,
      );
    }
  }
}

function toAccountBalance(row: IBalanceRow): AccountBalance {
  return AccountBalance.reconstitute({
    address: AccountAddress.of(row.account_address),
    balance: Money.of(AssetCode.of(row.asset), BigInt(row.balance)),
    allowOverdraft: row.allow_overdraft,
  });
}
