import { errorDetailSchema, errorResponseSchema } from './error-response.dto.js';
import type { IOpenApiModule, IOpenApiResponse } from '../openapi/openapi.type.js';

export const errorsOpenApi: IOpenApiModule = {
  responseSchemas: {
    ErrorDetail: errorDetailSchema,
    ErrorResponse: errorResponseSchema,
  },
};

/**
 * An error response of an operation: the shared error body, and a list of the
 * `errorCode` values that this status can have here, so a reader sees what to
 * switch on.
 *
 * @param intro One sentence about what the status means here.
 * @param codes Each `errorCode` that can come with this status, and when.
 */
export function errorResponse(intro: string, codes: Record<string, string>): IOpenApiResponse {
  const lines = Object.entries(codes).map(([code, when]) => `- \`${code}\`: ${when}`);
  return {
    description: [intro, ...(lines.length > 0 ? ['', ...lines] : [])].join('\n'),
    schema: errorResponseSchema,
  };
}

/**
 * The `400 INVALID_REQUEST` that any route of a controller can give, for the
 * `codes` of a 400 response. A route with a body can also get it for a body
 * that is not valid JSON.
 */
export function invalidRequest(hasBody: boolean): Record<string, string> {
  return {
    INVALID_REQUEST: hasBody
      ? 'the `X-Organization-Id` header is missing or is not a UUIDv7, or the body is not valid JSON.'
      : 'the `X-Organization-Id` header is missing or is not a UUIDv7.',
  };
}
