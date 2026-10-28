import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { TenantRequest } from './tenant-request.js';

/**
 * Parameter decorator that gives a controller method the organization id
 * that `TenantGuard` has checked.
 *
 * Pass the value to `withTenant(db, organizationId, ...)`. Controllers should
 * never read the header themselves.
 *
 * It fails closed. If the route has no `TenantGuard`, it throws a plain
 * `Error` (HTTP 500), because that is a coding mistake and not a bad request.
 *
 * @example
 * ```ts
 * @Get()
 * list(@OrganizationId() organizationId: string) {}
 * ```
 */
export const OrganizationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const { organizationId } = context.switchToHttp().getRequest<TenantRequest>();
    if (!organizationId) {
      // A programming mistake (route without TenantGuard), so a plain 500, not a 400.
      throw new Error('@OrganizationId() used on a route without TenantGuard');
    }
    return organizationId;
  },
);
