import type { IOpenApiModule, IOpenApiTag } from '../openapi/openapi.type.js';
import { healthResponseSchema } from './health-response.dto.js';

export const HEALTH_TAG: IOpenApiTag = {
  name: 'Health',
  description: 'For the orchestrator, not for the clients of the ledger.',
};

export const healthOpenApi: IOpenApiModule = {
  responseSchemas: { HealthResponse: healthResponseSchema },
  operations: [
    {
      method: 'get',
      path: '/health',
      operationId: 'getHealth',
      tag: HEALTH_TAG.name,
      summary: 'Check that the process is running',
      description:
        'Liveness check: it answers whether the process runs. It does not touch the database ' +
        'on purpose, so a database outage does not make an orchestrator restart a healthy ' +
        'process. It needs no `X-Organization-Id` header.',
      parameters: [],
      responses: {
        200: { description: 'The process is running.', schema: healthResponseSchema },
      },
    },
  ],
};
