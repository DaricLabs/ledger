import type { z } from 'zod';

/** A JSON Schema, written as a plain object. */
export type JsonSchema = Record<string, unknown>;

/** A reference to a part of `components`, like `{ $ref: '#/components/parameters/OrganizationId' }`. */
export interface IOpenApiRef {
  $ref: string;
}

/**
 * A schema in an operation: a Zod schema, or plain JSON Schema for the rare
 * case where the Zod schema is not what clients should read (see
 * `pagination.oas.ts`).
 */
export type OpenApiSchema = z.ZodType | JsonSchema;

export interface IOpenApiParameter {
  in: 'path' | 'query' | 'header';
  name: string;
  description: string;
  /** Path parameters are always required. For the others the default is `false`. */
  required?: boolean;
  schema: OpenApiSchema;
}

export interface IOpenApiHeader {
  description: string;
  required?: boolean;
  schema: OpenApiSchema;
}

export interface IOpenApiRequestBody {
  description?: string;
  required: boolean;
  /** A schema that is registered in `requestSchemas` becomes a `$ref`. */
  schema: z.ZodType;
}

export interface IOpenApiResponse {
  description: string;
  /** The JSON body. A schema that is registered becomes a `$ref`. Leave it out for no body (204). */
  schema?: z.ZodType;
  headers?: Record<string, IOpenApiHeader | IOpenApiRef>;
}

export type OpenApiMethod = 'get' | 'post' | 'delete';

/**
 * One HTTP operation, written by hand. The text and the status codes are
 * decided by people. The shapes of bodies and parameters come from the Zod
 * schemas that the controller already validates with.
 */
export interface IOpenApiOperation {
  method: OpenApiMethod;
  /** In OpenAPI style, with `{name}` for a parameter: `/ledgers/{ledgerName}`. */
  path: string;
  /** A unique name. Client generators turn it into a method name. */
  operationId: string;
  /** Groups the operation in the docs. Must be one of the tags of the document. */
  tag: string;
  /** One line. */
  summary: string;
  /** Markdown. */
  description: string;
  parameters: Array<IOpenApiParameter | IOpenApiRef>;
  requestBody?: IOpenApiRequestBody;
  /** By HTTP status. */
  responses: Record<number, IOpenApiResponse>;
}

/**
 * What one part of the app adds to the API description. The document is the
 * sum of all modules, so each feature describes itself, next to its own
 * controller, and `core/` does not know the features.
 */
export interface IOpenApiModule {
  /**
   * Named schemas for requests. They are read in `input` mode: the shape a
   * client sends, before transforms and defaults.
   */
  requestSchemas?: Record<string, z.ZodType>;
  /**
   * Named schemas for responses. They are read in `output` mode: the shape a
   * client gets. A schema with a transform throws here, on purpose.
   */
  responseSchemas?: Record<string, z.ZodType>;
  /**
   * Named schemas used by both sides (a ledger name, metadata). They have no
   * transform or default, so one reading serves both.
   */
  sharedSchemas?: Record<string, z.ZodType>;
  parameters?: Record<string, IOpenApiParameter>;
  headers?: Record<string, IOpenApiHeader>;
  operations?: IOpenApiOperation[];
}

export interface IOpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface IOpenApiTag {
  name: string;
  description?: string;
}

/**
 * The document that `buildOpenApiDocument` makes. Only the top level is
 * typed. The parts below it are plain JSON, and the test checks them against
 * the official OpenAPI 3.1 schema.
 */
export interface IOpenApiDocument {
  openapi: '3.1.0';
  info: IOpenApiInfo;
  tags: IOpenApiTag[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, JsonSchema>;
    parameters: Record<string, unknown>;
    headers: Record<string, unknown>;
  };
}
