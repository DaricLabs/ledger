import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { OrganizationId } from '../../../core/tenant/organization-id.decorator.js';
import { TenantGuard } from '../../../core/tenant/tenant.guard.js';
import {
  metadataKeySchema,
  saveMetadataSchema,
  type SaveMetadataDto,
} from '../../../core/validation/metadata.dto.js';
import { ledgerNameSchema } from '../../../ledgers/presentation/dto/ledger-name.dto.js';
import { LedgerExceptionFilter } from '../../../ledgers/presentation/filters/ledger-exception.filter.js';
import { DeleteAccountMetadataUseCase } from '../../application/use-cases/delete-account-metadata.use-case.js';
import { GetAccountUseCase } from '../../application/use-cases/get-account.use-case.js';
import { ListAccountsUseCase } from '../../application/use-cases/list-accounts.use-case.js';
import { SaveAccountMetadataUseCase } from '../../application/use-cases/save-account-metadata.use-case.js';
import { AccountExceptionFilter } from '../filters/account-exception.filter.js';
import { accountAddressSchema } from '../dto/account-address.dto.js';
import {
  listAccountsQuerySchema,
  type ListAccountsQueryDto,
} from '../dto/list-accounts-query.dto.js';
import {
  toAccountPageResponseDto,
  toAccountResponseDto,
  type IAccountPageResponse,
  type IAccountResponse,
} from '../dto/account-response.dto.js';

const LEDGERS_PATH = 'ledgers';
const ACCOUNTS_PATH = 'accounts';
const METADATA_PATH = 'metadata';

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
    private readonly saveAccountMetadata: SaveAccountMetadataUseCase,
    private readonly deleteAccountMetadata: DeleteAccountMetadataUseCase,
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
  ): Promise<IAccountPageResponse> {
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
  ): Promise<IAccountResponse> {
    const account = await this.getAccount.execute({ organizationId, ledgerName, address });
    return toAccountResponseDto(account);
  }

  /**
   * Adds metadata entries to an account of a ledger of the organization of the
   * `X-Organization-Id` header. The body is a plain object, like
   * `{ "customerId": "c_42" }`. A key that is already there gets the new
   * value, and the other keys stay as they are. The balances never change.
   *
   * There are no accounts to create, so the account must exist: an address
   * that no transaction has used gives `404`.
   *
   * It is safe to repeat: the same body gives the same result. Every real
   * change leaves an entry in the journal, and a repeat that changes nothing
   * leaves none. Use ids, not personal data: the journal keeps what is
   * written.
   *
   * - `204`: the metadata is saved (or was already like this).
   * - `400`: `VALIDATION` (the ledger name or the address has a wrong shape,
   *   the body is not an object of strings, a key is empty, or there is no key
   *   at all) or `METADATA_LIMIT_EXCEEDED` (the account would have too many
   *   keys, or a key, a value or the total would be too big).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization) or
   *   `ACCOUNT_NOT_FOUND` (no such account in this ledger).
   */
  @Post(`:address/${METADATA_PATH}`)
  @HttpCode(HttpStatus.NO_CONTENT)
  async saveMetadata(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Param('address', { schema: accountAddressSchema }) address: string,
    @Body({ schema: saveMetadataSchema }) metadata: SaveMetadataDto,
  ): Promise<void> {
    await this.saveAccountMetadata.execute({ organizationId, ledgerName, address, metadata });
  }

  /**
   * Removes one metadata key from an account of a ledger of the organization
   * of the `X-Organization-Id` header.
   *
   * It is safe to repeat: a key that is not there is not an error.
   *
   * - `204`: the key is gone (or was never there).
   * - `400`: `VALIDATION` (the ledger name or the address has a wrong shape).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization) or
   *   `ACCOUNT_NOT_FOUND` (no such account in this ledger).
   */
  @Delete(`:address/${METADATA_PATH}/:key`)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMetadata(
    @OrganizationId() organizationId: string,
    @Param('ledgerName', { schema: ledgerNameSchema }) ledgerName: string,
    @Param('address', { schema: accountAddressSchema }) address: string,
    @Param('key', { schema: metadataKeySchema }) key: string,
  ): Promise<void> {
    await this.deleteAccountMetadata.execute({ organizationId, ledgerName, address, key });
  }
}
