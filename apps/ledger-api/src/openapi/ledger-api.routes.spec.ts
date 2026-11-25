import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'reflect-metadata';
import { Controller, Delete, Get, Post, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { buildLedgerOpenApiDocument } from './ledger-api.oas.js';

/**
 * Routes that exist on purpose without a description in `openapi.json`, as
 * `'METHOD /path'` in OpenAPI style (`'GET /things/{id}'`). It lets a new route
 * be tried before it is described. The test below fails when an entry is
 * documented or is not a route any more, so the list cannot grow stale.
 *
 * It is empty: every route is described.
 */
const UNDOCUMENTED_ROUTES: string[] = [];

interface IRoute {
  key: string;
  /** The status of a success: the one of `@HttpCode`, else 201 for POST and 200 for the rest. */
  successStatus: number;
}

const SRC = new URL('..', import.meta.url);

/** The paths a Nest decorator stands for: a text is one path, and a list is one path per element. */
function pathsOf(path: string | string[] | undefined): string[] {
  const paths = Array.isArray(path) ? path : [path ?? ''];
  return paths.length > 0 ? paths : [''];
}

/** `'v1'` and `':id'` make `/v1/{id}`: no empty segments, and `:name` is written `{name}`. */
function normalize(prefix: string, path: string): string {
  const segments = [prefix, path]
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment !== '')
    .map((segment) => segment.replace(/^:(\w+)$/, '{$1}'));
  return `/${segments.join('/')}`;
}

/**
 * The routes of one controller class, read from its Nest decorators. A path
 * given as a list stands for every element of it, so each prefix and path
 * pair is a route.
 */
function readControllerRoutes(controller: Function): IRoute[] {
  const prefixes = pathsOf(Reflect.getMetadata(PATH_METADATA, controller) as string | string[]);
  const routes: IRoute[] = [];
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    const handler = controller.prototype[name] as unknown;
    if (typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) {
      continue;
    }
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
    const paths = pathsOf(Reflect.getMetadata(PATH_METADATA, handler) as string | string[]);
    const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
    for (const prefix of prefixes) {
      for (const path of paths) {
        routes.push({
          key: `${RequestMethod[method]} ${normalize(prefix, path)}`,
          successStatus: httpCode ?? (method === RequestMethod.POST ? 201 : 200),
        });
      }
    }
  }
  return routes;
}

/** Finds every controller under `src/` and reads its routes from the Nest decorators, with no app and no database. */
async function readRoutes(): Promise<IRoute[]> {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.controller.ts'),
  );
  const routes: IRoute[] = [];
  for (const file of files) {
    const module = (await import(pathToFileURL(join(fileURLToPath(SRC), file)).href)) as Record<
      string,
      unknown
    >;
    for (const exported of Object.values(module)) {
      if (typeof exported !== 'function' || !Reflect.hasMetadata(PATH_METADATA, exported)) {
        continue;
      }
      routes.push(...readControllerRoutes(exported));
    }
  }
  return routes;
}

describe('readControllerRoutes', () => {
  it('keeps every element of a controller path and of a route path', () => {
    @Controller(['v1', 'v2'])
    class ThingsController {
      @Get(['things', 'items/:id'])
      read() {}

      @Post()
      create() {}

      @Delete(':id')
      remove() {}
    }

    expect(
      readControllerRoutes(ThingsController)
        .map((route) => route.key)
        .sort(),
    ).toEqual(
      [
        'DELETE /v1/{id}',
        'DELETE /v2/{id}',
        'GET /v1/items/{id}',
        'GET /v1/things',
        'GET /v2/items/{id}',
        'GET /v2/things',
        'POST /v1',
        'POST /v2',
      ].sort(),
    );
  });

  it('reads a text path as one route', () => {
    @Controller('things')
    class ThingsController {
      @Get(':id')
      read() {}
    }

    expect(readControllerRoutes(ThingsController).map((route) => route.key)).toEqual([
      'GET /things/{id}',
    ]);
  });
});

describe('routes and openapi.json', async () => {
  const routes = await readRoutes();
  const document = buildLedgerOpenApiDocument('0.0.0');
  const documented = new Map<string, Record<string, unknown>>(
    Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item).map(
        ([method, operation]) =>
          [`${method.toUpperCase()} ${path}`, operation as Record<string, unknown>] as const,
      ),
    ),
  );
  const routeKeys = routes.map((route) => route.key);

  it('finds the routes of the controllers', () => {
    expect(routeKeys).toContain('GET /health');
    expect(routeKeys).toContain('POST /ledgers/{ledgerName}/transactions/{transactionId}/revert');
    expect(routes.length).toBeGreaterThan(0);
  });

  it('describes every route, unless it is on the list of routes left out on purpose', () => {
    const missing = routeKeys.filter(
      (key) => !documented.has(key) && !UNDOCUMENTED_ROUTES.includes(key),
    );

    expect(missing, 'add these to an *.oas.ts file').toEqual([]);
  });

  it('describes only routes that exist', () => {
    const unknown = [...documented.keys()].filter((key) => !routeKeys.includes(key));

    expect(unknown, 'these are in openapi.json, but no controller has them').toEqual([]);
  });

  it('keeps the list of left-out routes honest', () => {
    for (const key of UNDOCUMENTED_ROUTES) {
      expect(routeKeys, `${key} is not a route any more`).toContain(key);
      expect(documented.has(key), `${key} is described now: remove it from the list`).toBe(false);
    }
  });

  it('describes the success status that the route really answers with', () => {
    for (const route of routes.filter((r) => documented.has(r.key))) {
      const responses = documented.get(route.key)?.responses as Record<string, unknown>;

      expect(Object.keys(responses), route.key).toContain(String(route.successStatus));
    }
  });
});
