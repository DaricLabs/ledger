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
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrganizationId } from '../../core/tenant/organization-id.decorator.js';
import { TenantGuard } from '../../core/tenant/tenant.guard.js';
import { CreateLedgerUseCase } from '../application/use-cases/create-ledger.use-case.js';
import { DeleteLedgerMetadataUseCase } from '../application/use-cases/delete-ledger-metadata.use-case.js';
import { GetLedgerUseCase } from '../application/use-cases/get-ledger.use-case.js';
import { ListLedgersUseCase } from '../application/use-cases/list-ledgers.use-case.js';
import { SaveLedgerMetadataUseCase } from '../application/use-cases/save-ledger-metadata.use-case.js';
import { createLedgerSchema, type CreateLedgerDto } from './dto/create-ledger.dto.js';
import { listLedgersQuerySchema, type ListLedgersQueryDto } from './dto/list-ledgers-query.dto.js';
import {
  toLedgerPageResponseDto,
  toLedgerResponseDto,
  type LedgerPageResponseDto,
  type LedgerResponseDto,
} from './dto/ledger-response.dto.js';
import {
  ledgerMetadataKeySchema,
  saveLedgerMetadataSchema,
  type SaveLedgerMetadataDto,
} from './dto/ledger-metadata.dto.js';
import { ledgerNameSchema } from './dto/ledger-name.dto.js';
import { LedgerExceptionFilter } from './ledger-exception.filter.js';

const LEDGERS_PATH = 'ledgers';

/**
 * HTTP entry of the ledgers feature. It only reads the request, calls a use
 * case and shapes the response. Rules live in the domain, and the domain
 * errors become HTTP errors in `LedgerExceptionFilter`.
 *
 * `TenantGuard` runs first, so a bad `X-Organization-Id` header is refused
 * before the body or the URL is looked at.
 */
@Controller(LEDGERS_PATH)
@UseGuards(TenantGuard)
@UseFilters(LedgerExceptionFilter)
export class LedgersController {
  constructor(
    private readonly createLedger: CreateLedgerUseCase,
    private readonly getLedger: GetLedgerUseCase,
    private readonly listLedgers: ListLedgersUseCase,
    private readonly saveLedgerMetadata: SaveLedgerMetadataUseCase,
    private readonly deleteLedgerMetadata: DeleteLedgerMetadataUseCase,
  ) {}

  /**
   * Creates a ledger in the organization of the `X-Organization-Id` header.
   *
   * - `201`: the ledger was created. The `Location` header is its URL.
   * - `400`: `VALIDATION` (bad shape), `INVALID_LEDGER_NAME` (reserved name),
   *   `INVALID_LEDGER_METADATA` or `LEDGER_METADATA_LIMIT_EXCEEDED` (metadata is
   *   too big).
   * - `409`: `LEDGER_ALREADY_EXISTS` (the organization already uses this name).
   */
  @Post()
  async create(
    @OrganizationId() organizationId: string,
    @Body({ schema: createLedgerSchema }) body: CreateLedgerDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LedgerResponseDto> {
    const ledger = await this.createLedger.execute({
      organizationId,
      name: body.name,
      metadata: body.metadata,
    });
    // The name is safe in a URL: it passed the name pattern.
    response.location(`/${LEDGERS_PATH}/${ledger.name}`);
    return toLedgerResponseDto(ledger);
  }

  /**
   * Lists the ledgers of the organization of the `X-Organization-Id` header,
   * sorted by name, one page at a time.
   *
   * To read all pages, call again with `cursor` set to the `next` of the last
   * response, until `hasMore` is `false`.
   *
   * - `200`: one page. It is empty when the organization has no ledgers.
   * - `400`: `VALIDATION` (`pageSize` is not a whole number from 1 to 100, the
   *   `cursor` is not one we gave, or a query parameter is unknown).
   */
  @Get()
  async list(
    @OrganizationId() organizationId: string,
    @Query({ schema: listLedgersQuerySchema }) query: ListLedgersQueryDto,
  ): Promise<LedgerPageResponseDto> {
    const page = await this.listLedgers.execute({
      organizationId,
      pageSize: query.pageSize,
      afterName: query.cursor,
    });
    return toLedgerPageResponseDto(page);
  }

  /**
   * Gets a ledger of the organization of the `X-Organization-Id` header, by name.
   *
   * - `200`: the ledger.
   * - `400`: `VALIDATION` (the name has a wrong shape).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization).
   */
  @Get(':name')
  async get(
    @OrganizationId() organizationId: string,
    @Param('name', { schema: ledgerNameSchema }) name: string,
  ): Promise<LedgerResponseDto> {
    const ledger = await this.getLedger.execute({ organizationId, name });
    return toLedgerResponseDto(ledger);
  }

  /**
   * Adds metadata entries to a ledger of the organization of the
   * `X-Organization-Id` header. The body is a plain object, like
   * `{ "env": "prod" }`. A key that is already there gets the new value, and
   * the other keys stay as they are.
   *
   * It is safe to repeat: the same body gives the same result.
   *
   * - `204`: the metadata is saved (or was already like this).
   * - `400`: `VALIDATION` (the name has a wrong shape, the body is not an
   *   object of strings, a key is empty, or there is no key at all) or
   *   `LEDGER_METADATA_LIMIT_EXCEEDED` (the ledger would have too many keys, or
   *   a key, a value or the total would be too big).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization).
   */
  @Post(':name/metadata')
  @HttpCode(HttpStatus.NO_CONTENT)
  async saveMetadata(
    @OrganizationId() organizationId: string,
    @Param('name', { schema: ledgerNameSchema }) name: string,
    @Body({ schema: saveLedgerMetadataSchema }) metadata: SaveLedgerMetadataDto,
  ): Promise<void> {
    await this.saveLedgerMetadata.execute({ organizationId, name, metadata });
  }

  /**
   * Removes one metadata key from a ledger of the organization of the
   * `X-Organization-Id` header.
   *
   * It is safe to repeat: a key that is not there is not an error.
   *
   * - `204`: the key is gone (or was never there).
   * - `400`: `VALIDATION` (the name has a wrong shape).
   * - `404`: `LEDGER_NOT_FOUND` (no such ledger in this organization).
   */
  @Delete(':name/metadata/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMetadata(
    @OrganizationId() organizationId: string,
    @Param('name', { schema: ledgerNameSchema }) name: string,
    @Param('key', { schema: ledgerMetadataKeySchema }) key: string,
  ): Promise<void> {
    await this.deleteLedgerMetadata.execute({ organizationId, name, key });
  }
}
