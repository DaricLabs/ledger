import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { TenantRequest } from './tenant-request.js';

/**
 * Name of the header that carries the organization id, in lowercase
 * (Express lowercases all incoming header names).
 *
 * The gateway sets it after it has authenticated the caller. ledger-api
 * trusts it, so the ledger must never be exposed to the public directly.
 */
export const ORGANIZATION_ID_HEADER = 'x-organization-id';

const organizationIdSchema = z.uuidv7();

/**
 * Reads the organization id from the trusted `X-Organization-Id` header and
 * checks that it is a valid UUIDv7.
 *
 * If the header is valid, the guard saves the id on the request (for
 * `@OrganizationId()`) and adds it to the logs as `organization_id`.
 * If not, it throws a 400 and the handler does not run.
 *
 * It only checks the format. It does not check that the organization exists
 * or that the caller may use it. The gateway and the Identity service do that.
 *
 * Use it on each controller, not globally, so `/health` stays public.
 *
 * @example
 * ```ts
 * @UseGuards(TenantGuard)
 * @Controller('ledgers')
 * export class LedgersController {}
 * ```
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  /**
   * @param context Nest execution context of the current HTTP request.
   * @returns `true` when the header is a valid UUIDv7.
   * @throws {BadRequestException} If the header is missing or not a valid
   * UUIDv7. The message never contains the header value.
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const result = organizationIdSchema.safeParse(request.headers[ORGANIZATION_ID_HEADER]);

    if (!result.success) {
      // Never echo the header value back.
      throw new BadRequestException('X-Organization-Id header is missing or not a valid UUIDv7');
    }

    request.organizationId = result.data.toLowerCase();
    this.logger.assign({ organization_id: request.organizationId });
    return true;
  }
}
