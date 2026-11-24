import { z } from 'zod';
import type {
  IOpenApiDocument,
  IOpenApiHeader,
  IOpenApiInfo,
  IOpenApiModule,
  IOpenApiOperation,
  IOpenApiParameter,
  IOpenApiResponse,
  IOpenApiTag,
  JsonSchema,
  IOpenApiRef,
  OpenApiSchema,
} from './openapi.type.js';

const SCHEMA_REF_PREFIX = '#/components/schemas/';
const JSON_CONTENT_TYPE = 'application/json';

/** A `$ref` to a named parameter of `components`. */
export function parameterRef(name: string): IOpenApiRef {
  return { $ref: `#/components/parameters/${name}` };
}

/** A `$ref` to a named header of `components`. */
export function headerRef(name: string): IOpenApiRef {
  return { $ref: `#/components/headers/${name}` };
}

export interface IOpenApiDocumentInput {
  info: IOpenApiInfo;
  tags: IOpenApiTag[];
  modules: IOpenApiModule[];
}

type Registry = z.core.$ZodRegistry<{ id?: string }>;
type Json = Record<string, unknown>;

/**
 * Puts the modules together into one OpenAPI 3.1 document.
 *
 * The registries are made here, for this call only, and are not kept anywhere.
 * Building twice gives the same document, and a test can build its own.
 *
 * @throws {Error} If two named schemas, operations or parameters share a name.
 */
export function buildOpenApiDocument(input: IOpenApiDocumentInput): IOpenApiDocument {
  const { requestRegistry, responseRegistry, schemas } = buildSchemas(input.modules);
  const resolver = (schema: OpenApiSchema, io: 'input' | 'output') =>
    resolveSchema(schema, io, [requestRegistry, responseRegistry]);

  const paths: IOpenApiDocument['paths'] = {};
  const operationIds = new Set<string>();
  for (const operation of input.modules.flatMap((module) => module.operations ?? [])) {
    if (operationIds.has(operation.operationId)) {
      throw new Error(`Duplicate operationId: ${operation.operationId}`);
    }
    operationIds.add(operation.operationId);

    const item = (paths[operation.path] ??= {});
    if (item[operation.method] !== undefined) {
      throw new Error(`Duplicate operation: ${operation.method.toUpperCase()} ${operation.path}`);
    }
    item[operation.method] = buildOperation(operation, resolver);
  }

  return {
    openapi: '3.1.0',
    info: input.info,
    tags: input.tags,
    paths,
    components: {
      schemas,
      parameters: collectNamed<IOpenApiParameter>(input.modules, 'parameters', (parameter) =>
        buildParameter(parameter, resolver),
      ),
      headers: collectNamed<IOpenApiHeader>(input.modules, 'headers', (header) =>
        buildHeader(header, resolver),
      ),
    },
  };
}

type Resolver = (schema: OpenApiSchema, io: 'input' | 'output') => JsonSchema;

function buildOperation(operation: IOpenApiOperation, resolve: Resolver): Json {
  const result: Json = {
    tags: [operation.tag],
    summary: operation.summary,
    description: operation.description,
    operationId: operation.operationId,
  };
  if (operation.parameters.length > 0) {
    result.parameters = operation.parameters.map((parameter) =>
      '$ref' in parameter ? parameter : buildParameter(parameter, resolve),
    );
  }
  if (operation.requestBody) {
    const { description, required, schema } = operation.requestBody;
    result.requestBody = {
      ...(description === undefined ? {} : { description }),
      required,
      content: { [JSON_CONTENT_TYPE]: { schema: resolve(schema, 'input') } },
    };
  }
  result.responses = Object.fromEntries(
    Object.entries(operation.responses).map(([status, response]) => [
      status,
      buildResponse(response, resolve),
    ]),
  );
  return result;
}

function buildParameter(parameter: IOpenApiParameter, resolve: Resolver): Json {
  return {
    name: parameter.name,
    in: parameter.in,
    description: parameter.description,
    required: parameter.in === 'path' ? true : (parameter.required ?? false),
    // A parameter is text on the wire, so its schema is always the `input` reading.
    schema: resolve(parameter.schema, 'input'),
  };
}

function buildHeader(header: IOpenApiHeader, resolve: Resolver): Json {
  return {
    description: header.description,
    required: header.required ?? false,
    schema: resolve(header.schema, 'output'),
  };
}

function buildResponse(response: IOpenApiResponse, resolve: Resolver): Json {
  const result: Json = { description: response.description };
  if (response.headers) {
    result.headers = Object.fromEntries(
      Object.entries(response.headers).map(([name, header]) => [
        name,
        '$ref' in header ? header : buildHeader(header, resolve),
      ]),
    );
  }
  if (response.schema) {
    result.content = {
      [JSON_CONTENT_TYPE]: { schema: resolve(response.schema, 'output') },
    };
  }
  return result;
}

/** Joins the named parts (`parameters` or `headers`) of all modules, refusing a name used twice. */
function collectNamed<Input>(
  modules: IOpenApiModule[],
  key: 'parameters' | 'headers',
  build: (input: Input) => Json,
): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const module of modules) {
    const named = (module[key] ?? {}) as Record<string, Input>;
    for (const [name, value] of Object.entries(named)) {
      if (name in result) {
        throw new Error(`Duplicate ${key} name: ${name}`);
      }
      result[name] = build(value);
    }
  }
  return result;
}

/**
 * Reads every named schema of the modules.
 *
 * Request schemas are read in `input` mode and response schemas in `output`
 * mode, so each has its own registry. A shared schema is in both registries,
 * so `$ref`s to it work on both sides, but it is read once, from the response
 * registry, so the document has one copy of it.
 */
function buildSchemas(modules: IOpenApiModule[]) {
  const requestRegistry = z.registry<{ id?: string }>();
  const responseRegistry = z.registry<{ id?: string }>();
  const ids = new Set<string>();
  const claim = (id: string) => {
    if (ids.has(id)) {
      throw new Error(`Duplicate schema name: ${id}`);
    }
    ids.add(id);
  };

  for (const module of modules) {
    for (const [id, schema] of Object.entries(module.requestSchemas ?? {})) {
      claim(id);
      requestRegistry.add(schema, { id });
    }
    for (const [id, schema] of Object.entries(module.responseSchemas ?? {})) {
      claim(id);
      responseRegistry.add(schema, { id });
    }
    for (const [id, schema] of Object.entries(module.sharedSchemas ?? {})) {
      claim(id);
      requestRegistry.add(schema, { id });
      responseRegistry.add(schema, { id });
    }
  }

  const shared = new Set(modules.flatMap((module) => Object.keys(module.sharedSchemas ?? {})));
  const fromRequests = readRegistry(requestRegistry, 'input');
  const fromResponses = readRegistry(responseRegistry, 'output');
  const schemas: Record<string, JsonSchema> = {};
  for (const [id, schema] of Object.entries(fromRequests)) {
    if (!shared.has(id)) {
      schemas[id] = schema;
    }
  }
  Object.assign(schemas, fromResponses);
  return { requestRegistry, responseRegistry, schemas };
}

function readRegistry(registry: Registry, io: 'input' | 'output'): Record<string, JsonSchema> {
  const { schemas } = z.toJSONSchema(registry, {
    io,
    uri: (id) => `${SCHEMA_REF_PREFIX}${id}`,
    override: io === 'output' ? openResponseObjects : undefined,
  });
  return Object.fromEntries(
    Object.entries(schemas).map(([id, schema]) => [id, withoutSchemaKeys(schema as JsonSchema)]),
  );
}

/**
 * Turns a schema into JSON Schema, or a `$ref` when the schema is a named one.
 * An unnamed Zod schema is written out in place.
 */
function resolveSchema(
  schema: OpenApiSchema,
  io: 'input' | 'output',
  registries: Registry[],
): JsonSchema {
  if (!isZodType(schema)) {
    return schema as JsonSchema;
  }
  for (const registry of registries) {
    const id = registry.get(schema)?.id;
    if (id !== undefined) {
      return { $ref: `${SCHEMA_REF_PREFIX}${id}` };
    }
  }
  return withoutSchemaKeys(
    z.toJSONSchema(schema, { io, override: io === 'output' ? openResponseObjects : undefined }),
  );
}

/**
 * Zod writes `additionalProperties: false` on every response object in
 * `output` mode. A response must stay open: adding a field later is not a
 * breaking change, and a client that reads a closed object as a contract would
 * break on it. (Requests are different: we refuse unknown fields on purpose.)
 */
function openResponseObjects(context: { jsonSchema: JsonSchema }): void {
  if (context.jsonSchema.additionalProperties === false) {
    delete context.jsonSchema.additionalProperties;
  }
}

/** `$schema` and `$id` are part of a standalone JSON Schema. OpenAPI documents have no use for them. */
function withoutSchemaKeys(schema: JsonSchema): JsonSchema {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}
