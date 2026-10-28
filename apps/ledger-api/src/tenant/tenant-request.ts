import type { Request } from 'express';

/**
 * Express request after `TenantGuard` has run.
 *
 * `organizationId` is set by the guard and nowhere else. It is `undefined`
 * on routes without the guard, so read it with `@OrganizationId()` and not
 * directly from the request.
 */
export type TenantRequest = Request & { organizationId?: string };
