import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import { OrganizationId } from '../../core/tenant/organization-id.decorator.js';
import { TenantGuard } from '../../core/tenant/tenant.guard.js';
import { ledgerNameSchema } from '../../ledgers/presentation/dto/ledger-name.dto.js';
import { LedgerExceptionFilter } from '../../ledgers/presentation/filters/ledger-exception.filter.js';
import { GetAccountUseCase } from '../application/use-cases/get-account.use-case.js';
import { ListAccountsUseCase } from '../application/use-cases/list-accounts.use-case.js';
import { AccountExceptionFilter } from './account-exception.filter.js';
import { accountAddressSchema } from './dto/account-address.dto.js';
import {
  listAccountsQuerySchema,
  type ListAccountsQueryDto,
} from './dto/list-accounts-query.dto.js';
import {
  toAccountPageResponseDto,
  toAccountResponseDto,
  type AccountPageResponseDto,
  type AccountResponseDto,
} from './dto/account-response.dto.js';

const LEDGERS_PATH = 'ledgers';
const ACCOUNTS_PATH = 'accounts';

/**
 * HTTP entry of the accounts feature. It only reads the request, calls a use
 * case and shapes the response. Rules live in the domain, and the domain
 * errors become HTTP errors in `AccountExceptionFilter`.
 *
 * An account belongs to a ledger, so its URL is under the ledger. The ledger
 * errors (`LEDGER_NOT_FOUND`) are turned into HTTP errors by the ledgers
 * feature's own filter.
 *
 * `TenantGuard` runs first, so a bad `X-Organization-Id` header is refused
 * before the URL is looked at.
 */
@Controller(`${LEDGERS_PATH}/:ledgerName/${ACCOUNTS_PATH}`)
@UseGuards(TenantGuard)
@UseFilters(LedgerExceptionFilter, AccountExceptionFilter)
export class AccountsController {
  constructor(
    private readonly getAccount: GetAccountUseCase,
    private readonly listAccounts: ListAccountsUseCase,
  ) {}

  /**
   * Lists the accounts of a ledger of the organization of the
   * `X-Organization-Id` header, one page at a time, sorted by address. Each
   * one has the same shape as the response of the get call.
   *
   * To read all pages, call again with `cursor` set to the `next` of the last
   * response, until `hasMore` is `false`. The pages follow the address, so an
   * account that is made while you read never moves the pages after a cursor.
   * It shows up only if its address comes after the cursor.
   *
   * - `200`: one page. It is empty when the ledger has no accounts.
   * - `400`: `VALIDATION` (the ledger name has a wrong shape, `pageSize` is
   *   not a whole number from 1 to 100, the `cursor` is not one we gave, or a
   *   query parameter is unknown).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization).
   */
  @Get()
  async list(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Query({ schema: listAccountsQuerySchema }) query: ListAccountsQueryDto,
  ): Promise<AccountPageResponseDto> {
    const page = await this.listAccounts.execute({
      organizationId,
      ledgerName,
      pageSize: query.pageSize,
      afterAddress: query.cursor,
    });
    return toAccountPageResponseDto(page);
  }

  /**
   * Gets an account of a ledger of the organization of the
   * `X-Organization-Id` header, by its address, with what it holds in each
   * asset. Amounts are strings of digits, in the smallest unit of the asset.
   *
   * There are no accounts to create. An account exists once money has moved
   * through it, so an address that no transaction has used gives `404`.
   *
   * - `200`: the account.
   * - `400`: `VALIDATION` (the ledger name or the address has a wrong shape).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization) or
   *   `ACCOUNT_NOT_FOUND` (no such account in this ledger).
   */
  @Get(':address')
  async get(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Param('address', { schema: accountAddressSchema }) address: string,
  ): Promise<AccountResponseDto> {
    const account = await this.getAccount.execute({ organizationId, ledgerName, address });
    return toAccountResponseDto(account);
  }
}
