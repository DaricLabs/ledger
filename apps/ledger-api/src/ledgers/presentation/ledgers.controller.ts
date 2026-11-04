import { Body, Controller, Get, Param, Post, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OrganizationId } from '../../core/tenant/organization-id.decorator.js';
import { TenantGuard } from '../../core/tenant/tenant.guard.js';
import { CreateLedgerUseCase } from '../application/use-cases/create-ledger.use-case.js';
import { GetLedgerUseCase } from '../application/use-cases/get-ledger.use-case.js';
import { createLedgerSchema, type CreateLedgerDto } from './dto/create-ledger.dto.js';
import { toLedgerResponseDto, type LedgerResponseDto } from './dto/ledger-response.dto.js';
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
  ) {}

  /**
   * Creates a ledger in the organization of the `X-Organization-Id` header.
   *
   * - `201`: the ledger was created. The `Location` header is its URL.
   * - `400`: `VALIDATION` (bad shape), `INVALID_LEDGER_NAME` (reserved name)
   *   or `INVALID_LEDGER_METADATA`.
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
}
