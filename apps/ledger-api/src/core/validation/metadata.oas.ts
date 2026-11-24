import type { IOpenApiModule } from '../openapi/openapi.type.js';
import { metadataKeySchema, metadataSchema, saveMetadataSchema } from './metadata.dto.js';

export const metadataOpenApi: IOpenApiModule = {
  sharedSchemas: { Metadata: metadataSchema },
  requestSchemas: { SaveMetadataRequest: saveMetadataSchema },
  parameters: {
    MetadataKey: {
      in: 'path',
      name: 'key',
      description: 'The metadata key to remove.',
      schema: metadataKeySchema,
    },
  },
};
