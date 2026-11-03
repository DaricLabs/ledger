import { Body, Controller, Post, UseFilters, UseGuards } from '@nestjs/common';
import { OrganizationId } from '../../core/tenant/organization-id.decorator.js';
import { TenantGuard } from '../../core/tenant/tenant.guard.js';
import { CreateLedgerUseCase } from '../application/use-cases/create-ledger.use-case.js';
import { createLedgerSchema, type CreateLedgerDto } from './dto/create-ledger.dto.js';
import { toLedgerResponseDto, type LedgerResponseDto } from './dto/ledger-response.dto.js';
import { LedgerExceptionFilter } from './ledger-exception.filter.js';

/**
 * HTTP entry of the ledgers feature. It only reads the request, calls a use
 * case and shapes the response. Rules live in the domain, and the domain
 * errors become HTTP errors in `LedgerExceptionFilter`.
 *
 * `TenantGuard` runs first, so a bad `X-Organization-Id` header is refused
 * before the body is looked at.
 */
@Controller('ledgers')
@UseGuards(TenantGuard)
@UseFilters(LedgerExceptionFilter)
export class LedgersController {
  constructor(private readonly createLedger: CreateLedgerUseCase) {}

  /**
   * Creates a ledger in the organization of the `X-Organization-Id` header.
   *
   * - `201`: the ledger was created.
   * - `400`: `VALIDATION` (bad shape), `INVALID_LEDGER_NAME` (reserved name)
   *   or `INVALID_LEDGER_METADATA`.
   * - `409`: `LEDGER_ALREADY_EXISTS` (the organization already uses this name).
   */
  @Post()
  async create(
    @OrganizationId() organizationId: string,
    @Body({ schema: createLedgerSchema }) body: CreateLedgerDto,
  ): Promise<LedgerResponseDto> {
    const ledger = await this.createLedger.execute({
      organizationId,
      name: body.name,
      metadata: body.metadata,
    });
    return toLedgerResponseDto(ledger);
  }
}
