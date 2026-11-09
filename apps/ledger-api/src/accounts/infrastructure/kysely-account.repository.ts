import { Injectable } from '@nestjs/common';
import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { sql, unwrapTenantTransaction } from '@ledger/database/storage';
import type { TenantTransaction } from '@ledger/database';
import type {
  IAccountPage,
  IAccountPageQuery,
  IAccountRepository,
} from '../application/ports/account-repository.port.js';
import { Account } from '../domain/account.entity.js';

/** A row of the account queries, as `pg` returns it. */
interface IAccountRow {
  address: string;
  allow_overdraft: boolean;
  created_at: Date;
  /** Already a JavaScript array: `pg` reads a `json` column with `JSON.parse`. */
  balances: IBalanceJson[];
}

/**
 * One balance inside the `balances` column of a row. The amount is text,
 * because a `numeric` that goes through JSON would become a JavaScript number,
 * and money must never lose a digit.
 */
interface IBalanceJson {
  asset: string;
  amount: string;
}

/**
 * The columns of an account, with its balances as one JSON array, so an
 * account and its balances always come from the same moment, and a page of
 * accounts needs one query. Callers add `where`, `order by` and `limit`.
 *
 * The balances are in the order of the asset codes, compared by character code
 * (`collate "C"`), so the order does not depend on the database settings.
 * `organization_id` is in the conditions on purpose: it is the start of every
 * primary key, and row-level security would add it anyway.
 */
const SELECT_ACCOUNT = sql`
  select a.address,
         a.allow_overdraft,
         a.created_at,
         coalesce(
           (select json_agg(
                     json_build_object('asset', b.asset, 'amount', b.balance::text)
                     order by b.asset collate "C"
                   )
              from balances b
             where b.organization_id = a.organization_id
               and b.ledger_id = a.ledger_id
               and b.account_address = a.address),
           '[]'::json
         ) as balances
    from accounts a
`;

/**
 * Stateless: the transaction comes with every call, so this class needs
 * nothing injected.
 */
@Injectable()
export class KyselyAccountRepository implements IAccountRepository {
  async findByAddress(
    trx: TenantTransaction,
    ledgerId: string,
    address: AccountAddress,
  ): Promise<Account | null> {
    const { rows } = await sql<IAccountRow>`
      ${SELECT_ACCOUNT}
       where a.organization_id = current_organization_id()
         and a.ledger_id = ${ledgerId}::uuid
         and a.address = ${address.value}
    `.execute(unwrapTenantTransaction(trx));

    return rows[0] === undefined ? null : toAccount(rows[0]);
  }

  async findPage(
    trx: TenantTransaction,
    ledgerId: string,
    query: IAccountPageQuery,
  ): Promise<IAccountPage> {
    // The order is the one of the primary key, and the address is unique in a
    // ledger, so two accounts never swap places between two calls. An empty
    // `sql` fragment adds nothing when there is no position to start after.
    // Ask for one row more than the page. If it comes back, there is a next
    // page, and we know it without a second query or a count.
    const { rows } = await sql<IAccountRow>`
      ${SELECT_ACCOUNT}
       where a.organization_id = current_organization_id()
         and a.ledger_id = ${ledgerId}::uuid
         ${query.afterAddress === undefined ? sql`` : sql`and a.address > ${query.afterAddress}`}
       order by a.address
       limit ${query.limit + 1}
    `.execute(unwrapTenantTransaction(trx));

    return {
      accounts: rows.slice(0, query.limit).map(toAccount),
      hasMore: rows.length > query.limit,
    };
  }
}

function toAccount(row: IAccountRow): Account {
  return Account.reconstitute({
    address: AccountAddress.of(row.address),
    allowOverdraft: row.allow_overdraft,
    createdAt: row.created_at,
    balances: row.balances.map((balance) =>
      Money.of(AssetCode.of(balance.asset), BigInt(balance.amount)),
    ),
  });
}
