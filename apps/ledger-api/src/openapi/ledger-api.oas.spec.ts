import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { ORGANIZATION_ID_HEADER } from '../core/tenant/tenant.guard.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
} from '../idempotency/presentation/constants/idempotency-header.constant.js';
import { buildLedgerOpenApiDocument, serializeOpenApiDocument } from './ledger-api.oas.js';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };
const document = buildLedgerOpenApiDocument(version);

type Json = Record<string, any>;
const operations = Object.entries(document.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, operation]) => ({
    path,
    method,
    operation: operation as Json,
    label: `${method.toUpperCase()} ${path}`,
  })),
);

/** Follows a local `$ref` like `#/components/parameters/OrganizationId`. */
function resolveRef(ref: string): unknown {
  expect(ref.startsWith('#/'), `only local references are expected: ${ref}`).toBe(true);
  return ref
    .slice(2)
    .split('/')
    .reduce<any>((node, key) => node?.[key], document);
}

function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectRefs(child, found));
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      if (key === '$ref' && typeof child === 'string') {
        found.push(child);
      } else {
        collectRefs(child, found);
      }
    }
  }
  return found;
}

describe('the OpenAPI document of the ledger API', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const validator = new Validator();

    // What is checked is the JSON text, which is what clients read.
    const result = await validator.validate(JSON.parse(serializeOpenApiDocument(document)));

    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('is the same as apps/ledger-api/openapi.json (run `pnpm openapi:generate` after a change)', () => {
    const committed = readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8');

    expect(
      committed === serializeOpenApiDocument(document),
      'openapi.json is out of date: run `pnpm openapi:generate` and commit the result',
    ).toBe(true);
  });

  it('has the version of the package', () => {
    expect(document.info.version).toBe(version);
  });

  it('names the headers that the code really reads and sets (HTTP names have no case)', () => {
    const parameters = document.components.parameters as Record<string, { name: string }>;
    const headers = Object.keys(document.components.headers);

    expect(parameters.OrganizationId?.name.toLowerCase()).toBe(ORGANIZATION_ID_HEADER);
    expect(parameters.IdempotencyKey?.name.toLowerCase()).toBe(IDEMPOTENCY_KEY_HEADER);
    expect(headers.map((name) => name.toLowerCase())).toContain('location');
    const replayed = operations
      .flatMap(({ operation }) => Object.values(operation.responses as Json))
      .flatMap((response) => Object.keys((response as Json).headers ?? {}));
    expect(replayed.map((name) => name.toLowerCase())).toContain(IDEMPOTENT_REPLAYED_HEADER);
  });

  it('has no $ref that points at nothing', () => {
    const refs = collectRefs(document);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(resolveRef(ref), `${ref} does not exist`).toBeDefined();
    }
  });

  it('has no unused named part, so a leftover is noticed', () => {
    const used = new Set(collectRefs(document));
    const unused = ['schemas', 'parameters', 'headers'].flatMap((kind) =>
      Object.keys((document.components as Json)[kind]).filter(
        (name) => !used.has(`#/components/${kind}/${name}`),
      ),
    );

    expect(unused).toEqual([]);
  });

  describe.each(operations)('$label', ({ path, operation }) => {
    const parameters = (operation.parameters ?? []).map(
      (parameter: Json) => (parameter.$ref ? resolveRef(parameter.$ref) : parameter) as Json,
    );

    it('uses a tag that the document declares', () => {
      expect(document.tags.map((tag) => tag.name)).toContain(operation.tags[0]);
    });

    it('declares exactly the path parameters that its path has', () => {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      const declared = parameters
        .filter((parameter: Json) => parameter.in === 'path')
        .map((parameter: Json) => parameter.name);

      expect(new Set(declared)).toEqual(new Set(inPath));
      for (const parameter of parameters.filter((p: Json) => p.in === 'path')) {
        expect(parameter.required).toBe(true);
      }
    });

    it('needs the X-Organization-Id header, unless it is the health check', () => {
      const names = parameters.map((parameter: Json) => parameter.name);

      expect(names.includes('X-Organization-Id')).toBe(path !== '/health');
    });

    it('answers every error with the shared error body', () => {
      const errors = Object.entries(operation.responses).filter(
        ([status]) => Number(status) >= 400,
      );

      for (const [status, response] of errors) {
        expect(
          (response as Json).content?.['application/json']?.schema,
          `${status} has no error body`,
        ).toEqual({ $ref: '#/components/schemas/ErrorResponse' });
      }
    });

    it('says where the new thing is when it creates one', () => {
      const created = operation.responses['201'];

      if (created) {
        expect(created.headers?.Location).toEqual({ $ref: '#/components/headers/Location' });
      }
    });
  });

  it('does not let a body for metadata be empty, as the controller does not', () => {
    expect(document.components.schemas.SaveMetadataRequest).toMatchObject({
      type: 'object',
      minProperties: 1,
    });
  });

  it('accepts a body that the controller accepts, and refuses one it refuses', () => {
    const create = document.components.schemas.CreateTransactionRequest as Json;

    expect(create.required).toEqual(['postings']);
    expect(create.additionalProperties).toBe(false);
    expect(create.properties.postings).toMatchObject({ minItems: 1, maxItems: 100 });
  });

  it('describes a response with every field the controller sends', () => {
    const transaction = document.components.schemas.Transaction as Json;

    expect(Object.keys(transaction.properties).sort()).toEqual(
      [
        'createdAt',
        'id',
        'metadata',
        'postedAt',
        'postings',
        'reference',
        'revertedAt',
        'revertedByTransactionId',
      ].sort(),
    );
    expect(transaction.required.sort()).toEqual(Object.keys(transaction.properties).sort());
  });
});
