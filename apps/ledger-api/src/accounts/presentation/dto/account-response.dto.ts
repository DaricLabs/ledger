import type { Money } from '@ledger/domain';
import { z } from 'zod';
import { pageResponseSchema } from '../../../core/pagination/page-response.dto.js';
import { isoDateTimeSchema } from '../../../core/validation/iso-date-time.dto.js';
import { metadataSchema } from '../../../core/validation/metadata.dto.js';
import type { IAccountPage } from '../../application/ports/account-repository.port.js';
import type { Account } from '../../domain/entities/account.entity.js';
import { accountAddressSchema } from './account-address.dto.js';
import { encodeAccountCursor } from './account-page-cursor.dto.js';

/** What an account holds in one asset. Field names are part of the public API. */
export const balanceResponseSchema = z.object({
  asset: z.string().meta({
    description: 'Code of the asset.',
    examples: ['USD'],
  }),
  amount: z.string().meta({
    description:
      'A string of digits in the smallest unit of the asset, like `"1050"`, with a leading ' +
      '`-` when it is below zero (only an account that may go below zero, like `world`, can be).',
    examples: ['1050', '-2500'],
  }),
});

/**
 * An account as clients see it. Field names are part of the public API.
 * `organizationId` and `ledgerId` are not included: the caller already knows
 * them from the header and the URL.
 */
export const accountResponseSchema = z.object({
  address: accountAddressSchema,
  allowOverdraft: z.boolean().meta({ description: '`true` when the account may go below zero.' }),
  balances: z.array(balanceResponseSchema).meta({
    description: 'One entry for each asset the account has held, in the order of the asset codes.',
  }),
  metadata: metadataSchema,
  createdAt: isoDateTimeSchema.meta({ description: 'When the ledger first saw the account.' }),
});

export type BalanceResponseDto = z.infer<typeof balanceResponseSchema>;
export type AccountResponseDto = z.infer<typeof accountResponseSchema>;

function toBalanceResponseDto(balance: Money): BalanceResponseDto {
  return { asset: balance.asset.value, amount: balance.amount.toString() };
}

export function toAccountResponseDto(account: Account): AccountResponseDto {
  return {
    address: account.address.value,
    allowOverdraft: account.allowOverdraft,
    balances: account.balances.map(toBalanceResponseDto),
    metadata: account.metadata.entries,
    createdAt: account.createdAt.toISOString(),
  };
}

/** One page of `GET /ledgers/:ledgerName/accounts`. Field names are part of the public API. */
export const accountPageResponseSchema = pageResponseSchema(
  accountResponseSchema,
  'sorted by address',
);

export type AccountPageResponseDto = z.infer<typeof accountPageResponseSchema>;

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
