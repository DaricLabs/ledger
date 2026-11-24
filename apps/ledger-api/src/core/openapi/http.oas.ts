import type { IOpenApiModule } from './openapi.type.js';

/** The `Location` header of a response that created something. Name of the component in `components.headers`. */
export const LOCATION_HEADER = 'Location';

/** Parts of the API description that are plain HTTP and belong to no feature. */
export const httpOpenApi: IOpenApiModule = {
  headers: {
    [LOCATION_HEADER]: {
      description: 'The URL of what was created.',
      required: true,
      schema: { type: 'string' },
    },
  },
};
