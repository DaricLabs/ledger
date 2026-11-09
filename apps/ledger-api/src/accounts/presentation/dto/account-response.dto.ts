import type { Money } from '@ledger/domain';
import type { IAccountPage } from '../../application/ports/account-repository.port.js';
import type { Account } from '../../domain/account.entity.js';
import { encodeAccountCursor } from './account-page-cursor.dto.js';

/** What an account holds in one asset. Field names are part of the public API. */
export interface BalanceResponseDto {
  asset: string;
  /**
   * A string of digits in the smallest unit of the asset, like `"1050"`, with
   * a leading `-` when it is below zero (only an account that may go below
   * zero, like `world`, can be).
   */
  amount: string;
}

/**
 * An account as clients see it. Field names are part of the public API.
 * `organizationId` and `ledgerId` are not included: the caller already knows
 * them from the header and the URL.
 */
export interface AccountResponseDto {
  address: string;
  /** `true` when the account may go below zero. */
  allowOverdraft: boolean;
  /** One entry for each asset the account has held, in the order of the asset codes. */
  balances: BalanceResponseDto[];
  /** When the ledger first saw the account. ISO 8601 date in UTC, like `2026-11-09T10:00:00.000Z`. */
  createdAt: string;
}

function toBalanceResponseDto(balance: Money): BalanceResponseDto {
  return { asset: balance.asset.value, amount: balance.amount.toString() };
}

export function toAccountResponseDto(account: Account): AccountResponseDto {
  return {
    address: account.address.value,
    allowOverdraft: account.allowOverdraft,
    balances: account.balances.map(toBalanceResponseDto),
    createdAt: account.createdAt.toISOString(),
  };
}

/** One page of `GET /ledgers/:ledgerName/accounts`. Field names are part of the public API. */
export interface AccountPageResponseDto {
  /** The accounts of this page, sorted by address. */
  data: AccountResponseDto[];
  /** `true` when there is a next page. */
  hasMore: boolean;
  /** The `cursor` that gets the next page. It is there only when `hasMore` is `true`. */
  next?: string;
}

export function toAccountPageResponseDto(page: IAccountPage): AccountPageResponseDto {
  const last = page.accounts.at(-1);
  return {
    data: page.accounts.map(toAccountResponseDto),
    hasMore: page.hasMore,
    // `last` is always there when `hasMore` is true, because a page holds at
    // least one account. The check is only for the type.
    next: page.hasMore && last !== undefined ? encodeAccountCursor(last.address.value) : undefined,
  };
}
