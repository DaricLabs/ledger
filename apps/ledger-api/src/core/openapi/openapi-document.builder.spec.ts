import { z } from 'zod';
import { buildOpenApiDocument, headerRef, parameterRef } from './openapi-document.builder.js';
import type { IOpenApiDocument, IOpenApiModule, IOpenApiOperation } from './openapi.type.js';

const info = { title: 'Test', version: '1.0.0' };
const tags = [{ name: 'Things' }];

function build(...modules: IOpenApiModule[]) {
  return buildOpenApiDocument({ info, tags, modules });
}

/** One operation of the document, or a failure that says which one is missing. */
function operationOf(
  document: IOpenApiDocument,
  path: string,
  method: 'get' | 'post' | 'delete',
): Record<string, any> {
  const found = document.paths[path]?.[method];
  if (found === undefined) {
    throw new Error(`No ${method.toUpperCase()} ${path} in the document`);
  }
  return found as Record<string, any>;
}

function operation(overrides: Partial<IOpenApiOperation> = {}): IOpenApiOperation {
  return {
    method: 'get',
    path: '/things',
    operationId: 'listThings',
    tag: 'Things',
    summary: 'List things',
    description: 'Lists things.',
    parameters: [],
    responses: { 200: { description: 'ok' } },
    ...overrides,
  };
}

describe('buildOpenApiDocument', () => {
  it('makes an OpenAPI 3.1 document with the info and the tags it is given', () => {
    const document = build();

    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toEqual(info);
    expect(document.tags).toEqual(tags);
    expect(document.paths).toEqual({});
  });

  it('puts an operation under its path and method', () => {
    const document = build({ operations: [operation()] });

    expect(operationOf(document, '/things', 'get')).toMatchObject({
      operationId: 'listThings',
      tags: ['Things'],
      summary: 'List things',
      description: 'Lists things.',
      responses: { '200': { description: 'ok' } },
    });
  });

  it('leaves out `parameters` and `content` when there is nothing to say', () => {
    const document = build({ operations: [operation()] });
    const get = operationOf(document, '/things', 'get');

    expect(get).not.toHaveProperty('parameters');
    expect(get).not.toHaveProperty('requestBody');
    expect(get.responses).toEqual({ '200': { description: 'ok' } });
  });

  describe('schemas', () => {
    it('refers to a named schema with a $ref and keeps one copy in components', () => {
      const thing = z.object({ id: z.string() });
      const document = build({
        responseSchemas: { Thing: thing },
        operations: [operation({ responses: { 200: { description: 'ok', schema: thing } } })],
      });

      expect(document.components.schemas.Thing).toEqual({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      });
      const response = operationOf(document, '/things', 'get').responses['200'];
      expect(response.content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/Thing',
      });
    });

    it('writes an unnamed schema in place', () => {
      const document = build({
        operations: [
          operation({
            responses: { 200: { description: 'ok', schema: z.object({ n: z.number() }) } },
          }),
        ],
      });

      const response = operationOf(document, '/things', 'get').responses['200'];
      expect(response.content['application/json'].schema).toEqual({
        type: 'object',
        properties: { n: { type: 'number' } },
        required: ['n'],
      });
    });

    it('never writes $schema or $id', () => {
      const document = build({
        requestSchemas: { A: z.object({}) },
        responseSchemas: { B: z.object({}) },
        sharedSchemas: { C: z.string() },
      });

      for (const schema of Object.values(document.components.schemas)) {
        expect(schema).not.toHaveProperty('$schema');
        expect(schema).not.toHaveProperty('$id');
      }
    });

    it('reads a request schema as the client sends it, before a transform', () => {
      const amount = z
        .string()
        .regex(/^[0-9]+$/)
        .transform(BigInt);
      const document = build({ requestSchemas: { Pay: z.strictObject({ amount }) } });

      expect(document.components.schemas.Pay).toMatchObject({
        properties: { amount: { type: 'string', pattern: '^[0-9]+$' } },
        additionalProperties: false,
      });
    });

    it('keeps unknown fields refused in a request, as the controller does', () => {
      const document = build({ requestSchemas: { Pay: z.strictObject({ a: z.string() }) } });

      expect(document.components.schemas.Pay?.additionalProperties).toBe(false);
    });

    it('keeps a response open, so adding a field later is not a breaking change', () => {
      const document = build({
        responseSchemas: { Thing: z.object({ inner: z.object({ id: z.string() }) }) },
      });
      const thing = document.components.schemas.Thing as any;

      expect(thing).not.toHaveProperty('additionalProperties');
      expect(thing.properties.inner).not.toHaveProperty('additionalProperties');
    });

    it('does not open a map of strings, which has a schema for its values', () => {
      const document = build({ responseSchemas: { Map: z.record(z.string(), z.string()) } });

      expect(document.components.schemas.Map?.additionalProperties).toEqual({ type: 'string' });
    });

    it('refuses a response schema that has a transform, because the client could not read it', () => {
      expect(() =>
        build({ responseSchemas: { Bad: z.object({ n: z.string().transform(Number) }) } }),
      ).toThrow();
    });

    it('serves a shared schema to both sides with one copy', () => {
      const name = z.string().min(1);
      const document = build({
        sharedSchemas: { Name: name },
        requestSchemas: { Create: z.object({ name }) },
        responseSchemas: { Thing: z.object({ name }) },
      });

      expect(Object.keys(document.components.schemas).filter((id) => id === 'Name')).toHaveLength(
        1,
      );
      expect((document.components.schemas.Create as any).properties.name).toEqual({
        $ref: '#/components/schemas/Name',
      });
      expect((document.components.schemas.Thing as any).properties.name).toEqual({
        $ref: '#/components/schemas/Name',
      });
    });

    it('refuses two schemas with the same name, even on different sides', () => {
      expect(() =>
        build({ requestSchemas: { A: z.string() } }, { responseSchemas: { A: z.string() } }),
      ).toThrow('Duplicate schema name: A');
    });

    it('passes a plain JSON Schema through as it is', () => {
      const document = build({
        operations: [
          operation({
            parameters: [
              {
                in: 'query',
                name: 'pageSize',
                description: 'x',
                schema: { type: 'integer', minimum: 1 },
              },
            ],
          }),
        ],
      });

      expect(operationOf(document, '/things', 'get').parameters[0].schema).toEqual({
        type: 'integer',
        minimum: 1,
      });
    });
  });

  describe('parameters', () => {
    it('makes a path parameter required even when it is not said', () => {
      const document = build({
        operations: [
          operation({
            path: '/things/{id}',
            parameters: [{ in: 'path', name: 'id', description: 'The id.', schema: z.string() }],
          }),
        ],
      });

      expect(operationOf(document, '/things/{id}', 'get').parameters[0]).toEqual({
        name: 'id',
        in: 'path',
        description: 'The id.',
        required: true,
        schema: { type: 'string' },
      });
    });

    it('makes a query or header parameter optional unless it is said to be required', () => {
      const document = build({
        operations: [
          operation({
            parameters: [
              { in: 'query', name: 'a', description: 'a', schema: z.string() },
              { in: 'header', name: 'B', description: 'b', required: true, schema: z.string() },
            ],
          }),
        ],
      });
      const parameters = operationOf(document, '/things', 'get').parameters;

      expect(parameters[0].required).toBe(false);
      expect(parameters[1].required).toBe(true);
    });

    it('keeps a reference to a named parameter and writes the parameter in components', () => {
      const document = build({
        parameters: {
          Org: {
            in: 'header',
            name: 'X-Org',
            required: true,
            description: 'd',
            schema: z.string(),
          },
        },
        operations: [operation({ parameters: [parameterRef('Org')] })],
      });

      expect(operationOf(document, '/things', 'get').parameters).toEqual([
        { $ref: '#/components/parameters/Org' },
      ]);
      expect(document.components.parameters.Org).toMatchObject({ name: 'X-Org', required: true });
    });

    it('refuses two parameters with the same name', () => {
      const parameter = { in: 'query', name: 'a', description: 'a', schema: z.string() } as const;

      expect(() =>
        build({ parameters: { A: parameter } }, { parameters: { A: parameter } }),
      ).toThrow('Duplicate parameters name: A');
    });
  });

  describe('request bodies and responses', () => {
    it('describes a JSON request body, required or not', () => {
      const body = z.strictObject({ a: z.string() });
      const document = build({
        requestSchemas: { Body: body },
        operations: [
          operation({
            method: 'post',
            requestBody: { required: false, schema: body },
          }),
        ],
      });

      expect(operationOf(document, '/things', 'post').requestBody).toEqual({
        required: false,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } },
      });
    });

    it('refers to the component of the side that reads the schema, when it has a name on each side', () => {
      const thing = z.object({ name: z.string() });
      const document = build({
        requestSchemas: { CreateThing: thing },
        responseSchemas: { Thing: thing },
        operations: [
          operation({
            method: 'post',
            requestBody: { required: true, schema: thing },
            responses: { 201: { description: 'made', schema: thing } },
          }),
        ],
      });
      const post = operationOf(document, '/things', 'post');

      expect(post.requestBody.content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/CreateThing',
      });
      expect(post.responses['201'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/Thing',
      });
    });

    it('writes a schema in place when its name is only on the other side', () => {
      const thing = z.object({ name: z.string() });
      const document = build({
        requestSchemas: { CreateThing: thing },
        operations: [operation({ responses: { 200: { description: 'ok', schema: thing } } })],
      });

      expect(
        operationOf(document, '/things', 'get').responses['200'].content['application/json'].schema,
      ).toEqual({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      });
    });

    it('gives a response with no schema no content, like a 204', () => {
      const document = build({
        operations: [operation({ method: 'delete', responses: { 204: { description: 'gone' } } })],
      });

      expect(operationOf(document, '/things', 'delete').responses['204']).toEqual({
        description: 'gone',
      });
    });

    it('writes response headers, by reference or in place', () => {
      const document = build({
        headers: { Location: { description: 'Where.', required: true, schema: z.string() } },
        operations: [
          operation({
            responses: {
              201: {
                description: 'made',
                headers: {
                  Location: headerRef('Location'),
                  'X-Own': { description: 'own', schema: z.string() },
                },
              },
            },
          }),
        ],
      });
      const response = operationOf(document, '/things', 'get').responses['201'];

      expect(response.headers.Location).toEqual({ $ref: '#/components/headers/Location' });
      expect(response.headers['X-Own']).toEqual({
        description: 'own',
        required: false,
        schema: { type: 'string' },
      });
      expect(document.components.headers.Location).toMatchObject({ required: true });
    });
  });

  describe('operations', () => {
    it('refuses two operations with the same operationId', () => {
      expect(() =>
        build({
          operations: [operation(), operation({ path: '/other' })],
        }),
      ).toThrow('Duplicate operationId: listThings');
    });

    it('refuses two operations on the same method and path', () => {
      expect(() =>
        build({
          operations: [operation(), operation({ operationId: 'again' })],
        }),
      ).toThrow('Duplicate operation: GET /things');
    });

    it('allows several methods on one path', () => {
      const document = build({
        operations: [operation(), operation({ method: 'post', operationId: 'createThing' })],
      });

      expect(Object.keys(document.paths['/things'] ?? {})).toEqual(['get', 'post']);
    });
  });

  it('gives the same document when it is built twice, because it keeps no state', () => {
    const modules: IOpenApiModule[] = [
      {
        responseSchemas: { Thing: z.object({ id: z.string() }) },
        operations: [operation()],
      },
    ];

    expect(build(...modules)).toEqual(build(...modules));
  });
});
