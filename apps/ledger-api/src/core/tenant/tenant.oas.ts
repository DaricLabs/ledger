import { z } from 'zod';
import type { IOpenApiModule } from '../openapi/openapi.type.js';

/** Name of the parameter in `components.parameters`. */
export const ORGANIZATION_ID_PARAMETER = 'OrganizationId';

export const tenantOpenApi: IOpenApiModule = {
  parameters: {
    [ORGANIZATION_ID_PARAMETER]: {
      in: 'header',
      name: 'X-Organization-Id',
      required: true,
      description:
        'The organization that owns the data, a UUIDv7. The gateway sets it after it has ' +
        'authenticated the caller, and the ledger trusts it, so never expose the ledger to the ' +
        'public without a gateway. Every ledger belongs to one organization, and one ' +
        'organization never sees the data of another.',
      schema: z.uuidv7(),
    },
  },
};
